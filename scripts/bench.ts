/**
 * Measure pipeline throughput and memory on a file, without the database.
 *   npm run gen:large -- 1000000 csv && npm run bench -- fixtures/generated/large_1000000.csv
 *
 * Reads the file as a stream (not into memory) so peak RSS reflects the pipeline itself.
 */
import { createReadStream, statSync } from 'node:fs';
import { analyzeFile, processRecords, type ByteSource } from '@feed/core';

const file = process.argv[2];
if (!file) throw new Error('usage: npm run bench -- <file>');
const source: ByteSource = () => createReadStream(file, { highWaterMark: 256 * 1024 });
const input = { source, filename: file, importType: 'full_catalog', locale: { decimalSeparator: '.', dateOrder: 'DMY', defaultCurrency: 'EUR' } as const };

let peakRss = 0;
const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 50);

const t0 = performance.now();
const analysis = await analyzeFile(input);
const t1 = performance.now();
const result = await processRecords(input, analysis.proposal!.mapping, { accepted() {}, quarantined() {} }, analysis);
const t2 = performance.now();
clearInterval(sampler);

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;
console.log({
  file,
  size: mb(statSync(file).size),
  records: result.counts.total,
  quarantined: result.counts.quarantined,
  analyzeMs: Math.round(t1 - t0),
  processMs: Math.round(t2 - t1),
  recordsPerSecond: Math.round(result.counts.total / ((t2 - t1) / 1000)),
  peakRss: mb(peakRss),
  status: result.status,
});
