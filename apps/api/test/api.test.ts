import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness } from './helpers.ts';

let h: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => h.app.close());

describe('ingestion API: the Nordwind story end to end', () => {
  it('week 1 commits, week 2 waits for mapping, confirmation is remembered, week 3 is held then approved', async () => {
    const up = await h.upload('uploader', 'nordwind/week1_catalog.csv', { partnerId: 'nordwind', importType: 'full_catalog' });
    expect(up.status).toBe(202); // accepted, processed in the background
    expect(up.body.status).toBe('RECEIVED');
    const w1 = await h.settle(up.body.id);
    expect(w1.body).toMatchObject({ status: 'COMMITTED', format: 'csv', commit: { inserted: 30, updated: 0 }, createdBy: 'andrei' });

    const w2 = await h.ingest('uploader', 'nordwind/week2_catalog.csv', { partnerId: 'nordwind', importType: 'full_catalog' });
    expect(w2.body.status).toBe('AWAITING_MAPPING');
    expect(w2.body.drift).toMatchObject({
      changed: true,
      added: expect.arrayContaining(['Artikel-Nr.', 'Farbe']),
      removed: expect.arrayContaining(['Artikelnummer']),
    });

    const bad = await h.req('reviewer', 'POST', `/api/runs/${w2.body.id}/mapping`, { decisions: { 'Artikel-Nr.': 'sku' } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.problems).toContain('"VK-Preis" still needs a decision');

    const confirmed = await h.req('reviewer', 'POST', `/api/runs/${w2.body.id}/mapping`, {
      decisions: { 'Artikel-Nr.': 'sku', 'VK-Preis': 'price', Lagerbestand: 'quantity', Farbe: null },
    });
    expect(confirmed).toMatchObject({ status: 202, body: { status: 'QUEUED' } });
    expect((await h.settle(w2.body.id)).body).toMatchObject({ status: 'COMMITTED', commit: { inserted: 0, updated: 29 } });

    const mappings = (await h.req('uploader', 'GET', '/api/partners/nordwind/mappings')).body;
    expect(mappings.map((m: { sourceField: string; target: string | null; decidedBy: string }) => [m.sourceField, m.target, m.decidedBy])).toEqual(
      expect.arrayContaining([
        ['VK-Preis', 'price', 'bogdan'],
        ['Farbe', null, 'bogdan'],
      ]),
    );

    // Same layout as week 2: the saved mapping applies, no question asked; the data is broken so it is held.
    const w3 = await h.ingest('uploader', 'nordwind/week3_catalog.csv', { partnerId: 'nordwind', importType: 'full_catalog' });
    expect(w3.body.status).toBe('HELD_FOR_REVIEW');
    expect(w3.body.result.holdReasons).toEqual([expect.stringMatching(/above the 5\.0% limit/)]);
    const products = (await h.req('uploader', 'GET', '/api/partners/nordwind/products')).body;
    expect(products.every((p: { last_run_id: string }) => p.last_run_id !== w3.body.id)).toBe(true); // nothing applied

    const noReason = await h.req('reviewer', 'POST', `/api/runs/${w3.body.id}/approve`, {});
    expect(noReason.status).toBe(400);
    const approved = await h.req('reviewer', 'POST', `/api/runs/${w3.body.id}/approve`, { reason: 'Partner confirmed only 10 SKUs changed' });
    // 10 rows still had prices + 1 duplicate row of one of them (last one wins)
    expect(approved.body).toMatchObject({ status: 'COMMITTED', commit: { updated: 11 } });
    expect(approved.body.audit.map((a: { action: string; actorId: string }) => `${a.action}:${a.actorId}`)).toEqual([
      'run.uploaded:andrei',
      'run.approved:bogdan',
    ]);
  });

  it('serves the quarantine file in the source format family', async () => {
    const w1 = await h.ingest('uploader', 'peak/catalog.json', { partnerId: 'peak', importType: 'full_catalog' });
    expect(w1.body.status).toBe('AWAITING_MAPPING');
    await h.req('reviewer', 'POST', `/api/runs/${w1.body.id}/mapping`, { decisions: { 'inventory.status': 'availability' } });
    const run = (await h.settle(w1.body.id)).body;
    expect(run).toMatchObject({ status: 'COMMITTED', commit: { inserted: 29 } });
    const q = await h.req('uploader', 'GET', `/api/runs/${run.id}/quarantine`);
    expect(q.headers['content-type']).toMatch(/json/);
    expect(q.body[0]).toMatchObject({ _errors: [{ code: 'PRICE_UNPARSEABLE' }], _source_location: { pointer: '/data/products/11' } });
    const csv = await h.req('uploader', 'GET', `/api/runs/${run.id}/quarantine?format=csv`);
    expect(csv.body).toContain('PRICE_UNPARSEABLE');
  });

  it('inventory updates touch only stock fields and skip unknown SKUs', async () => {
    const inv = await h.ingest('uploader', 'peak/inventory.ndjson', { partnerId: 'peak', importType: 'inventory_update' });
    expect(inv.body).toMatchObject({ status: 'COMMITTED', commit: { inserted: 0, unknownSkus: 23 } });
  });

  it('records a FAILED run with the fatal reason for a truncated export', async () => {
    const r = await h.ingest('uploader', 'peak/catalog_broken.json', { partnerId: 'peak' });
    expect(r.body).toMatchObject({ status: 'FAILED', fatal: { code: 'FILE_UNPARSEABLE' } });
  });
});

describe('feedback round 1 through the API', () => {
  async function peakCatalog() {
    const run = await h.ingest('uploader', 'peak/catalog.json', { partnerId: 'peak' });
    await h.req('reviewer', 'POST', `/api/runs/${run.body.id}/mapping`, { decisions: { 'inventory.status': 'availability' } });
    await h.settle(run.body.id);
  }

  it('#2 a late stock file does not overwrite newer stock', async () => {
    await peakCatalog();
    const fresh = await h.ingest('uploader', 'peak/inventory.ndjson', { partnerId: 'peak', importType: 'inventory_update' });
    // 22 updated; PK5011 is not in the catalog (its price was "TBD") so it is skipped as unknown
    expect(fresh.body).toMatchObject({ status: 'COMMITTED', commit: { updated: 22, unknownSkus: 1 } });
    const late = await h.ingest('uploader', 'peak/inventory_late.ndjson', { partnerId: 'peak', importType: 'inventory_update' });
    expect(late.body.status).toBe('COMMITTED');
    expect(late.body.result.counts).toMatchObject({ skippedStale: 22 });
    // only the 2 SKUs the fresh file had set aside are older in the catalog, so they do update
    expect(late.body.commit).toMatchObject({ updated: 2, unknownSkus: 1 });
  });

  it('#3 a price bug is held for review instead of going live', async () => {
    await peakCatalog();
    const r = await h.ingest('uploader', 'peak/prices_bug.csv', { partnerId: 'peak', importType: 'price_update' });
    expect(r.body.status).toBe('HELD_FOR_REVIEW');
    expect(r.body.result.holdReasons).toEqual([expect.stringMatching(/prices changed by more than 50%/)]);
    const rejected = await h.req('reviewer', 'POST', `/api/runs/${r.body.id}/reject`, { reason: 'Unit bug, supplier resending' });
    expect(rejected.body.status).toBe('REJECTED');
  });

  it('#4 a 3-row price fix with one typo is applied, not held', async () => {
    await peakCatalog();
    const r = await h.ingest('uploader', 'peak/prices_small_fix.csv', { partnerId: 'peak', importType: 'price_update' });
    expect(r.body).toMatchObject({ status: 'COMMITTED', commit: { updated: 2 } });
  });

  it('#6 an admin can correct or forget a saved mapping, and it is audited', async () => {
    const w1 = await h.ingest('uploader', 'nordwind/week2_catalog.csv', { partnerId: 'nordwind' });
    await h.req('reviewer', 'POST', `/api/runs/${w1.body.id}/mapping`, {
      decisions: { 'Artikel-Nr.': 'sku', 'VK-Preis': 'price', Lagerbestand: 'quantity', Farbe: 'availability' },
    });
    await h.settle(w1.body.id);

    expect((await h.req('reviewer', 'PUT', '/api/partners/nordwind/mappings/Farbe', { target: null })).status).toBe(403);
    const fixed = await h.req('admin', 'PUT', '/api/partners/nordwind/mappings/Farbe', { target: null });
    expect(fixed.body.find((m: { sourceField: string }) => m.sourceField === 'Farbe')).toMatchObject({ target: null, decidedBy: 'marius' });
    const removed = await h.req('admin', 'DELETE', `/api/partners/nordwind/mappings/${encodeURIComponent('VK-Preis')}`);
    expect(removed.body.map((m: { sourceField: string }) => m.sourceField)).not.toContain('VK-Preis');

    const audit = (await h.req('reviewer', 'GET', '/api/audit?partnerId=nordwind')).body;
    expect(audit.slice(0, 2).map((a: { action: string; details: unknown }) => [a.action, a.details])).toEqual([
      ['mapping.deleted', { sourceField: 'VK-Preis', was: 'price' }],
      ['mapping.updated', { sourceField: 'Farbe', from: 'availability', to: null }],
    ]);
  });
});
