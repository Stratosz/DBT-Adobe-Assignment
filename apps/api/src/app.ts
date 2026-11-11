import { join } from 'node:path';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyServerOptions } from 'fastify';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  CANONICAL_FIELDS,
  CANONICAL_FIELD_NAMES,
  ERROR_RATE_OVERRIDE_BOUNDS,
  IMPORT_TYPES,
  ISSUE_CATALOG,
  csvCell,
  flatten,
  listAdapters,
  type CanonicalFieldName,
  type Issue,
  type SavedMapping,
} from '@feed/core';
import { AuthError, KeyStore, requireRole, resolveActor, type Actor } from './auth.ts';
import { Db, type PartnerRow, type RunRow } from './db.ts';
import { createMetrics } from './metrics.ts';
import { AppError, RunService } from './runService.ts';

export interface AppOptions {
  dbPath: string;
  dataDir: string;
  keys: KeyStore;
  partnersFile?: string;
  maxUploadBytes?: number;
  logger?: FastifyServerOptions['logger'];
  rateLimit?: { max: number; uploadMax: number; windowMs: number };
  /** Start the background worker (tests may drive it explicitly). Default true. */
  startWorker?: boolean;
}

export const DEFAULT_MAX_UPLOAD = 250 * 1024 * 1024;
export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

const ERROR_SCHEMA = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' }, hint: { type: 'string' }, details: {} },
      required: ['code', 'message'],
    },
  },
} as const;
const RUN_ID = { type: 'string', pattern: '^run_[0-9]{8}_[a-f0-9]{8}$' } as const;
const PARTNER_ID = { type: 'string', pattern: '^[a-z0-9-]{1,64}$' } as const;
const TARGET = { anyOf: [{ type: 'string', enum: [...CANONICAL_FIELD_NAMES] }, { type: 'null' }] } as const;

/** Filenames go into a response header: keep a conservative character set (no quotes, CR/LF, non-ASCII). */
export function safeFilename(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, '')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .slice(0, 80) || 'download'
  );
}

