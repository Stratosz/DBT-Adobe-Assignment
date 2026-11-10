import '../src/quiet-warnings.ts';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT, buildApp } from '../src/app.ts';

const FIXTURES = join(REPO_ROOT, 'fixtures');
type App = Awaited<ReturnType<typeof buildApp>>['app'];

function multipart(fields: Record<string, string>, file: { name: string; content: Buffer }) {
  const boundary = '----test' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(file.content, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

let app: App;
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-api-'));
  ({ app } = await buildApp({ dbPath: ':memory:', dataDir: dir, partnersFile: join(FIXTURES, 'partners.json') }));
});
afterEach(async () => app.close());

async function upload(path: string, fields: Record<string, string>) {
  const res = await app.inject({ method: 'POST', url: '/api/runs', ...multipart(fields, { name: path.split('/').pop()!, content: readFileSync(join(FIXTURES, path)) }) });
  return { status: res.statusCode, body: res.json() };
}

describe('ingestion API: the Nordwind story end to end', () => {
  it('week 1 commits, week 2 waits for mapping, confirmation is remembered, week 3 is held then approved', async () => {
    const w1 = await upload('nordwind/week1_catalog.csv', { partnerId: 'nordwind', importType: 'full_catalog' });
    expect(w1.status).toBe(201);
    expect(w1.body).toMatchObject({ status: 'COMMITTED', format: 'csv', commit: { inserted: 30, updated: 0 } });

    const w2 = await upload('nordwind/week2_catalog.csv', { partnerId: 'nordwind', importType: 'full_catalog' });
    expect(w2.body.status).toBe('AWAITING_MAPPING');
    expect(w2.body.drift).toMatchObject({ changed: true, added: expect.arrayContaining(['Artikel-Nr.', 'Farbe']), removed: expect.arrayContaining(['Artikelnummer']) });

    // An incomplete confirmation is rejected with the reasons
    const bad = await app.inject({ method: 'POST', url: `/api/runs/${w2.body.id}/mapping`, payload: { decisions: { 'Artikel-Nr.': 'sku' } } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.details.problems).toContain('"VK-Preis" still needs a decision');

    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/runs/${w2.body.id}/mapping`,
      payload: { decisions: { 'Artikel-Nr.': 'sku', 'VK-Preis': 'price', Lagerbestand: 'quantity', Farbe: null } },
    });
    expect(confirmed.json()).toMatchObject({ status: 'COMMITTED', commit: { inserted: 0, updated: 29 } });

    const mappings = (await app.inject({ url: '/api/partners/nordwind/mappings' })).json();
    expect(mappings.map((m: { sourceField: string; target: string | null }) => [m.sourceField, m.target])).toEqual(
      expect.arrayContaining([['VK-Preis', 'price'], ['Farbe', null]]),
    );

    // Week 3 has the same layout: the saved mapping applies, no question asked; the data is broken so it is held.
    const w3 = await upload('nordwind/week3_catalog.csv', { partnerId: 'nordwind', importType: 'full_catalog' });
    expect(w3.body.status).toBe('HELD_FOR_REVIEW');
    expect(w3.body.statusReason).toMatch(/above the 5\.0% limit/);
    const products = (await app.inject({ url: '/api/partners/nordwind/products' })).json();
    expect(products.every((p: { last_run_id: string }) => p.last_run_id !== w3.body.id)).toBe(true); // nothing applied

    const noReason = await app.inject({ method: 'POST', url: `/api/runs/${w3.body.id}/approve`, payload: {} });
    expect(noReason.statusCode).toBe(400);
    const approved = await app.inject({ method: 'POST', url: `/api/runs/${w3.body.id}/approve`, payload: { reason: 'Partner confirmed only 10 SKUs changed' } });
    // 10 rows still had prices + 1 duplicate row of one of them (last one wins)
    expect(approved.json()).toMatchObject({ status: 'COMMITTED', commit: { updated: 11 } });
  });

  it('serves the quarantine file in the source format family', async () => {
    const w1 = await upload('peak/catalog.json', { partnerId: 'peak', importType: 'full_catalog' });
    expect(w1.body.status).toBe('AWAITING_MAPPING');
    const run = (await app.inject({ method: 'POST', url: `/api/runs/${w1.body.id}/mapping`, payload: { decisions: { 'inventory.status': 'availability' } } })).json();
    expect(run).toMatchObject({ status: 'COMMITTED', commit: { inserted: 29 } });
    const q = await app.inject({ url: `/api/runs/${run.id}/quarantine` });
    expect(q.headers['content-type']).toMatch(/json/);
    expect(q.json()[0]).toMatchObject({ _errors: [{ code: 'PRICE_UNPARSEABLE' }], _source_location: { pointer: '/data/products/11' } });
    const csv = await app.inject({ url: `/api/runs/${run.id}/quarantine?format=csv` });
    expect(csv.body).toContain('PRICE_UNPARSEABLE');
  });

  it('inventory updates touch only stock fields and skip unknown SKUs', async () => {
    const inv = await upload('peak/inventory.ndjson', { partnerId: 'peak', importType: 'inventory_update' });
    expect(inv.body).toMatchObject({ status: 'COMMITTED', commit: { inserted: 0, unknownSkus: 23 } });
  });
});

describe('ingestion API: guard rails', () => {
  it('rejects re-importing the exact same file unless forced', async () => {
    await upload('nordwind/week1_catalog.csv', { partnerId: 'nordwind' });
    const again = await upload('nordwind/week1_catalog.csv', { partnerId: 'nordwind' });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'DUPLICATE_FILE', hint: expect.stringMatching(/force=true/) });
    const forced = await upload('nordwind/week1_catalog.csv', { partnerId: 'nordwind', force: 'true' });
    expect(forced.status).toBe(201);
  });

  it('validates the threshold override', async () => {
    const r = await upload('nordwind/week1_catalog.csv', { partnerId: 'nordwind', maxErrorRate: '0.9', overrideReason: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_POLICY_OVERRIDE');
  });

  it('fails clearly for an unknown partner', async () => {
    const r = await upload('nordwind/week1_catalog.csv', { partnerId: 'acme' });
    expect(r).toMatchObject({ status: 404, body: { error: { code: 'PARTNER_NOT_FOUND' } } });
  });

  it('records a FAILED run with the fatal reason for an unparseable file', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/runs', ...multipart({ partnerId: 'peak' }, { name: 'cut.json', content: Buffer.from('{"products":[{"sku":"A"},{"sk') }) });
    expect(res.json()).toMatchObject({ status: 'FAILED', fatal: { code: 'FILE_UNPARSEABLE' } });
  });

  it('exposes Prometheus metrics for runs, records and issues', async () => {
    await upload('peak/inventory.ndjson', { partnerId: 'peak', importType: 'inventory_update' });
    const m = (await app.inject({ url: '/metrics' })).body;
    expect(m).toMatch(/feed_runs_total\{partner="peak",import_type="inventory_update",format="ndjson",status="COMMITTED"\} 1/);
    expect(m).toMatch(/feed_records_total\{partner="peak",format="ndjson",outcome="quarantined"\} 2/);
    expect(m).toMatch(/feed_issues_total\{partner="peak",code="QUANTITY_NEGATIVE",severity="error"\} 1/);
    expect(m).toMatch(/feed_runs_waiting\{status="AWAITING_MAPPING"\} 0/);
  });
});
