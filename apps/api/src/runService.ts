import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyBaseLogger } from 'fastify';
import {
  CANONICAL_FIELDS,
  IMPORT_TYPES,
  analyzeFile,
  applyDecisions,
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
import { atLeast, type Actor } from './auth.ts';
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
  actor: Actor;
  partnerId: string;
  importType: string;
  filename: string | null;
  stream: Readable;
  format?: string | null;
  maxErrorRate?: number | null;
  overrideReason?: string | null;
  force?: boolean;
}

const MAX_ATTEMPTS = 3;
const newRunId = () => `run_${new Date().toISOString().slice(0, 10).replaceAll('-', '')}_${randomUUID().slice(0, 8)}`;

/**
 * Orchestrates runs. Uploads are accepted immediately (202) and processed by a single
 * in-process worker that treats the `runs` table as a durable queue (feedback round 1, #5):
 *
 *   upload -> RECEIVED --worker--> analyze -> AWAITING_MAPPING (person) -> QUEUED --worker--> process
 *                                          `-> process -> COMMITTED | HELD_FOR_REVIEW | FAILED
 *
 * A crash leaves at most one run in PROCESSING; `start()` puts it back on the queue. Processing
 * is idempotent: staging is cleared first and nothing reaches `products` before the commit.
 */
export class RunService {
  private lock: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private wake: (() => void) | null = null;
  private current: Promise<void> | null = null;
  private loopDone: Promise<void> | null = null;
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    private readonly metrics: Metrics,
    private readonly log: FastifyBaseLogger,
  ) {
    mkdirSync(join(dataDir, 'uploads'), { recursive: true });
  }

  /**
   * SQLite has one writer and the pipeline awaits between records, so everything that writes in a
   * transaction runs through this lock. Scale-out = a queue service + Postgres (ADR 6).
   */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  private partner(id: string): PartnerRow {
    const p = this.db.getPartner(id);
    if (!p) throw new AppError(404, 'PARTNER_NOT_FOUND', `Unknown supplier "${id}"`, 'GET /api/partners lists the configured suppliers.');
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
    const path = this.filePath(run.id);
    return {
      source: () => createReadStream(path, { highWaterMark: 256 * 1024 }),
      filename: run.filename,
      format: run.format ?? run.requestedFormat,
      readOptions: partner.readOptions,
      importType: run.importType,
      locale: partner.locale,
      savedMapping: this.db.getSavedMapping(partner.id),
      policyOverride: policy.overridden ? { maxErrorRate: policy.maxErrorRate, reason: policy.overrideReason } : undefined,
      catalog: this.db.catalogLookup(partner.id),
    };
  }

  // ------------------------------------------------------------------------------- commands

  /** Stream the upload to disk while hashing it, then queue it. Returns before any parsing. */
  async receive(req: UploadRequest): Promise<RunRow> {
    const partner = this.partner(req.partnerId);
    if (!(req.importType in IMPORT_TYPES)) {
      throw new AppError(400, 'UNKNOWN_IMPORT_TYPE', `Unknown import type "${req.importType}"`, `Use one of: ${Object.keys(IMPORT_TYPES).join(', ')}`);
    }
    const overriding = req.maxErrorRate !== null && req.maxErrorRate !== undefined;
    if (overriding && !atLeast(req.actor.role, 'reviewer')) {
      throw new AppError(403, 'FORBIDDEN', 'Changing the bad-row limit needs the reviewer role', 'Upload without a limit override, or ask a reviewer.');
    }
    let policy;
    try {
      policy = resolvePolicy(req.importType, { maxErrorRate: req.maxErrorRate, reason: req.overrideReason });
    } catch (err) {
      throw new AppError(400, 'INVALID_POLICY_OVERRIDE', (err as Error).message);
    }

    const tmp = join(this.dataDir, 'uploads', `incoming-${randomUUID()}.part`);
    const hash = createHash('sha256');
    let size = 0;
    try {
      await pipeline(
        req.stream,
        new Transform({
          transform(chunk: Buffer, _enc, cb) {
            hash.update(chunk);
            size += chunk.length;
            cb(null, chunk);
          },
        }),
        createWriteStream(tmp),
      );
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    if ((req.stream as Readable & { truncated?: boolean }).truncated) {
      rmSync(tmp, { force: true });
      throw new AppError(413, 'FILE_TOO_LARGE', 'The file is larger than the upload limit', 'Split the feed, or raise MAX_UPLOAD_MB on the server.');
    }
    if (size === 0) {
      rmSync(tmp, { force: true });
      throw new AppError(400, 'FILE_EMPTY', 'The uploaded file is empty');
    }
    const fileHash = hash.digest('hex');
    const previous = this.db.findCommittedRunByHash(partner.id, req.importType, fileHash);
    if (previous && !req.force) {
      rmSync(tmp, { force: true });
      throw new AppError(409, 'DUPLICATE_FILE', `This exact file was already imported in run ${previous.id}`, 'Re-upload with force=true to import it again.', {
        runId: previous.id,
      });
    }

    const runId = newRunId();
    renameSync(tmp, this.filePath(runId));
    const storedPolicy = {
      importType: policy.importType.id,
      maxErrorRate: policy.maxErrorRate,
      overridden: policy.overridden,
      overrideReason: policy.overrideReason,
    };
    this.db.createRun({
      id: runId,
      partnerId: partner.id,
      importType: req.importType,
      filename: req.filename,
      sizeBytes: size,
      fileHash,
      requestedFormat: req.format ?? null,
      policy: storedPolicy,
      createdBy: req.actor.id,
    });
    this.db.audit(req.actor, 'run.uploaded', {
      runId,
      partnerId: partner.id,
      details: { filename: req.filename, sizeBytes: size, importType: req.importType, forced: !!req.force && !!previous },
    });
    if (policy.overridden)
      this.db.audit(req.actor, 'run.limit_overridden', {
        runId,
        partnerId: partner.id,
        details: { maxErrorRate: policy.maxErrorRate, reason: policy.overrideReason },
      });
    this.log.info(
      { event: 'run.received', runId, partnerId: partner.id, actor: req.actor.id, filename: req.filename, sizeBytes: size, fileHash: fileHash.slice(0, 12) },
      'run received',
    );
    this.kick();
    return this.run(runId);
  }

  /** A person confirms/overrides the mapping for a run that is AWAITING_MAPPING; the run is queued. */
  confirmMapping(runId: string, decisions: SavedMapping, remember: boolean, actor: Actor): Promise<RunRow> {
    return this.exclusive(async () => {
      const run = this.run(runId);
      if (run.status !== 'AWAITING_MAPPING')
        throw new AppError(409, 'INVALID_STATE', `Run is ${run.status}; mapping can only be confirmed while AWAITING_MAPPING`);
      const analysis = run.analysis as Analysis;
      const importType = IMPORT_TYPES[run.importType as ImportTypeId];
      const { mapping, problems } = applyDecisions(analysis.proposal!, decisions, importType);
      if (problems.length)
        throw new AppError(422, 'MAPPING_INCOMPLETE', 'The mapping cannot be used yet', 'Resolve the listed problems and submit again.', { problems });
      if (remember) this.db.saveMappingDecisions(run.partnerId, runId, decisions, actor.id);
      this.db.updateRun(runId, { status: 'QUEUED', statusReason: 'Mapping confirmed; waiting for the worker', mapping });
      this.db.audit(actor, 'run.mapping_confirmed', { runId, partnerId: run.partnerId, details: { decisions, remembered: remember } });
      this.log.info({ event: 'run.mapping_confirmed', runId, partnerId: run.partnerId, actor: actor.id, decisions, remembered: remember }, 'mapping confirmed');
      this.kick();
      return this.run(runId);
    });
  }

  approve(runId: string, reason: string, actor: Actor): Promise<RunRow> {
    return this.exclusive(async () => {
      const run = this.run(runId);
      if (run.status !== 'HELD_FOR_REVIEW') throw new AppError(409, 'INVALID_STATE', `Run is ${run.status}; only HELD_FOR_REVIEW runs can be approved`);
      if (!reason?.trim()) throw new AppError(400, 'REASON_REQUIRED', 'Approving a held run needs a reason (stored in the audit log)');
      if (run.createdBy === actor.id && actor.role !== 'admin') {
        // Four-eyes principle: whoever uploaded a held file should not be the one waving it through.
        throw new AppError(403, 'SELF_APPROVAL', 'You uploaded this file, so someone else has to approve it', 'Ask another reviewer.');
      }
      const commit = this.db.promote(runId, run.partnerId, run.importType === 'full_catalog');
      this.db.updateRun(runId, { status: 'COMMITTED', statusReason: `Approved by ${actor.name}: ${reason.trim()}`, commit });
      this.db.audit(actor, 'run.approved', { runId, partnerId: run.partnerId, details: { reason: reason.trim(), commit } });
      this.log.info({ event: 'run.approved', runId, partnerId: run.partnerId, actor: actor.id, reason, commit }, 'held run approved and committed');
      return this.run(runId);
    });
  }

  reject(runId: string, reason: string, actor: Actor): Promise<RunRow> {
    return this.exclusive(async () => {
      const run = this.run(runId);
      if (run.status !== 'HELD_FOR_REVIEW' && run.status !== 'AWAITING_MAPPING')
        throw new AppError(409, 'INVALID_STATE', `Run is ${run.status}; only held or waiting runs can be rejected`);
      this.db.clearRunData(runId);
      this.db.updateRun(runId, { status: 'REJECTED', statusReason: `Rejected by ${actor.name}: ${reason?.trim() || 'no reason given'}` });
      this.db.audit(actor, 'run.rejected', { runId, partnerId: run.partnerId, details: { reason: reason?.trim() || null } });
      this.log.info({ event: 'run.rejected', runId, partnerId: run.partnerId, actor: actor.id, reason }, 'run rejected');
      return this.run(runId);
    });
  }

  /** Admin: change or forget a saved supplier mapping (feedback round 1, #6). */
  setMapping(partnerId: string, sourceField: string, target: CanonicalFieldName | null, actor: Actor) {
    return this.exclusive(async () => {
      this.partner(partnerId);
      if (target !== null && !(target in CANONICAL_FIELDS)) throw new AppError(400, 'UNKNOWN_FIELD', `"${target}" is not a product field`);
      const before = this.db.getMapping(partnerId, sourceField);
      this.db.saveMappingDecisions(partnerId, null, { [sourceField]: target }, actor.id);
      this.db.audit(actor, 'mapping.updated', { partnerId, details: { sourceField, from: before?.target ?? null, to: target } });
      return this.db.listMappings(partnerId);
    });
  }

  deleteMapping(partnerId: string, sourceField: string, actor: Actor) {
    return this.exclusive(async () => {
      this.partner(partnerId);
      const before = this.db.getMapping(partnerId, sourceField);
      if (!before) throw new AppError(404, 'MAPPING_NOT_FOUND', `No saved mapping for "${sourceField}"`);
      this.db.deleteMapping(partnerId, sourceField);
      this.db.audit(actor, 'mapping.deleted', { partnerId, details: { sourceField, was: before.target ?? null } });
      return this.db.listMappings(partnerId);
    });
  }

  // ------------------------------------------------------------------------------- worker

  /** Recover runs a crash left behind, then start the worker loop. */
  start(): void {
    const stuck = this.db.listRunsByStatus(['PROCESSING']);
    for (const run of stuck) {
      if (run.attempts >= MAX_ATTEMPTS) {
        this.db.clearRunData(run.id);
        this.db.updateRun(run.id, {
          status: 'FAILED',
          statusReason: `Gave up after ${run.attempts} attempts (the service stopped while processing it each time)`,
        });
        this.log.error({ event: 'run.gave_up', runId: run.id, attempts: run.attempts }, 'run failed repeatedly; giving up');
        continue;
      }
      const back = run.mapping ? 'QUEUED' : 'RECEIVED';
      this.db.updateRun(run.id, { status: back, statusReason: 'Re-queued after the service restarted' });
      this.log.warn({ event: 'run.recovered', runId: run.id, requeuedAs: back, attempts: run.attempts }, 'recovered interrupted run');
    }
    this.stopping = false;
    this.loopDone = this.loop();
  }

  /** Stop taking new jobs; wait for the current one (up to timeoutMs). Unfinished work is recovered on next start. */
  async stop(timeoutMs = 25_000): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await Promise.race([this.loopDone, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }

  /** Resolves when the queue is empty and nothing is running (used by tests and the CLI). */
  idle(): Promise<void> {
    if (!this.current && !this.db.hasQueuedRuns()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  kick(): void {
    this.wake?.();
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      const job = this.db.claimNextRun();
      if (!job) {
        this.idleWaiters.splice(0).forEach((r) => r());
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          setTimeout(resolve, 1000).unref(); // also poll, in case another process queued work
        });
        this.wake = null;
        continue;
      }
      this.current = this.exclusive(() => this.work(job));
      await this.current;
      this.current = null;
    }
  }

  private async work(run: RunRow): Promise<void> {
    const started = performance.now();
    const log = this.log.child({ runId: run.id, partnerId: run.partnerId, attempt: run.attempts });
    try {
      const partner = this.partner(run.partnerId);
      let analysis = run.analysis as Analysis | null;
      let mapping = run.mapping;
      if (!mapping) {
        analysis = await analyzeFile(this.input(run, partner));
        const drift = this.detectDrift(run, analysis);
        this.db.updateRun(run.id, { format: analysis.format, analysis: storedAnalysis(analysis), drift });
        if (drift?.changed) this.metrics.drift.inc({ partner: partner.id, format: analysis.format ?? 'unknown' });
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
        if (analysis.fatal) {
          this.db.updateRun(run.id, { status: 'FAILED', statusReason: analysis.fatal.message, fatal: analysis.fatal });
          this.finishMetrics(partner.id, run.importType, analysis.format ?? 'unknown', 'FAILED', started);
          log.warn({ event: 'run.failed', code: analysis.fatal.code, message: analysis.fatal.message }, 'run failed');
          return;
        }
        const proposal = analysis.proposal!;
        if (proposal.needsConfirmation) {
          const pending = proposal.matches.filter((m) => m.status === 'needs_confirmation').map((m) => m.sourceField);
          const reason = [
            proposal.missingRequired.length ? `required field(s) without a source column: ${proposal.missingRequired.join(', ')}` : null,
            pending.length ? `${pending.length} field(s) need confirmation: ${pending.join(', ')}` : null,
          ]
            .filter(Boolean)
            .join('; ');
          this.db.updateRun(run.id, { status: 'AWAITING_MAPPING', statusReason: `Mapping needs a person: ${reason}` });
          log.info({ event: 'run.awaiting_mapping', pending, missingRequired: proposal.missingRequired }, 'run waiting for mapping confirmation');
          return;
        }
        mapping = proposal.mapping;
        this.db.updateRun(run.id, { mapping });
      }
      await this.process(this.run(run.id), partner, mapping, analysis!, started, log);
    } catch (err) {
      log.error({ event: 'run.crashed', err }, 'run crashed');
      this.db.clearRunData(run.id);
      this.db.updateRun(run.id, {
        status: 'FAILED',
        statusReason: `Internal error while processing (${(err as Error).message}). Quote the run id to support.`,
      });
      this.finishMetrics(run.partnerId, run.importType, run.format ?? 'unknown', 'FAILED', started);
    }
  }

  private detectDrift(run: RunRow, analysis: Analysis) {
    if (!analysis.format || !analysis.proposal) return null;
    const prev = this.db.previousFields(run.partnerId, analysis.format, run.id);
    if (!prev) return { changed: false, firstRun: true };
    const { added, removed } = diffFields(
      prev.fields,
      analysis.fields.map((f) => f.name),
    );
    return { changed: added.length + removed.length > 0, firstRun: false, comparedTo: prev.runId, added, removed };
  }

  private async process(
    run: RunRow,
    partner: PartnerRow,
    mapping: Record<string, CanonicalFieldName>,
    analysis: Analysis,
    started: number,
    log: FastifyBaseLogger,
  ): Promise<void> {
    const writer = this.db.stageWriter(run.id);
    this.db.clearRunData(run.id);
    const result: RunResult = await this.db.transactionAsync(() =>
      processRecords(
        this.input(run, partner),
        mapping,
        {
          accepted: (r) => void writer.stage(r.product, r.presentFields),
          quarantined: (r) => void writer.quarantine(r.location, r.raw, r.issues),
        },
        analysis,
      ),
    );

    const format = analysis.format ?? 'unknown';
    this.metrics.records.inc({ partner: partner.id, format, outcome: 'accepted' }, result.counts.accepted);
    this.metrics.records.inc({ partner: partner.id, format, outcome: 'quarantined' }, result.counts.quarantined);
    this.metrics.records.inc({ partner: partner.id, format, outcome: 'skipped_stale' }, result.counts.skippedStale);
    for (const g of result.issueGroups) this.metrics.issues.inc({ partner: partner.id, code: g.code, severity: g.severity }, g.count);

    let commit = null;
    if (result.status === 'COMMITTED') commit = this.db.promote(run.id, partner.id, run.importType === 'full_catalog');
    else if (result.status === 'FAILED') this.db.clearRunData(run.id);
    this.db.updateRun(run.id, { status: result.status, statusReason: result.decisionReason, result, fatal: result.fatal, commit });
    this.finishMetrics(partner.id, run.importType, format, result.status, started);
    log[result.status === 'COMMITTED' ? 'info' : 'warn'](
      {
        event: 'run.processed',
        status: result.status,
        counts: result.counts,
        errorRate: result.errorRate,
        maxErrorRate: result.maxErrorRate,
        holdReasons: result.holdReasons,
        durationMs: result.durationMs,
        recordsPerSecond: result.recordsPerSecond,
        topIssues: result.issueGroups.slice(0, 5).map((g) => `${g.code}x${g.count}`),
        commit,
      },
      `run ${result.status.toLowerCase()}`,
    );
  }

  private finishMetrics(partnerId: string, importType: string, format: string, status: string, started: number) {
    this.metrics.runs.inc({ partner: partnerId, import_type: importType, format, status });
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
