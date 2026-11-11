import { DatabaseSync } from 'node:sqlite';
import type { CanonicalFieldName, NormalizedProduct, PartnerLocale, ReadOptions, SavedMapping } from '@feed/core';

/**
 * SQLite via Node's built-in driver: zero native dependencies, one file, transactional.
 * Good enough for a single-node demo; the schema maps 1:1 onto Postgres (see README, scaling).
 *
 * Accepted records go to `staged_products` first and are only promoted into `products`
 * when the run is COMMITTED (automatically, or by a human approving a held run). That is what
 * makes "held for review" safe: a bad file never touches the live catalog.
 */
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS partners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  locale_json TEXT NOT NULL,
  read_options_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS partner_mappings (
  partner_id TEXT NOT NULL REFERENCES partners(id),
  source_field TEXT NOT NULL,
  target TEXT,                       -- NULL = deliberately ignored
  decided_at TEXT NOT NULL,
  decided_in_run TEXT,
  PRIMARY KEY (partner_id, source_field)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(id),
  import_type TEXT NOT NULL,
  filename TEXT,
  size_bytes INTEGER,
  file_hash TEXT NOT NULL,
  requested_format TEXT,
  format TEXT,
  status TEXT NOT NULL,
  status_reason TEXT,
  policy_json TEXT,
  analysis_json TEXT,
  drift_json TEXT,
  mapping_json TEXT,
  result_json TEXT,
  fatal_json TEXT,
  commit_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_partner_created ON runs(partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS runs_hash ON runs(partner_id, file_hash);

CREATE TABLE IF NOT EXISTS staged_products (
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  sku TEXT NOT NULL,
  product_json TEXT NOT NULL,
  present_fields_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS quarantine (
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  location_json TEXT NOT NULL,
  raw_json TEXT,
  issues_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS products (
  partner_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  name TEXT, price REAL, currency TEXT, quantity INTEGER, availability TEXT,
  gtin TEXT, brand TEXT, category TEXT, url TEXT, updated_at TEXT,
  last_run_id TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (partner_id, sku)
);
`;

export interface PartnerRow {
  id: string;
  name: string;
  description: string | null;
  locale: PartnerLocale;
  readOptions: ReadOptions;
}

/**
 * RECEIVED: queued for analysis. QUEUED: mapping settled, queued for processing.
 * PROCESSING: a worker owns it. AWAITING_MAPPING / HELD_FOR_REVIEW: waiting for a person.
 */
export type RunStatus = 'RECEIVED' | 'AWAITING_MAPPING' | 'QUEUED' | 'PROCESSING' | 'COMMITTED' | 'HELD_FOR_REVIEW' | 'REJECTED' | 'FAILED';

export interface RunRow {
  id: string;
  partnerId: string;
  importType: string;
  filename: string | null;
  sizeBytes: number;
  fileHash: string;
  requestedFormat: string | null;
  format: string | null;
  status: RunStatus;
  statusReason: string | null;
  policy: unknown;
  analysis: unknown;
  drift: unknown;
  mapping: Record<string, CanonicalFieldName> | null;
  result: unknown;
  fatal: unknown;
  commit: unknown;
  createdBy: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : null);
const now = () => new Date().toISOString();

const PRODUCT_COLUMNS = ['name', 'price', 'currency', 'quantity', 'availability', 'gtin', 'brand', 'category', 'url', 'updated_at'] as const;

export class Db {
  readonly sqlite: DatabaseSync;

  constructor(path: string) {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  /**
   * Forward-only migrations tracked in PRAGMA user_version. Each runs once, in a transaction.
   * v1 is the MVP schema (IF NOT EXISTS, so MVP databases upgrade in place).
   */
  private migrate(): void {
    const migrations: string[] = [
      SCHEMA_V1,
      // v2 (feedback round 1): who did what
      `CREATE TABLE IF NOT EXISTS audit_events (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         at TEXT NOT NULL,
         actor_id TEXT NOT NULL,
         actor_role TEXT NOT NULL,
         action TEXT NOT NULL,
         run_id TEXT,
         partner_id TEXT,
         details_json TEXT
       );
       CREATE INDEX IF NOT EXISTS audit_run ON audit_events(run_id);
       CREATE INDEX IF NOT EXISTS audit_partner ON audit_events(partner_id, at DESC);
       ALTER TABLE runs ADD COLUMN created_by TEXT;
       ALTER TABLE partner_mappings ADD COLUMN decided_by TEXT;`,
      // v3: worker bookkeeping for async processing
      `ALTER TABLE runs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
       CREATE INDEX IF NOT EXISTS runs_status_created ON runs(status, created_at);`,
    ];
    const current = Number(this.sqlite.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    migrations.forEach((sql, i) => {
      const version = i + 1;
      if (version <= current) return;
      this.transaction(() => {
        this.sqlite.exec(sql);
        this.sqlite.exec(`PRAGMA user_version = ${version}`);
      });
    });
  }

  schemaVersion(): number {
    return Number(this.sqlite.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  }

  // ---- audit ------------------------------------------------------------------------------
  audit(actor: { id: string; role: string }, action: string, ctx: { runId?: string | null; partnerId?: string | null; details?: unknown } = {}): void {
    this.sqlite
      .prepare('INSERT INTO audit_events (at, actor_id, actor_role, action, run_id, partner_id, details_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(now(), actor.id, actor.role, action, ctx.runId ?? null, ctx.partnerId ?? null, json(ctx.details));
  }

  listAudit(filter: { runId?: string; partnerId?: string; limit?: number } = {}) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.runId) {
      where.push('run_id = ?');
      args.push(filter.runId);
    }
    if (filter.partnerId) {
      where.push('partner_id = ?');
      args.push(filter.partnerId);
    }
    args.push(Math.min(filter.limit ?? 100, 500));
    return this.sqlite
      .prepare(`SELECT id, at, actor_id AS actorId, actor_role AS actorRole, action, run_id AS runId, partner_id AS partnerId, details_json FROM audit_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
      .all(...args)
      .map(({ details_json, ...rest }) => ({ ...rest, details: parse(details_json) }));
  }

  /** Async variant for streaming work. Callers must serialize (see RunService lock). */
  async transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.sqlite.exec('BEGIN');
    try {
      const out = await fn();
      this.sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  transaction<T>(fn: () => T): T {
    this.sqlite.exec('BEGIN');
    try {
      const out = fn();
      this.sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- partners ---------------------------------------------------------------------------
  upsertPartner(p: PartnerRow): void {
    this.sqlite
      .prepare(
        `INSERT INTO partners (id, name, description, locale_json, read_options_json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
           locale_json = excluded.locale_json, read_options_json = excluded.read_options_json`,
      )
      .run(p.id, p.name, p.description, JSON.stringify(p.locale), JSON.stringify(p.readOptions));
  }

  listPartners(): PartnerRow[] {
    return this.sqlite.prepare('SELECT * FROM partners ORDER BY name').all().map(toPartner);
  }

  getPartner(id: string): PartnerRow | null {
    const row = this.sqlite.prepare('SELECT * FROM partners WHERE id = ?').get(id);
    return row ? toPartner(row) : null;
  }

  getSavedMapping(partnerId: string): SavedMapping {
    const rows = this.sqlite.prepare('SELECT source_field, target FROM partner_mappings WHERE partner_id = ?').all(partnerId);
    return Object.fromEntries(rows.map((r) => [r.source_field as string, (r.target as CanonicalFieldName | null) ?? null]));
  }

  listMappings(partnerId: string) {
    return this.sqlite
      .prepare(
        'SELECT source_field AS sourceField, target, decided_at AS decidedAt, decided_in_run AS decidedInRun, decided_by AS decidedBy FROM partner_mappings WHERE partner_id = ? ORDER BY source_field',
      )
      .all(partnerId);
  }

  getMapping(partnerId: string, sourceField: string) {
    return this.sqlite.prepare('SELECT source_field AS sourceField, target FROM partner_mappings WHERE partner_id = ? AND source_field = ?').get(partnerId, sourceField) ?? null;
  }

  saveMappingDecisions(partnerId: string, runId: string | null, decisions: SavedMapping, decidedBy: string): void {
    const stmt = this.sqlite.prepare(
      `INSERT INTO partner_mappings (partner_id, source_field, target, decided_at, decided_in_run, decided_by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(partner_id, source_field) DO UPDATE SET target = excluded.target, decided_at = excluded.decided_at,
         decided_in_run = excluded.decided_in_run, decided_by = excluded.decided_by`,
    );
    const at = now();
    this.transaction(() => {
      for (const [source, target] of Object.entries(decisions)) stmt.run(partnerId, source, target ?? null, at, runId, decidedBy);
    });
  }

  deleteMapping(partnerId: string, sourceField: string): boolean {
    return Number(this.sqlite.prepare('DELETE FROM partner_mappings WHERE partner_id = ? AND source_field = ?').run(partnerId, sourceField).changes) > 0;
  }

  /** Live catalog values used by the stale-record and price-swing guards. */
  catalogLookup(partnerId: string) {
    const stmt = this.sqlite.prepare('SELECT price, currency, updated_at FROM products WHERE partner_id = ? AND sku = ?');
    return (sku: string) => {
      const row = stmt.get(partnerId, sku);
      return row ? { price: (row.price as number | null) ?? null, currency: (row.currency as string | null) ?? null, updated_at: (row.updated_at as string | null) ?? null } : null;
    };
  }

  // ---- runs -------------------------------------------------------------------------------
  createRun(r: Pick<RunRow, 'id' | 'partnerId' | 'importType' | 'filename' | 'sizeBytes' | 'fileHash' | 'requestedFormat' | 'policy' | 'createdBy'>): void {
    const at = now();
    this.sqlite
      .prepare(
        `INSERT INTO runs (id, partner_id, import_type, filename, size_bytes, file_hash, requested_format, status, policy_json, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?, ?, ?)`,
      )
      .run(r.id, r.partnerId, r.importType, r.filename, r.sizeBytes, r.fileHash, r.requestedFormat, json(r.policy), r.createdBy, at, at);
  }

  updateRun(id: string, patch: Partial<Omit<RunRow, 'id' | 'createdAt' | 'updatedAt'>>): void {
    const columns: Record<string, string> = {
      format: 'format', status: 'status', statusReason: 'status_reason', policy: 'policy_json', analysis: 'analysis_json',
      drift: 'drift_json', mapping: 'mapping_json', result: 'result_json', fatal: 'fatal_json', commit: 'commit_json',
    };
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const col = columns[key];
      if (!col) continue;
      sets.push(`${col} = ?`);
      values.push(col.endsWith('_json') ? json(value) : (value as string | null));
    }
    sets.push('updated_at = ?');
    values.push(now());
    this.sqlite.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }

  getRun(id: string): RunRow | null {
    const row = this.sqlite.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return row ? toRun(row) : null;
  }

  listRuns(filter: { partnerId?: string; limit?: number } = {}): RunRow[] {
    const limit = Math.min(filter.limit ?? 50, 200);
    const rows = filter.partnerId
      ? this.sqlite.prepare('SELECT * FROM runs WHERE partner_id = ? ORDER BY created_at DESC LIMIT ?').all(filter.partnerId, limit)
      : this.sqlite.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?').all(limit);
    return rows.map(toRun);
  }

  findCommittedRunByHash(partnerId: string, importType: string, hash: string): RunRow | null {
    const row = this.sqlite
      .prepare(`SELECT * FROM runs WHERE partner_id = ? AND import_type = ? AND file_hash = ? AND status = 'COMMITTED' ORDER BY created_at DESC LIMIT 1`)
      .get(partnerId, importType, hash);
    return row ? toRun(row) : null;
  }

  /** Field list of the previous analyzed run for this partner + format, for drift detection. */
  previousFields(partnerId: string, format: string, excludeRunId: string): { runId: string; fields: string[]; fingerprint: string } | null {
    const row = this.sqlite
      .prepare(`SELECT id, analysis_json FROM runs WHERE partner_id = ? AND format = ? AND id != ? AND analysis_json IS NOT NULL ORDER BY created_at DESC LIMIT 1`)
      .get(partnerId, format, excludeRunId);
    if (!row) return null;
    const analysis = parse(row.analysis_json) as { fields?: { name: string }[]; proposal?: { fingerprint: string } } | null;
    if (!analysis?.fields) return null;
    return { runId: row.id as string, fields: analysis.fields.map((f) => f.name), fingerprint: analysis.proposal?.fingerprint ?? '' };
  }

  listRunsByStatus(statuses: RunStatus[]): RunRow[] {
    return this.sqlite
      .prepare(`SELECT * FROM runs WHERE status IN (${statuses.map(() => '?').join(', ')}) ORDER BY created_at`)
      .all(...statuses)
      .map(toRun);
  }

  hasQueuedRuns(): boolean {
    return !!this.sqlite.prepare(`SELECT 1 FROM runs WHERE status IN ('RECEIVED', 'QUEUED') LIMIT 1`).get();
  }

  /**
   * Atomically claim the oldest queued run (UPDATE ... RETURNING), so the same statement works
   * when several workers share a database. Oldest-first keeps each supplier's files in order.
   */
  claimNextRun(): RunRow | null {
    const row = this.sqlite
      .prepare(
        `UPDATE runs SET status = 'PROCESSING', attempts = attempts + 1, updated_at = ?
         WHERE id = (SELECT id FROM runs WHERE status IN ('RECEIVED', 'QUEUED') ORDER BY created_at, rowid LIMIT 1)
         RETURNING *`,
      )
      .get(now());
    return row ? toRun(row) : null;
  }

  countByStatus(): Record<string, number> {
    const rows = this.sqlite.prepare('SELECT status, COUNT(*) AS n FROM runs GROUP BY status').all();
    return Object.fromEntries(rows.map((r) => [r.status as string, Number(r.n)]));
  }

  // ---- staging / quarantine -----------------------------------------------------------------
  stageWriter(runId: string) {
    const staged = this.sqlite.prepare('INSERT INTO staged_products (run_id, seq, sku, product_json, present_fields_json) VALUES (?, ?, ?, ?, ?)');
    const quarantined = this.sqlite.prepare('INSERT INTO quarantine (run_id, seq, location_json, raw_json, issues_json) VALUES (?, ?, ?, ?, ?)');
    let seq = 0;
    return {
      stage: (product: NormalizedProduct, presentFields: string[]) => staged.run(runId, seq++, product.sku, JSON.stringify(product), JSON.stringify(presentFields)),
      quarantine: (location: unknown, raw: unknown, issues: unknown) => quarantined.run(runId, seq++, JSON.stringify(location), json(raw), JSON.stringify(issues)),
    };
  }

  clearRunData(runId: string): void {
    this.sqlite.prepare('DELETE FROM staged_products WHERE run_id = ?').run(runId);
    this.sqlite.prepare('DELETE FROM quarantine WHERE run_id = ?').run(runId);
  }

  /** Page through quarantined records by seq so downloads stream with bounded memory. */
  *iterateQuarantine(runId: string, pageSize = 1000): Generator<{ location: unknown; raw: unknown; issues: unknown }> {
    const stmt = this.sqlite.prepare('SELECT seq, location_json, raw_json, issues_json FROM quarantine WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?');
    let after = -1;
    for (;;) {
      const rows = stmt.all(runId, after, pageSize);
      if (!rows.length) return;
      for (const r of rows) yield { location: parse(r.location_json), raw: parse(r.raw_json), issues: parse(r.issues_json) };
      after = Number(rows.at(-1)!.seq);
    }
  }

  quarantinedRecords(runId: string, limit = 100_000) {
    return this.sqlite
      .prepare('SELECT location_json, raw_json, issues_json FROM quarantine WHERE run_id = ? ORDER BY seq LIMIT ?')
      .all(runId, limit)
      .map((r) => ({ location: parse(r.location_json), raw: parse(r.raw_json), issues: parse(r.issues_json) }));
  }

  /**
   * Promote staged rows into the live catalog. Only the fields the record actually carried
   * (and the import type may write) are touched, so a price update never blanks a name.
   * Update-only import types do not create products for unknown SKUs; they count them.
   */
  promote(runId: string, partnerId: string, createMissing: boolean): { inserted: number; updated: number; unknownSkus: number; skippedStale: number } {
    const rows = this.sqlite.prepare('SELECT product_json, present_fields_json FROM staged_products WHERE run_id = ? ORDER BY seq').all(runId);
    const exists = this.sqlite.prepare('SELECT updated_at FROM products WHERE partner_id = ? AND sku = ?');
    const stats = { inserted: 0, updated: 0, unknownSkus: 0, skippedStale: 0 };
    const at = now();
    this.transaction(() => {
      for (const row of rows) {
        const product = JSON.parse(row.product_json as string) as NormalizedProduct;
        const present = (JSON.parse(row.present_fields_json as string) as string[]).filter((f) => (PRODUCT_COLUMNS as readonly string[]).includes(f));
        const found = exists.get(partnerId, product.sku);
        if (!found && !createMissing) {
          stats.unknownSkus++;
          continue;
        }
        // Re-check staleness at commit time: a held run approved days later must not overwrite
        // data that a newer run committed in the meantime (feedback round 1, #2).
        const currentTs = found?.updated_at as string | null | undefined;
        if (currentTs && product.updated_at && product.updated_at < currentTs) {
          stats.skippedStale++;
          continue;
        }
        const values = present.map((f) => (product as Record<string, unknown>)[f] as string | number | null);
        if (found) {
          if (present.length) {
            this.sqlite
              .prepare(`UPDATE products SET ${present.map((f) => `${f} = ?`).join(', ')}, last_run_id = ?, ingested_at = ? WHERE partner_id = ? AND sku = ?`)
              .run(...values, runId, at, partnerId, product.sku);
          }
          stats.updated++;
        } else {
          const cols = ['partner_id', 'sku', ...present, 'last_run_id', 'ingested_at'];
          this.sqlite
            .prepare(`INSERT INTO products (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
            .run(partnerId, product.sku, ...values, runId, at);
          stats.inserted++;
        }
      }
      this.sqlite.prepare('DELETE FROM staged_products WHERE run_id = ?').run(runId);
    });
    return stats;
  }

  listProducts(partnerId: string, limit = 200) {
    return this.sqlite.prepare('SELECT * FROM products WHERE partner_id = ? ORDER BY sku LIMIT ?').all(partnerId, limit);
  }

  countProducts(partnerId: string): number {
    return Number(this.sqlite.prepare('SELECT COUNT(*) AS n FROM products WHERE partner_id = ?').get(partnerId)?.n ?? 0);
  }
}

function toPartner(row: Record<string, unknown>): PartnerRow {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? null,
    locale: JSON.parse(row.locale_json as string),
    readOptions: JSON.parse((row.read_options_json as string) ?? '{}'),
  };
}

function toRun(row: Record<string, unknown>): RunRow {
  return {
    id: row.id as string,
    partnerId: row.partner_id as string,
    importType: row.import_type as string,
    filename: (row.filename as string) ?? null,
    sizeBytes: Number(row.size_bytes ?? 0),
    fileHash: row.file_hash as string,
    requestedFormat: (row.requested_format as string) ?? null,
    format: (row.format as string) ?? null,
    status: row.status as RunStatus,
    statusReason: (row.status_reason as string) ?? null,
    policy: parse(row.policy_json),
    analysis: parse(row.analysis_json),
    drift: parse(row.drift_json),
    mapping: parse(row.mapping_json),
    result: parse(row.result_json),
    fatal: parse(row.fatal_json),
    commit: parse(row.commit_json),
    createdBy: (row.created_by as string) ?? null,
    attempts: Number(row.attempts ?? 0),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
