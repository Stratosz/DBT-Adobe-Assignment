import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { safeFilename } from '../src/app.ts';
import { KeyStore, hashKey } from '../src/auth.ts';
import { harness } from './helpers.ts';

/** InfoSec review findings (docs/feedback-round-1.md #1), one test per finding. */
let h: Awaited<ReturnType<typeof harness>>;
afterEach(async () => h?.app.close());

describe('authentication and roles', () => {
  it('rejects requests without a key, or with an unknown key, with a hint', async () => {
    h = await harness();
    const none = await h.req(null, 'GET', '/api/runs');
    expect(none).toMatchObject({ status: 401, body: { error: { code: 'UNAUTHENTICATED', hint: expect.stringMatching(/Bearer/) } } });
    expect(none.headers['www-authenticate']).toMatch(/Bearer/);
    const forged = await h.app.inject({ url: '/api/runs', headers: { authorization: 'Bearer not-a-real-key-123' } });
    expect(forged.statusCode).toBe(401);
  });

  it('enforces the role matrix', async () => {
    h = await harness();
    const up = await h.ingest('uploader', 'nordwind/week2_catalog.csv', { partnerId: 'nordwind' });
    const id = up.body.id;
    const cases: [Parameters<typeof h.req>[0], 'GET' | 'POST' | 'PUT', string, unknown, number][] = [
      ['uploader', 'GET', `/api/runs/${id}`, undefined, 200],
      ['uploader', 'POST', `/api/runs/${id}/mapping`, { decisions: {} }, 403],
      ['uploader', 'GET', '/api/audit', undefined, 403],
      ['reviewer', 'GET', '/api/audit', undefined, 200],
      ['reviewer', 'PUT', '/api/partners/nordwind/mappings/x', { target: null }, 403],
      ['reviewer', 'GET', '/metrics', undefined, 403],
      ['admin', 'GET', '/metrics', undefined, 200],
      [null, 'GET', '/metrics', undefined, 401],
    ];
    for (const [who, method, url, body, status] of cases) {
      expect([who, method, url, (await h.req(who, method, url, body)).status]).toEqual([who, method, url, status]);
    }
  });

  it('only reviewers may raise the bad-row limit on upload', async () => {
    h = await harness();
    const r = await h.upload('uploader', 'nordwind/week1_catalog.csv', { partnerId: 'nordwind', maxErrorRate: '0.3', overrideReason: 'x' });
    expect(r).toMatchObject({ status: 403, body: { error: { code: 'FORBIDDEN' } } });
    const ok = await h.upload('reviewer', 'nordwind/week1_catalog.csv', { partnerId: 'nordwind', maxErrorRate: '0.3', overrideReason: 'migration week' });
    expect(ok.status).toBe(202);
  });

  it('does not let the uploader approve their own held file (four eyes)', async () => {
    h = await harness();
    const run = await h.ingest('reviewer', 'nordwind/week3_catalog.csv', { partnerId: 'nordwind' });
    // week 3 alone has no saved mapping yet, so confirm first
    await h.req('reviewer', 'POST', `/api/runs/${run.body.id}/mapping`, { decisions: { 'Artikel-Nr.': 'sku', 'VK-Preis': 'price', Lagerbestand: 'quantity' } });
    expect((await h.settle(run.body.id)).body.status).toBe('HELD_FOR_REVIEW');
    const self = await h.req('reviewer', 'POST', `/api/runs/${run.body.id}/approve`, { reason: 'looks fine' });
    expect(self).toMatchObject({ status: 403, body: { error: { code: 'SELF_APPROVAL' } } });
    expect((await h.req('admin', 'POST', `/api/runs/${run.body.id}/approve`, { reason: 'escalated' })).status).toBe(200);
  });

  it('stores only hashes and refuses a plaintext key in the key file', () => {
    expect(() => new KeyStore([{ id: 'x', name: 'x', role: 'admin', keyHash: 'demo-admin-key' }])).toThrow(/hash/);
    const store = new KeyStore([{ id: 'x', name: 'X', role: 'admin', keyHash: hashKey('s3cret-key') }]);
    expect(store.authenticate('s3cret-key')).toMatchObject({ id: 'x', role: 'admin' });
    expect(store.authenticate('s3cret-kez')).toBeNull();
  });
});

