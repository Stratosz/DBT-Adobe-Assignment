import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import {
  IMPORT_TYPES,
  analyzeFile,
  applyDecisions,
  bufferSource,
  diffFields,
  processRecords,
  resolvePolicy,
  type Analysis,
  type CanonicalFieldName,
  type ImportTypeId,
  type RunInput,
  type RunResult,
  type SavedMapping,
} from '@feed/core';
import type { Db, PartnerRow, RunRow } from './db.ts';
import type { Metrics } from './metrics.ts';

/** Errors the API turns into clear JSON responses: what happened, and what to do. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface UploadRequest {
  partnerId: string;
  importType: string;
  filename: string | null;
  bytes: Buffer;
  format?: string | null;
  maxErrorRate?: number | null;
  overrideReason?: string | null;
  force?: boolean;
}

const newRunId = () => `run_${new Date().toISOString().slice(0, 10).replaceAll('-', '')}_${randomUUID().slice(0, 8)}`;

export class RunService {
  /**
   * SQLite has one writer and the pipeline awaits between records, so mutating operations are
   * serialized. Horizontal scale means a queue + workers + Postgres (README, "Scaling").
   */
  private queue: Promise<unknown> = Promise.resolve();
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    private readonly metrics: Metrics,
    private readonly log: FastifyBaseLogger,
  ) {
    mkdirSync(join(dataDir, 'uploads'), { recursive: true });
  }

  private partner(id: string): PartnerRow {
    const p = this.db.getPartner(id);
    if (!p) throw new AppError(404, 'PARTNER_NOT_FOUND', `Unknown partner "${id}"`, 'GET /api/partners lists the configured partners.');
    return p;
  }

  private run(id: string): RunRow {
    const r = this.db.getRun(id);
    if (!r) throw new AppError(404, 'RUN_NOT_FOUND', `Unknown run "${id}"`);
    return r;
  }

  private filePath(runId: string) {
    return join(this.dataDir, 'uploads', `${runId}.bin`);
  }

  private input(run: RunRow, partner: PartnerRow): RunInput {
    const policy = run.policy as { maxErrorRate: number; overridden: boolean; overrideReason: string | null };
    return {
      source: bufferSource(readFileSync(this.filePath(run.id))),
      filename: run.filename,
      format: run.format ?? run.requestedFormat,
      readOptions: partner.readOptions,
      importType: run.importType,
      locale: partner.locale,
      savedMapping: this.db.getSavedMapping(partner.id),
      policyOverride: policy.overridden ? { maxErrorRate: policy.maxErrorRate, reason: policy.overrideReason } : undefined,
    };
  }

  /** Upload -> analyze -> (wait for a human | process). */
  ingest(req: UploadRequest): Promise<RunRow> {
    return this.exclusive(() => this.ingestNow(req));
  }

  private async ingestNow(req: UploadRequest): Promise<RunRow> {
    const partner = this.partner(req.partnerId);
    if (!(req.importType in IMPORT_TYPES)) {
      throw new AppError(400, 'UNKNOWN_IMPORT_TYPE', `Unknown import type "${req.importType}"`, `Use one of: ${Object.keys(IMPORT_TYPES).join(', ')}`);
    }
    let policy;
    try {
      policy = resolvePolicy(req.importType, { maxErrorRate: req.maxErrorRate, reason: req.overrideReason });
    } catch (err) {
      throw new AppError(400, 'INVALID_POLICY_OVERRIDE', (err as Error).message);
    }

    const fileHash = createHash('sha256').update(req.bytes).digest('hex');
    const previous = this.db.findCommittedRunByHash(partner.id, req.importType, fileHash);
    if (previous && !req.force) {
      throw new AppError(409, 'DUPLICATE_FILE', `This exact file was already imported in run ${previous.id}`, 'Re-upload with force=true to import it again.', { runId: previous.id });
    }

    const runId = newRunId();
    const log = this.log.child({ runId, partnerId: partner.id, importType: req.importType });
    writeFileSync(this.filePath(runId), req.bytes);
    this.db.createRun({
      id: runId,
      partnerId: partner.id,
      importType: req.importType,
      filename: req.filename,
      sizeBytes: req.bytes.length,
      fileHash,
      requestedFormat: req.format ?? null,
      policy: { importType: policy.importType.id, maxErrorRate: policy.maxErrorRate, overridden: policy.overridden, overrideReason: policy.overrideReason },
    });
    log.info({ event: 'run.received', filename: req.filename, sizeBytes: req.bytes.length, fileHash: fileHash.slice(0, 12), policy: { maxErrorRate: policy.maxErrorRate, overridden: policy.overridden } }, 'run received');

    const started = performance.now();
    const run = this.run(runId);
    const input = this.input(run, partner);
    const analysis = await analyzeFile(input);
    const drift = this.detectDrift(run, analysis);
    this.db.updateRun(runId, { format: analysis.format, analysis: storedAnalysis(analysis), drift });
    log.info(
      {
        event: 'run.analyzed',
        format: analysis.format,
        detection: analysis.detectionMethod,
        encoding: analysis.encoding,
        fields: analysis.fields.length,
        needsConfirmation: analysis.proposal?.needsConfirmation,
        drift,
      },
      'run analyzed',
    );
    if (drift?.changed) this.metrics.drift.inc({ partner: partner.id, format: analysis.format ?? 'unknown' });

    if (analysis.fatal) return this.fail(runId, partner, analysis, analysis.fatal, started);

    const proposal = analysis.proposal!;
    if (proposal.needsConfirmation) {
      const pending = proposal.matches.filter((m) => m.status === 'needs_confirmation').map((m) => m.sourceField);
      const reason = [
        proposal.missingRequired.length ? `required field(s) without a source column: ${proposal.missingRequired.join(', ')}` : null,
        pending.length ? `${pending.length} field(s) need confirmation: ${pending.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('; ');
      this.db.updateRun(runId, { status: 'AWAITING_MAPPING', statusReason: `Mapping needs a human: ${reason}` });
      log.info({ event: 'run.awaiting_mapping', pending, missingRequired: proposal.missingRequired, conflicts: proposal.conflicts }, 'run waiting for mapping confirmation');
      return this.run(runId);
    }
    return this.process(runId, partner, proposal.mapping, analysis, started);
  }

  /** A human confirms/overrides the mapping for a run that is AWAITING_MAPPING. */
  confirmMapping(runId: string, decisions: SavedMapping, remember = true): Promise<RunRow> {
    return this.exclusive(() => this.confirmMappingNow(runId, decisions, remember));
  }

  private async confirmMappingNow(runId: string, decisions: SavedMapping, remember = true): Promise<RunRow> {
    const run = this.run(runId);
    if (run.status !== 'AWAITING_MAPPING') {
      throw new AppError(409, 'INVALID_STATE', `Run is ${run.status}; mapping can only be confirmed while AWAITING_MAPPING`);
    }
    const partner = this.partner(run.partnerId);
    const analysis = run.analysis as Analysis;
    const importType = IMPORT_TYPES[run.importType as ImportTypeId];
    const { mapping, problems } = applyDecisions(analysis.proposal!, decisions, importType);
    if (problems.length) {
      throw new AppError(422, 'MAPPING_INCOMPLETE', 'The mapping cannot be used yet', 'Resolve the listed problems and submit again.', { problems });
    }
    if (remember) this.db.saveMappingDecisions(partner.id, runId, decisions);
    this.log.info({ event: 'run.mapping_confirmed', runId, partnerId: partner.id, decisions, remembered: remember }, 'mapping confirmed');
    return this.process(runId, partner, mapping, analysis, performance.now());
  }

  approve(runId: string, reason: string): Promise<RunRow> {
    return this.exclusive(() => this.approveNow(runId, reason));
  }

  private async approveNow(runId: string, reason: string): Promise<RunRow> {
    const run = this.run(runId);
    if (run.status !== 'HELD_FOR_REVIEW') throw new AppError(409, 'INVALID_STATE', `Run is ${run.status}; only HELD_FOR_REVIEW runs can be approved`);
    if (!reason?.trim()) throw new AppError(400, 'REASON_REQUIRED', 'Approving a held run needs a reason (stored for audit)');
    const commit = this.db.promote(runId, run.partnerId, run.importType === 'full_catalog');
    this.db.updateRun(runId, { status: 'COMMITTED', statusReason: `Approved after review: ${reason.trim()}`, commit });
    this.log.info({ event: 'run.approved', runId, partnerId: run.partnerId, reason, commit }, 'held run approved and committed');
    return this.run(runId);
  }

  reject(runId: string, reason: string): Promise<RunRow> {
    return this.exclusive(() => this.rejectNow(runId, reason));
  }

  private async rejectNow(runId: string, reason: string): Promise<RunRow> {
    const run = this.run(runId);
    if (run.status !== 'HELD_FOR_REVIEW' && run.status !== 'AWAITING_MAPPING') {
      throw new AppError(409, 'INVALID_STATE', `Run is ${run.status}; only held or waiting runs can be rejected`);
    }
    this.db.clearRunData(runId);
    this.db.updateRun(runId, { status: 'REJECTED', statusReason: `Rejected: ${reason?.trim() || 'no reason given'}` });
    this.log.info({ event: 'run.rejected', runId, partnerId: run.partnerId, reason }, 'run rejected');
    return this.run(runId);
  }

  private detectDrift(run: RunRow, analysis: Analysis) {
    if (!analysis.format || !analysis.proposal) return null;
    const prev = this.db.previousFields(run.partnerId, analysis.format, run.id);
    if (!prev) return { changed: false, firstRun: true };
    const current = analysis.fields.map((f) => f.name);
    const { added, removed } = diffFields(prev.fields, current);
    return { changed: added.length + removed.length > 0, firstRun: false, comparedTo: prev.runId, added, removed };
  }

  private async process(runId: string, partner: PartnerRow, mapping: Record<string, CanonicalFieldName>, analysis: Analysis, started: number): Promise<RunRow> {
    const log = this.log.child({ runId, partnerId: partner.id });
    this.db.updateRun(runId, { status: 'PROCESSING', mapping });
    const run = this.run(runId);
    const writer = this.db.stageWriter(runId);
    let result: RunResult;
    this.db.clearRunData(runId);
    try {
      result = await this.db.transactionAsync(() =>
        processRecords(this.input(run, partner), mapping, {
          accepted: (r) => void writer.stage(r.product, r.presentFields),
          quarantined: (r) => void writer.quarantine(r.location, r.raw, r.issues),
        }, analysis),
      );
    } catch (err) {
      log.error({ event: 'run.crashed', err }, 'run crashed');
      this.db.updateRun(runId, { status: 'FAILED', statusReason: `Internal error: ${(err as Error).message}` });
      throw err;
    }

    const format = analysis.format ?? 'unknown';
    this.metrics.records.inc({ partner: partner.id, format, outcome: 'accepted' }, result.counts.accepted);
    this.metrics.records.inc({ partner: partner.id, format, outcome: 'quarantined' }, result.counts.quarantined);
    for (const g of result.issueGroups) this.metrics.issues.inc({ partner: partner.id, code: g.code, severity: g.severity }, g.count);

    let commit = null;
    if (result.status === 'COMMITTED') {
      commit = this.db.promote(runId, partner.id, run.importType === 'full_catalog');
    } else if (result.status === 'FAILED') {
      this.db.clearRunData(runId);
    }
    this.db.updateRun(runId, { status: result.status, statusReason: result.decisionReason, result, fatal: result.fatal, commit });
    this.finishMetrics(partner, run.importType, format, result.status, started);
    log[result.status === 'COMMITTED' ? 'info' : 'warn'](
      {
        event: 'run.processed',
        status: result.status,
        counts: result.counts,
        errorRate: result.errorRate,
        maxErrorRate: result.maxErrorRate,
        durationMs: result.durationMs,
        recordsPerSecond: result.recordsPerSecond,
        topIssues: result.issueGroups.slice(0, 5).map((g) => `${g.code}x${g.count}`),
        commit,
      },
      `run ${result.status.toLowerCase()}`,
    );
    return this.run(runId);
  }

  private fail(runId: string, partner: PartnerRow, analysis: Analysis, fatal: NonNullable<Analysis['fatal']>, started: number): RunRow {
    this.db.updateRun(runId, { status: 'FAILED', statusReason: fatal.message, fatal });
    this.finishMetrics(partner, this.run(runId).importType, analysis.format ?? 'unknown', 'FAILED', started);
    this.log.warn({ event: 'run.failed', runId, partnerId: partner.id, code: fatal.code, message: fatal.message }, 'run failed');
    return this.run(runId);
  }

  private finishMetrics(partner: PartnerRow, importType: string, format: string, status: string, started: number) {
    this.metrics.runs.inc({ partner: partner.id, import_type: importType, format, status });
    this.metrics.duration.observe({ format }, (performance.now() - started) / 1000);
  }
}

/** What we keep from the analysis: enough to render the mapping UI and detect drift. */
function storedAnalysis(a: Analysis) {
  return {
    format: a.format,
    detectionMethod: a.detectionMethod,
    formatScores: a.formatScores,
    encoding: a.encoding,
    fields: a.fields.map((f) => ({ name: f.name, samples: f.samples.slice(0, 5) })),
    proposal: a.proposal,
    fatal: a.fatal,
    policy: a.policy,
  };
}