export async function buildApp(opts: AppOptions) {
  const app = Fastify({
    logger: opts.logger ?? false,
    genReqId: () => `req_${Math.random().toString(36).slice(2, 10)}`,
    bodyLimit: 256 * 1024,
    trustProxy: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', allErrors: false } },
  });
  const db = new Db(opts.dbPath);
  const metrics = createMetrics(() => db.countByStatus());
  const runs = new RunService(db, opts.dataDir, metrics, app.log);

  if (opts.partnersFile) {
    const partners = JSON.parse(readFileSync(opts.partnersFile, 'utf8')) as (Omit<PartnerRow, 'readOptions'> & { readOptions?: PartnerRow['readOptions'] })[];
    for (const p of partners) db.upsertPartner({ ...p, description: p.description ?? null, readOptions: p.readOptions ?? {} });
  }

  // ---- security plumbing ----------------------------------------------------------------------
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        styleSrcAttr: ["'unsafe-inline'"], // React style={{width}} on the progress bars
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  app.decorateRequest('actor', null);
  app.addHook('onRequest', async (req) => {
    req.actor = resolveActor(opts.keys, req);
  });

  const limits = opts.rateLimit ?? { max: 600, uploadMax: 60, windowMs: 60_000 };
  await app.register(rateLimit, {
    global: true,
    max: limits.max,
    timeWindow: limits.windowMs,
    keyGenerator: (req) => (req.actor ? `actor:${req.actor.id}` : `ip:${req.ip}`),
    allowList: (req) => req.url === '/health',
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: { code: 'RATE_LIMITED', message: `Too many requests; limit is ${ctx.max} per ${ctx.after}`, hint: `Retry after ${ctx.after}.` },
    }),
  });

  await app.register(multipart, { limits: { fileSize: opts.maxUploadBytes ?? DEFAULT_MAX_UPLOAD, files: 1, fields: 10, fieldSize: 1024 } });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Supplier feed intake API',
        version: '1.1.0',
        description: 'Upload partner feeds, confirm mappings, review held runs. All /api routes need `Authorization: Bearer <api key>`.',
      },
      components: { securitySchemes: { apiKey: { type: 'http', scheme: 'bearer' } } },
      security: [{ apiKey: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs', staticCSP: true });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError || err instanceof AuthError) {
      req.log.info({ code: err.code, message: err.message }, 'request rejected');
      const details = err instanceof AppError ? err.details : undefined;
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, hint: err.hint, details } });
    }
    const e = err as { statusCode?: number; code?: string; message: string; validation?: unknown; error?: { code: string; message: string; hint?: string } };
    if (e.statusCode === 429 && e.error) {
      req.log.warn({ event: 'rate_limited', actor: req.actor?.id, ip: req.ip }, 'rate limited');
      return reply.status(429).send({ error: e.error });
    }
    if (e.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.status(413).send({ error: { code: 'FILE_TOO_LARGE', message: e.message, hint: 'Split the feed, or raise MAX_UPLOAD_MB on the server.' } });
    }
    if (e.validation) {
      return reply.status(400).send({ error: { code: 'INVALID_REQUEST', message: e.message } });
    }
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: e.code ?? 'BAD_REQUEST', message: e.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Unexpected error', hint: `Quote request id ${req.id} when reporting this.` } });
  });

  const uploader = { preHandler: requireRole('uploader') };
  const reviewer = { preHandler: requireRole('reviewer') };
  const admin = { preHandler: requireRole('admin') };
  const actor = (req: { actor: Actor | null }) => req.actor!;
  const errors = { 400: ERROR_SCHEMA, 401: ERROR_SCHEMA, 403: ERROR_SCHEMA, 404: ERROR_SCHEMA, 409: ERROR_SCHEMA };

  // ---- public ----------------------------------------------------------------------------------
  /** Liveness: the process is up. */
  app.get('/health', { schema: { hide: true } }, async () => ({ status: 'ok' }));
  /** Readiness: dependencies answer. Load balancers route traffic only when this is 200. */
  app.get('/ready', { schema: { hide: true } }, async (_req, reply) => {
    try {
      db.sqlite.prepare('SELECT 1').get();
      return { status: 'ready', schemaVersion: db.schemaVersion() };
    } catch {
      return reply.status(503).send({ status: 'not ready' });
    }
  });

  // ---- admin -----------------------------------------------------------------------------------
  app.get('/metrics', { ...admin, schema: { hide: true } }, async (_req, reply) => {
    reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  // ---- meta ------------------------------------------------------------------------------------
  app.get('/api/me', { ...uploader, schema: { tags: ['meta'], summary: 'Who am I', response: errors } }, async (req) => actor(req));

  app.get('/api/meta', { ...uploader, schema: { tags: ['meta'], summary: 'Import types, formats, product fields, issue codes' } }, async () => ({
    importTypes: Object.values(IMPORT_TYPES),
    overrideBounds: ERROR_RATE_OVERRIDE_BOUNDS,
    formats: listAdapters().map((a) => ({ id: a.id, label: a.label, extensions: a.extensions })),
    fields: Object.values(CANONICAL_FIELDS).map(({ name, type, description }) => ({ name, type, description })),
    issueCodes: Object.fromEntries(Object.entries(ISSUE_CATALOG).map(([code, d]) => [code, { kind: d.kind, title: d.title }])),
  }));

  // ---- suppliers -------------------------------------------------------------------------------
  app.get('/api/partners', { ...uploader, schema: { tags: ['suppliers'], summary: 'List suppliers' } }, async () =>
    db.listPartners().map((p) => ({ ...p, productCount: db.countProducts(p.id), savedMappings: db.listMappings(p.id).length })),
  );

  app.get<{ Params: { id: string } }>(
    '/api/partners/:id/mappings',
    {
      ...uploader,
      schema: {
        tags: ['suppliers'],
        summary: 'Saved column mappings for a supplier',
        params: { type: 'object', properties: { id: PARTNER_ID }, required: ['id'] },
      },
    },
    async (req) => db.listMappings(req.params.id),
  );

  app.put<{ Params: { id: string; sourceField: string }; Body: { target: CanonicalFieldName | null } }>(
    '/api/partners/:id/mappings/:sourceField',
    {
      ...admin,
      schema: {
        tags: ['suppliers'],
        summary: 'Change a saved mapping (admin). target=null means "never import this column".',
        params: {
          type: 'object',
          properties: { id: PARTNER_ID, sourceField: { type: 'string', minLength: 1, maxLength: 200 } },
          required: ['id', 'sourceField'],
        },
        body: { type: 'object', properties: { target: TARGET }, required: ['target'], additionalProperties: false },
        response: errors,
      },
    },
    async (req) => runs.setMapping(req.params.id, req.params.sourceField, req.body.target, actor(req)),
  );

  app.delete<{ Params: { id: string; sourceField: string } }>(
    '/api/partners/:id/mappings/:sourceField',
    {
      ...admin,
      schema: {
        tags: ['suppliers'],
        summary: 'Forget a saved mapping (admin); the column will be suggested again on the next file',
        params: {
          type: 'object',
          properties: { id: PARTNER_ID, sourceField: { type: 'string', minLength: 1, maxLength: 200 } },
          required: ['id', 'sourceField'],
        },
        response: errors,
      },
    },
    async (req) => runs.deleteMapping(req.params.id, req.params.sourceField, actor(req)),
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: number } }>(
    '/api/partners/:id/products',
    {
      ...uploader,
      schema: {
        tags: ['suppliers'],
        summary: 'Products in the catalog for a supplier',
        params: { type: 'object', properties: { id: PARTNER_ID }, required: ['id'] },
        querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } } },
      },
    },
    async (req) => db.listProducts(req.params.id, req.query.limit ?? 200),
  );

  // ---- runs ------------------------------------------------------------------------------------
  app.post(
    '/api/runs',
    {
      ...uploader,
      config: { rateLimit: { max: limits.uploadMax, timeWindow: limits.windowMs } },
      schema: {
        tags: ['runs'],
        summary: 'Upload a supplier file (multipart/form-data). Fields must come before the file part.',
        description:
          'Form fields: partnerId (required), importType (full_catalog | price_update | inventory_update), format (csv | json | ndjson), maxErrorRate (0..0.5, reviewer only) + overrideReason, force=true to re-import an identical file. Then the "file" part. Returns 202; poll GET /api/runs/{id}.',
        consumes: ['multipart/form-data'],
      },
    },
    async (req, reply) => {
      const file = await req.file();
      if (!file) throw new AppError(400, 'FILE_REQUIRED', 'Upload a file in the "file" field (multipart/form-data)');
      const field = (name: string) => {
        const f = file.fields[name];
        const v = f && !Array.isArray(f) && 'value' in f ? String(f.value ?? '').trim() : '';
        return v || null;
      };
      const partnerId = field('partnerId');
      if (!partnerId) {
        file.file.resume();
        throw new AppError(400, 'PARTNER_REQUIRED', 'Field "partnerId" is required', 'Send the form fields before the file part.');
      }
      const maxErrorRate = field('maxErrorRate');
      if (maxErrorRate !== null && !Number.isFinite(Number(maxErrorRate))) {
        file.file.resume();
        throw new AppError(400, 'INVALID_POLICY_OVERRIDE', 'maxErrorRate must be a number between 0 and 0.5');
      }
      const run = await runs.receive({
        actor: actor(req),
        partnerId,
        importType: field('importType') ?? 'full_catalog',
        filename: file.filename ? file.filename.slice(0, 200) : null,
        stream: file.file,
        format: field('format'),
        maxErrorRate: maxErrorRate === null ? null : Number(maxErrorRate),
        overrideReason: field('overrideReason'),
        force: field('force') === 'true',
      });
      return reply.status(202).header('location', `/api/runs/${run.id}`).send(runView(run, db));
    },
  );

  app.get<{ Querystring: { partnerId?: string; limit?: number } }>(
    '/api/runs',
    {
      ...uploader,
      schema: {
        tags: ['runs'],
        summary: 'Recent runs',
        querystring: { type: 'object', properties: { partnerId: PARTNER_ID, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } },
      },
    },
    async (req) => db.listRuns({ partnerId: req.query.partnerId, limit: req.query.limit ?? 50 }).map(runSummary),
  );

  const runParams = { type: 'object', properties: { id: RUN_ID }, required: ['id'] } as const;
  const getRun = (id: string) => {
    const run = db.getRun(id);
    if (!run) throw new AppError(404, 'RUN_NOT_FOUND', `Unknown run "${id}"`);
    return run;
  };

  app.get<{ Params: { id: string } }>(
    '/api/runs/:id',
    { ...uploader, schema: { tags: ['runs'], summary: 'Run detail, including mapping proposal, result and audit trail', params: runParams } },
    async (req) => runView(getRun(req.params.id), db),
  );

  app.post<{ Params: { id: string }; Body: { decisions: Record<string, CanonicalFieldName | null>; remember?: boolean } }>(
    '/api/runs/:id/mapping',
    {
      ...reviewer,
      schema: {
        tags: ['runs'],
        summary: 'Confirm the column mapping of a run waiting for it (reviewer)',
        params: runParams,
        body: {
          type: 'object',
          properties: {
            decisions: { type: 'object', additionalProperties: TARGET, maxProperties: 500, propertyNames: { maxLength: 200 } },
            remember: { type: 'boolean', default: true },
          },
          required: ['decisions'],
          additionalProperties: false,
        },
        response: { ...errors, 422: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const decisions = Object.assign(Object.create(null), req.body.decisions) as SavedMapping;
      return reply.status(202).send(runView(await runs.confirmMapping(req.params.id, decisions, req.body.remember !== false, actor(req)), db));
    },
  );

  const reasonBody = { type: 'object', properties: { reason: { type: 'string', maxLength: 500 } }, additionalProperties: false } as const;

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/api/runs/:id/approve',
    {
      ...reviewer,
      schema: {
        tags: ['runs'],
        summary: 'Approve a held run; applies its accepted rows (reviewer, not the uploader)',
        params: runParams,
        body: reasonBody,
        response: errors,
      },
    },
    async (req) => runView(await runs.approve(req.params.id, req.body?.reason ?? '', actor(req)), db),
  );

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/api/runs/:id/reject',
    { ...reviewer, schema: { tags: ['runs'], summary: 'Reject a held or waiting run (reviewer)', params: runParams, body: reasonBody, response: errors } },
    async (req) => runView(await runs.reject(req.params.id, req.body?.reason ?? '', actor(req)), db),
  );

  app.get<{ Params: { id: string }; Querystring: { format?: 'csv' | 'json' } }>(
    '/api/runs/:id/quarantine',
    {
      ...uploader,
      schema: {
        tags: ['runs'],
        summary: 'Download set-aside rows with reasons (streamed). CSV cells are formula-escaped.',
        params: runParams,
        querystring: { type: 'object', properties: { format: { type: 'string', enum: ['csv', 'json'] } } },
      },
    },
    async (req, reply) => {
      const run = getRun(req.params.id);
      const asJson = req.query.format === 'json' || (req.query.format !== 'csv' && (run.format === 'json' || run.format === 'ndjson'));
      const base = safeFilename(run.filename ?? run.id);
      reply.header('content-disposition', `attachment; filename="${base}.quarantine.${asJson ? 'json' : 'csv'}"`);
      reply.type(asJson ? 'application/json' : 'text/csv; charset=utf-8');
      return reply.send(Readable.from(asJson ? quarantineJsonStream(db, run.id) : quarantineCsvStream(db, run.id)));
    },
  );

  app.get<{ Querystring: { runId?: string; partnerId?: string; limit?: number } }>(
    '/api/audit',
    {
      ...reviewer,
      schema: {
        tags: ['audit'],
        summary: 'Audit log: who did what (reviewer)',
        querystring: {
          type: 'object',
          properties: { runId: RUN_ID, partnerId: PARTNER_ID, limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
        },
      },
    },
    async (req) => db.listAudit({ runId: req.query.runId, partnerId: req.query.partnerId, limit: req.query.limit ?? 100 }),
  );

  if (opts.startWorker !== false) {
    app.addHook('onReady', async () => runs.start());
  }
  app.addHook('onClose', async () => {
    await runs.stop();
    db.sqlite.close();
  });

  return { app, db, runs };
}

