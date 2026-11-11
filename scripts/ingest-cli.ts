/**
 * Run the pipeline on a file without the API. Useful for debugging a partner file.
 *
 *   npm run ingest -- fixtures/peak/catalog.json --partner peak --type full_catalog
 *   npm run ingest -- fixtures/nordwind/week2_catalog.csv --partner nordwind --accept-suggestions
 *
 * Without --accept-suggestions the CLI stops when the mapping needs a human, exactly like the API.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { analyzeFile, bufferSource, describeLocation, processRecords, quarantineToCsv, type PartnerLocale, type QuarantinedRecord } from '@feed/core';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    partner: { type: 'string', default: 'nordwind' },
    type: { type: 'string', default: 'full_catalog' },
    format: { type: 'string' },
    'max-error-rate': { type: 'string' },
    reason: { type: 'string' },
    'accept-suggestions': { type: 'boolean', default: false },
    out: { type: 'string', default: '.' },
  },
});

const file = positionals[0];
if (!file) {
  console.error(
    'usage: npm run ingest -- <file> [--partner nordwind|peak] [--type full_catalog|price_update|inventory_update] [--format csv|json|ndjson] [--accept-suggestions]',
  );
  process.exit(2);
}
const partners = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'partners.json'), 'utf8')) as { id: string; locale: PartnerLocale }[];
const partner = partners.find((p) => p.id === values.partner);
if (!partner) throw new Error(`unknown partner ${values.partner}`);

const input = {
  source: bufferSource(readFileSync(file)),
  filename: basename(file),
  format: values.format ?? null,
  importType: values.type!,
  locale: partner.locale,
  policyOverride: values['max-error-rate'] ? { maxErrorRate: Number(values['max-error-rate']), reason: values.reason ?? null } : undefined,
};

const analysis = await analyzeFile(input);
console.log(`\nFormat: ${analysis.format} (${analysis.detectionMethod})  encoding: ${analysis.encoding}`);
if (analysis.fatal) {
  console.error(`FAILED ${analysis.fatal.code}: ${analysis.fatal.message}\n  -> ${analysis.fatal.hint}`);
  process.exit(1);
}
const proposal = analysis.proposal!;
console.log('\nField mapping');
console.table(proposal.matches.map((m) => ({ source: m.sourceField, target: m.target ?? '-', confidence: m.confidence, status: m.status, method: m.method })));
if (proposal.missingRequired.length) console.log('Missing required fields:', proposal.missingRequired.join(', '));
if (proposal.conflicts.length) console.log('Conflicts:', proposal.conflicts);

let mapping = proposal.mapping;
if (proposal.needsConfirmation) {
  if (!values['accept-suggestions'] || proposal.missingRequired.length) {
    console.log('\nMapping needs confirmation. Re-run with --accept-suggestions to accept the suggested targets.');
    process.exit(3);
  }
  mapping = Object.fromEntries(proposal.matches.filter((m) => m.target && m.status !== 'unmapped').map((m) => [m.sourceField, m.target!]));
}

const quarantined: QuarantinedRecord[] = [];
const result = await processRecords(input, mapping, { accepted() {}, quarantined: (r) => void quarantined.push(r) }, analysis);

console.log(`\n${result.status}: ${result.decisionReason}`);
console.log(result.counts, `${result.recordsPerSecond} records/s`);
for (const g of result.issueGroups) {
  const where = g.locations.slice(0, 3).map(describeLocation).join(', ');
  console.log(
    `\n[${g.severity.toUpperCase()}] ${g.code} x${g.count}${g.sourceField ? ` in "${g.sourceField}"` : ''}${where ? ` (${where})` : ''}\n  ${g.title}\n  -> ${g.hint}`,
  );
}
if (quarantined.length) {
  const out = join(values.out!, `${basename(file)}.quarantine.csv`);
  writeFileSync(out, quarantineToCsv(quarantined));
  console.log(`\nQuarantine file: ${out}`);
}