describe('input handling', () => {
  it('validates request bodies and params at the boundary', async () => {
    h = await harness();
    const badId = await h.req('reviewer', 'GET', '/api/runs/../../etc/passwd');
    expect(badId.status).toBe(404);
    const badRunId = await h.req('reviewer', 'GET', '/api/runs/run_x');
    expect(badRunId).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
    const badTarget = await h.req('admin', 'PUT', '/api/partners/nordwind/mappings/Farbe', { target: 'price; DROP TABLE products' });
    expect(badTarget.status).toBe(400);
    const extra = await h.req('admin', 'PUT', '/api/partners/nordwind/mappings/Farbe', { target: null, isAdmin: true });
    expect(extra.status).toBe(400);
  });

  it('sanitizes filenames used in download headers', () => {
    expect(safeFilename('evil"\r\nSet-Cookie: x=1.csv')).toBe('evil_Set-Cookie_x_1');
    expect(safeFilename('Prix été 2026.csv')).toBe('Prix_t_2026');
  });

  it('escapes spreadsheet formulas in the downloaded set-aside rows', async () => {
    h = await harness();
    const content = Buffer.from('sku,name,price\nA,=HYPERLINK("http://evil.example"),oops\nB,ok,1\nC,ok,2\nD,ok,3\n');
    const up = await h.upload('uploader', 'evil.csv', { partnerId: 'nordwind', importType: 'full_catalog' }, content);
    await h.settle(up.body.id);
    const csv = await h.req('uploader', 'GET', `/api/runs/${up.body.id}/quarantine?format=csv`);
    expect(csv.body).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
    expect(csv.headers['content-disposition']).toBe('attachment; filename="evil.quarantine.csv"');
  });

  it('rejects uploads over the size limit', async () => {
    h = await harness({ maxUploadBytes: 1024 });
    const r = await h.upload('uploader', 'big.csv', { partnerId: 'nordwind' }, Buffer.alloc(4096, 'a'));
    expect(r).toMatchObject({ status: 413, body: { error: { code: 'FILE_TOO_LARGE' } } });
  });

  it('rejects empty uploads', async () => {
    h = await harness();
    const r = await h.upload('uploader', 'empty.csv', { partnerId: 'nordwind' }, Buffer.alloc(0));
    expect(r).toMatchObject({ status: 400, body: { error: { code: 'FILE_EMPTY' } } });
  });
});

describe('abuse protection and headers', () => {
  it('rate limits per key with a clear 429', async () => {
    h = await harness({ rateLimit: { max: 3, uploadMax: 1, windowMs: 60_000 } });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await h.req('uploader', 'GET', '/api/partners')).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    const limited = await h.req('uploader', 'GET', '/api/partners');
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
    expect((await h.req('reviewer', 'GET', '/api/partners')).status).toBe(200); // other keys unaffected
  });

  it('sends security headers', async () => {
    h = await harness();
    const res = await h.app.inject({ url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('keeps health public and data-free, readiness reports the schema version', async () => {
    h = await harness();
    expect((await h.app.inject({ url: '/health' })).json()).toEqual({ status: 'ok' });
    expect((await h.app.inject({ url: '/ready' })).json()).toEqual({ status: 'ready', schemaVersion: 3 });
  });

  it('publishes an OpenAPI description', async () => {
    h = await harness();
    const spec = (await h.app.inject({ url: '/docs/json' })).json();
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/api/runs', '/api/runs/{id}/approve', '/api/partners/{id}/mappings/{sourceField}']));
  });
});

describe('reliability: async processing and crash recovery (#5)', () => {
  it('re-queues a run left in PROCESSING by a crash and finishes it on restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'feed-crash-'));
    const dbPath = join(dataDir, 'feed.db');
    // 1st process: accept an upload but never run the worker, then "crash" mid-processing
    h = await harness({ dataDir, dbPath, startWorker: false });
    const up = await h.upload('uploader', 'nordwind/week1_catalog.csv', { partnerId: 'nordwind' });
    expect(up.status).toBe(202);
    h.db.sqlite.prepare(`UPDATE runs SET status = 'PROCESSING', attempts = 1 WHERE id = ?`).run(up.body.id);
    await h.app.close();

    // 2nd process: recovers and completes the run
    h = await harness({ dataDir, dbPath });
    const done = await h.settle(up.body.id);
    expect(done.body).toMatchObject({ status: 'COMMITTED', attempts: 2, commit: { inserted: 30 } });
  });

  it('gives up after repeated crashes instead of looping forever', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'feed-crash-'));
    const dbPath = join(dataDir, 'feed.db');
    h = await harness({ dataDir, dbPath, startWorker: false });
    const up = await h.upload('uploader', 'nordwind/week1_catalog.csv', { partnerId: 'nordwind' });
    h.db.sqlite.prepare(`UPDATE runs SET status = 'PROCESSING', attempts = 3 WHERE id = ?`).run(up.body.id);
    await h.app.close();
    h = await harness({ dataDir, dbPath });
    expect((await h.settle(up.body.id)).body).toMatchObject({ status: 'FAILED', statusReason: expect.stringMatching(/Gave up after 3 attempts/) });
  });

  it('processes queued runs in arrival order, one at a time', async () => {
    h = await harness({ startWorker: false });
    const a = await h.upload('uploader', 'peak/inventory.ndjson', { partnerId: 'peak', importType: 'inventory_update' });
    const b = await h.upload('uploader', 'peak/inventory_late.ndjson', { partnerId: 'peak', importType: 'inventory_update' });
    expect([a.body.status, b.body.status]).toEqual(['RECEIVED', 'RECEIVED']);
    h.runs.start();
    await h.runs.idle();
    const [ra, rb] = [await h.req('uploader', 'GET', `/api/runs/${a.body.id}`), await h.req('uploader', 'GET', `/api/runs/${b.body.id}`)];
    expect(Date.parse(ra.body.updatedAt)).toBeLessThanOrEqual(Date.parse(rb.body.updatedAt));
  });
});
