/**
 * Measure pipeline throughput and memory on a file, without the database.
 *
 *   npm run gen:large -- 1000000 csv
 *   npm run bench -- fixtures/generated/large_1000000.csv
 *
 * Reads the file as a stream (not into memory), so peak RSS reflects the pipeline itself.
 * Uncertain column matches are accepted as suggested (this measures speed, not mapping).
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { analyzeFile, processRecords, type ByteSource } from '@feed/core';

const file = process.argv[2];
const importType = process.argv[3] ?? 'full_catalog';
if (!file || file === '--help') {
  console.error(
    'usage: npm run bench -- <file> [full_catalog|price_update|inventory_update]\n  e.g. npm run gen:large -- 100000 csv && npm run bench -- fixtures/generated/large_100000.csv',
  );
  process.exit(2);
}
if (!existsSync(file)) {
  console.error(`File not found: ${file}\nGenerate one first, e.g. npm run gen:large -- 100000 csv`);
  process.exit(2);
}

const source: ByteSource = () => createReadStream(file, { highWaterMark: 256 * 1024 });
const input = { source, filename: file, importType, locale: { decimalSeparator: '.', dateOrder: 'DMY', defaultCurrency: 'EUR' } as const };

let peakRss = 0;
const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 50);

const t0 = performance.now();
const analysis = await analyzeFile(input);
const t1 = performance.now();
if (analysis.fatal || !analysis.proposal) {
  clearInterval(sampler);
  console.error(`Cannot benchmark this file: ${analysis.fatal?.code} ${analysis.fatal?.message}\n  -> ${analysis.fatal?.hint}`);
  process.exit(1);
}
const proposal = analysis.proposal;
if (proposal.missingRequired.length) {
  clearInterval(sampler);
  console.error(`Cannot benchmark this file: no column for required field(s) ${proposal.missingRequired.join(', ')} (import type ${importType}).`);
  process.exit(1);
}
const mapping = proposal.needsConfirmation
  ? Object.fromEntries(proposal.matches.filter((m) => m.target && m.status !== 'unmapped').map((m) => [m.sourceField, m.target!]))
  : proposal.mapping;

const result = await processRecords(input, mapping, { accepted() {}, quarantined() {} }, analysis);
const t2 = performance.now();
clearInterval(sampler);

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;
console.log({
  file,
  format: analysis.format,
  size: mb(statSync(file).size),
  records: result.counts.total,
  quarantined: result.counts.quarantined,
  analyzeMs: Math.round(t1 - t0),
  processMs: Math.round(t2 - t1),
  recordsPerSecond: Math.round(result.counts.total / ((t2 - t1) / 1000)),
  peakRss: mb(peakRss),
  status: result.status,
});