/** Streams the quarantine CSV: one pass to collect columns, one to write rows. Memory is bounded by page size. */
function* quarantineCsvStream(db: Db, runId: string): Generator<string> {
  const columns = ['_source_location', '_error_codes', '_error_messages'];
  const seen = new Set(columns);
  for (const r of db.iterateQuarantine(runId)) {
    const raw = r.raw !== null && typeof r.raw === 'object' ? flatten(r.raw) : { _raw: r.raw };
    for (const k of Object.keys(raw)) {
      if (!seen.has(k)) {
        seen.add(k);
        columns.push(k);
      }
    }
  }
  yield `\uFEFF${columns.map(csvCell).join(',')}\n`;
  for (const r of db.iterateQuarantine(runId)) {
    const loc = r.location as { line?: number; pointer?: string };
    const issues = r.issues as Issue[];
    const raw = r.raw !== null && typeof r.raw === 'object' ? flatten(r.raw) : { _raw: r.raw };
    const row: Record<string, unknown> = Object.assign(Object.create(null), raw, {
      _source_location: loc.line !== undefined ? `line ${loc.line}` : (loc.pointer ?? ''),
      _error_codes: [...new Set(issues.map((i) => i.code))].join('|'),
      _error_messages: issues.map((i) => `${i.sourceField ? `${i.sourceField}: ` : ''}${i.message}`).join(' | '),
    });
    yield `${columns.map((c) => csvCell(row[c])).join(',')}\n`;
  }
}

function* quarantineJsonStream(db: Db, runId: string): Generator<string> {
  yield '[';
  let first = true;
  for (const r of db.iterateQuarantine(runId)) {
    const issues = r.issues as Issue[];
    const item = {
      _errors: issues.map((i) => ({ code: i.code, field: i.sourceField ?? i.field ?? null, message: i.message })),
      _source_location: r.location,
      record: r.raw,
    };
    yield `${first ? '' : ','}\n${JSON.stringify(item)}`;
    first = false;
  }
  yield '\n]\n';
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
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function runView(r: RunRow, db: Db) {
  return {
    ...runSummary(r),
    sizeBytes: r.sizeBytes,
    attempts: r.attempts,
    policy: r.policy,
    analysis: r.analysis,
    drift: r.drift,
    mapping: r.mapping,
    result: r.result,
    fatal: r.fatal,
    commit: r.commit,
    audit: db.listAudit({ runId: r.id, limit: 50 }).reverse(),
  };
}
