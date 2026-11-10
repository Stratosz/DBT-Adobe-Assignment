import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyServerOptions } from 'fastify';
import multipart from '@fastify/multipart';
import {
  CANONICAL_FIELDS,
  IMPORT_TYPES,
  ERROR_RATE_OVERRIDE_BOUNDS,
  ISSUE_CATALOG,
  listAdapters,
  quarantineToCsv,
  quarantineToJson,
  type CanonicalFieldName,
  type QuarantinedRecord,
  type SavedMapping,
} from '@feed/core';
import { Db, type PartnerRow, type RunRow } from './db.ts';
import { createMetrics } from './metrics.ts';
import { AppError, RunService } from './runService.ts';

export interface AppOptions {
  dbPath: string;
  dataDir: string;
  partnersFile?: string;
  maxUploadBytes?: number;
  logger?: FastifyServerOptions['logger'];
}

export const DEFAULT_MAX_UPLOAD = 50 * 1024 * 1024;

export async function buildApp(opts: AppOptions) {
  const app = Fastify({
    logger: opts.logger ?? false,
    genReqId: () => `req_${Math.random().toString(36).slice(2, 10)}`,
    bodyLimit: 1024 * 1024,
  });
  const db = new Db(opts.dbPath);
  const metrics = createMetrics(() => db.countByStatus());
  const runs = new RunService(db, opts.dataDir, metrics, app.log);

  // Seed partners from config (idempotent).
  if (opts.partnersFile) {
    const partners = JSON.parse(readFileSync(opts.partnersFile, 'utf8')) as (Omit<PartnerRow, 'readOptions'> & { readOptions?: PartnerRow['readOptions'] })[];
    for (const p of partners) db.upsertPartner({ ...p, description: p.description ?? null, readOptions: p.readOptions ?? {} });
  }

  await app.register(multipart, { limits: { fileSize: opts.maxUploadBytes ?? DEFAULT_MAX_UPLOAD, files: 1 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      req.log.info({ code: err.code, message: err.message }, 'request rejected');
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, hint: err.hint, details: err.details } });
    }
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.status(413).send({ error: { code: 'FILE_TOO_LARGE', message: e.message, hint: 'Split the feed or raise MAX_UPLOAD_MB.' } });
    }
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: e.code ?? 'BAD_REQUEST', message: e.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Unexpected error', hint: `Quote request id ${req.id} when reporting this.` } });
  });

  // ---- meta / partners ----------------------------------------------------------------------
  app.get('/health', async () => ({ status: 'ok', db: db.sqlite.prepare('SELECT 1 AS ok').get()?.ok === 1 }));

  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  app.get('/api/meta', async () => ({
    importTypes: Object.values(IMPORT_TYPES),
    overrideBounds: ERROR_RATE_OVERRIDE_BOUNDS,
    formats: listAdapters().map((a) => ({ id: a.id, label: a.label, extensions: a.extensions })),
    fields: Object.values(CANONICAL_FIELDS).map(({ name, type, description }) => ({ name, type, description })),
    issueCodes: Object.fromEntries(Object.entries(ISSUE_CATALOG).map(([code, d]) => [code, { kind: d.kind, title: d.title }])),
  }));

  app.get('/api/partners', async () =>
    db.listPartners().map((p) => ({ ...p, productCount: db.countProducts(p.id), savedMappings: db.listMappings(p.id).length })),
  );

  app.get<{ Params: { id: string } }>('/api/partners/:id/mappings', async (req) => db.listMappings(req.params.id));

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/partners/:id/products', async (req) =>
    db.listProducts(req.params.id, Number(req.query.limit ?? 200)),
  );

  // ---- runs ---------------------------------------------------------------------------------
  app.post('/api/runs', async (req, reply) => {
    const file = await req.file();
    if (!file) throw new AppError(400, 'FILE_REQUIRED', 'Upload a file in the "file" field (multipart/form-data)');
    const bytes = await file.toBuffer();
    const field = (name: string) => {
      const f = file.fields[name];
      const v = f && !Array.isArray(f) && 'value' in f ? String(f.value ?? '').trim() : '';
      return v || null;
    };
    const partnerId = field('partnerId');
    if (!partnerId) throw new AppError(400, 'PARTNER_REQUIRED', 'Field "partnerId" is required');
    const maxErrorRate = field('maxErrorRate');
    const run = await runs.ingest({
      partnerId,
      importType: field('importType') ?? 'full_catalog',
      filename: file.filename ?? null,
      bytes,
      format: field('format'),
      maxErrorRate: maxErrorRate === null ? null : Number(maxErrorRate),
      overrideReason: field('overrideReason'),
      force: field('force') === 'true',
    });
    return reply.status(201).send(runView(run));
  });

  app.get<{ Querystring: { partnerId?: string; limit?: string } }>('/api/runs', async (req) =>
    db.listRuns({ partnerId: req.query.partnerId, limit: Number(req.query.limit ?? 50) }).map(runSummary),
  );

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req) => {
    const run = db.getRun(req.params.id);
    if (!run) throw new AppError(404, 'RUN_NOT_FOUND', `Unknown run "${req.params.id}"`);
    return runView(run);
  });

  app.post<{ Params: { id: string }; Body: { decisions?: Record<string, string | null>; remember?: boolean } }>('/api/runs/:id/mapping', async (req) => {
    const decisions = (req.body?.decisions ?? {}) as SavedMapping;
    for (const [source, target] of Object.entries(decisions)) {
      if (target !== null && !(target in CANONICAL_FIELDS)) {
        throw new AppError(400, 'UNKNOWN_FIELD', `"${source}" -> "${target}": "${target}" is not a product field`, `Valid fields: ${Object.keys(CANONICAL_FIELDS).join(', ')}`);
      }
    }
    return runView(await runs.confirmMapping(req.params.id, decisions as Record<string, CanonicalFieldName | null>, req.body?.remember !== false));
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/api/runs/:id/approve', async (req) =>
    runView(await runs.approve(req.params.id, req.body?.reason ?? '')),
  );

  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/api/runs/:id/reject', async (req) =>
    runView(await runs.reject(req.params.id, req.body?.reason ?? '')),
  );

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>('/api/runs/:id/quarantine', async (req, reply) => {
    const run = db.getRun(req.params.id);
    if (!run) throw new AppError(404, 'RUN_NOT_FOUND', `Unknown run "${req.params.id}"`);
    const records = db.quarantinedRecords(run.id) as QuarantinedRecord[];
    const base = (run.filename ?? run.id).replace(/\.[^.]+$/, '');
    const asJson = req.query.format === 'json' || (req.query.format !== 'csv' && (run.format === 'json' || run.format === 'ndjson'));
    reply.header('content-disposition', `attachment; filename="${base}.quarantine.${asJson ? 'json' : 'csv'}"`);
    reply.type(asJson ? 'application/json' : 'text/csv; charset=utf-8');
    return asJson ? quarantineToJson(records) : quarantineToCsv(records);
  });

  app.addHook('onClose', async () => db.sqlite.close());

  return { app, db, runs };
}

function runSummary(r: RunRow) {
  const result = r.result as { counts?: unknown; errorRate?: number } | null;
  return {
    id: r.id,
    partnerId: r.partnerId,
    importType: r.importType,
    filename: r.filename,
    format: r.format,
    status: r.status,
    statusReason: r.statusReason,
    counts: result?.counts ?? null,
    errorRate: result?.errorRate ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function runView(r: RunRow) {
  return { ...runSummary(r), sizeBytes: r.sizeBytes, policy: r.policy, analysis: r.analysis, drift: r.drift, mapping: r.mapping, result: r.result, fatal: r.fatal, commit: r.commit };
}

export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
