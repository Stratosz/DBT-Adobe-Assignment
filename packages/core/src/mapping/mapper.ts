import { createHash } from 'node:crypto';
import { CANONICAL_FIELDS, CANONICAL_FIELD_NAMES, type CanonicalFieldName, type FieldType } from '../schema/canonical.ts';
import type { ImportTypeConfig } from '../schema/importTypes.ts';
import { ISSUE_CATALOG } from '../errors.ts';
import { isBlank, normalizeByType, type PartnerLocale } from '../normalize/index.ts';
import { normalizeFieldName, similarity } from './similarity.ts';

/**
 * Field mapper: proposes how each source field maps onto the canonical model, with a
 * confidence score and the reason, so a human can confirm what the machine is unsure about.
 *
 *   saved partner mapping       1.00   (a human already decided)
 *   exact canonical name        1.00
 *   known alias                 0.97
 *   alias on the leaf of a path 0.90   ("details.brand")
 *   fuzzy name similarity       <= 0.88  (never auto-applied on its own)
 *   value evidence              +0.10 if sample values fit the field's type, -0.25 if they clearly don't
 *   values alone (no name hint) 0.75-0.80 for self-identifying types (GTIN, URL, currency, availability)
 *
 * Bands: >= 0.90 auto, 0.65-0.90 needs confirmation, < 0.65 unmapped (kept as an extra).
 * Safety rules: a required field is only auto-mapped by a saved/exact/alias match, and two
 * sources competing for one target with similar scores is a conflict a human resolves.
 */
export const AUTO_THRESHOLD = 0.9;
export const CONFIRM_THRESHOLD = 0.65;
const FUZZY_CAP = 0.88;
const CONFLICT_MARGIN = 0.05;

export type MatchMethod = 'saved' | 'exact' | 'alias' | 'leaf_alias' | 'fuzzy' | 'values' | 'none';
export type MatchStatus = 'auto' | 'needs_confirmation' | 'unmapped' | 'ignored';

export interface Candidate {
  target: CanonicalFieldName;
  confidence: number;
  method: MatchMethod;
  reason: string;
}

export interface FieldMatch {
  sourceField: string;
  target: CanonicalFieldName | null;
  confidence: number;
  method: MatchMethod;
  status: MatchStatus;
  reason: string;
  /** Other plausible targets, best first (for the confirmation UI). */
  alternatives: Candidate[];
  samples: string[];
}

export interface MappingProposal {
  matches: FieldMatch[];
  missingRequired: CanonicalFieldName[];
  conflicts: { target: CanonicalFieldName; sourceFields: string[] }[];
  needsConfirmation: boolean;
  /** source field -> target for everything that is mapped (auto or confirmed). */
  mapping: Record<string, CanonicalFieldName>;
  fingerprint: string;
}

/** What a human (or a previous run) decided for a partner: target, or null = ignore this field. */
export type SavedMapping = Record<string, CanonicalFieldName | null>;

export interface FieldProfile {
  name: string;
  samples: unknown[];
}

const ALIAS_INDEX = new Map<string, CanonicalFieldName>();
for (const f of Object.values(CANONICAL_FIELDS)) for (const a of f.aliases) ALIAS_INDEX.set(normalizeFieldName(a), f.name);

const SELF_IDENTIFYING: Partial<Record<FieldType, number>> = { gtin: 0.8, currency: 0.8, url: 0.75, availability: 0.75 };

/** Share of non-blank samples that normalize cleanly as `type` (null = no evidence). */
export function valueFit(type: FieldType, samples: unknown[], locale: PartnerLocale): number | null {
  const present = samples.filter((s) => !isBlank(s));
  if (!present.length || type === 'string') return null;
  let good = 0;
  for (const s of present) {
    const r = normalizeByType(type, s, locale);
    if (r.value !== null && !r.issues.some((i) => ISSUE_CATALOG[i.code].kind === 'invalid')) good++;
  }
  return good / present.length;
}

function nameCandidates(sourceField: string): Candidate[] {
  const full = normalizeFieldName(sourceField.replaceAll('.', '_'));
  const isPath = sourceField.includes('.') || sourceField.includes('[');
  const inArray = sourceField.includes('[');
  const leaf = normalizeFieldName(sourceField.split('.').at(-1)!.replace(/\[\d+\]/g, ''));
  const out: Candidate[] = [];

  if ((CANONICAL_FIELD_NAMES as readonly string[]).includes(full)) {
    out.push({ target: full as CanonicalFieldName, confidence: 1, method: 'exact', reason: 'Exact field name' });
  }
  const alias = ALIAS_INDEX.get(full);
  if (alias) out.push({ target: alias, confidence: 0.97, method: 'alias', reason: `Known alias "${full}"` });
  if (isPath && !inArray) {
    const leafAlias = ALIAS_INDEX.get(leaf);
    if (leafAlias) out.push({ target: leafAlias, confidence: 0.9, method: 'leaf_alias', reason: `Nested field ending in known alias "${leaf}"` });
  }

  for (const field of Object.values(CANONICAL_FIELDS)) {
    let best = 0;
    let bestTerm = '';
    for (const term of [field.name, ...field.aliases]) {
      const t = normalizeFieldName(term);
      for (const candidate of isPath ? [full, leaf] : [full]) {
        if (candidate.length < 3 || t.length < 3) continue;
        const score = similarity(candidate, t);
        if (score > best) {
          best = score;
          bestTerm = term;
        }
      }
    }
    if (best >= 0.75) {
      let confidence = Math.min(FUZZY_CAP, best * FUZZY_CAP);
      if (inArray) confidence *= 0.7; // "images[0].url" is probably not the product URL
      out.push({ target: field.name, confidence, method: 'fuzzy', reason: `Name is similar to "${bestTerm}" (${best.toFixed(2)})` });
    }
  }
  return out;
}

function scoreField(profile: FieldProfile, locale: PartnerLocale): Candidate[] {
  const byTarget = new Map<CanonicalFieldName, Candidate>();
  for (const c of nameCandidates(profile.name)) {
    const prev = byTarget.get(c.target);
    if (!prev || prev.confidence < c.confidence) byTarget.set(c.target, c);
  }

  // Adjust name-based candidates with value evidence.
  for (const [target, c] of byTarget) {
    const fit = valueFit(CANONICAL_FIELDS[target].type, profile.samples, locale);
    if (fit === null) continue;
    if (fit >= 0.9) {
      if (c.confidence < 1) c.confidence = Math.min(0.99, c.confidence + 0.1);
      c.reason += `; ${Math.round(fit * 100)}% of sample values are valid ${CANONICAL_FIELDS[target].type}`;
    } else if (fit < 0.5) {
      c.confidence = Math.max(0, c.confidence - 0.25);
      c.reason += `; only ${Math.round(fit * 100)}% of sample values are valid ${CANONICAL_FIELDS[target].type}`;
    }
  }

  // Self-identifying values when the name gives no hint at all.
  if (byTarget.size === 0) {
    for (const field of Object.values(CANONICAL_FIELDS)) {
      const base = SELF_IDENTIFYING[field.type];
      if (!base) continue;
      const fit = valueFit(field.type, profile.samples, locale);
      if (fit !== null && fit >= 0.9) {
        byTarget.set(field.name, {
          target: field.name,
          confidence: base,
          method: 'values',
          reason: `Name unknown, but ${Math.round(fit * 100)}% of sample values look like ${field.type}`,
        });
      }
    }
  }
  return [...byTarget.values()].sort((a, b) => b.confidence - a.confidence);
}

export function statusFor(confidence: number): MatchStatus {
  if (confidence >= AUTO_THRESHOLD) return 'auto';
  if (confidence >= CONFIRM_THRESHOLD) return 'needs_confirmation';
  return 'unmapped';
}

export function fingerprintFields(fields: string[]): string {
  const canonical = [...new Set(fields.map((f) => normalizeFieldName(f)))].sort().join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

const displaySample = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 40);

export function proposeMapping(
  profiles: FieldProfile[],
  importType: ImportTypeConfig,
  locale: PartnerLocale,
  saved: SavedMapping = {},
): MappingProposal {
  const scored = profiles.map((p) => ({ profile: p, candidates: scoreField(p, locale) }));

  // Global greedy assignment: strongest (source, target) pairs first, each used once.
  const assigned = new Map<string, Candidate>(); // source -> candidate
  const takenTargets = new Map<CanonicalFieldName, string>(); // target -> source
  const ignored = new Set<string>();

  for (const { profile } of scored) {
    if (!(profile.name in saved)) continue;
    const target = saved[profile.name];
    if (target === null || target === undefined) {
      ignored.add(profile.name);
      continue;
    }
    if (takenTargets.has(target)) continue;
    assigned.set(profile.name, { target, confidence: 1, method: 'saved', reason: 'Confirmed earlier for this partner' });
    takenTargets.set(target, profile.name);
  }

  const pool = scored
    .filter(({ profile }) => !assigned.has(profile.name) && !ignored.has(profile.name))
    .flatMap(({ profile, candidates }) => candidates.map((c) => ({ source: profile.name, c })))
    .filter(({ c }) => c.confidence >= CONFIRM_THRESHOLD)
    .sort((a, b) => b.c.confidence - a.c.confidence);

  for (const { source, c } of pool) {
    if (assigned.has(source) || takenTargets.has(c.target)) continue;
    assigned.set(source, { ...c });
    takenTargets.set(c.target, source);
  }

  // Conflicts: another source wanted the same target almost as much.
  const conflicts: MappingProposal['conflicts'] = [];
  for (const [target, winner] of takenTargets) {
    const winning = assigned.get(winner)!;
    if (winning.method === 'saved') continue;
    const rivals = pool
      .filter(({ source, c }) => source !== winner && c.target === target && c.confidence >= winning.confidence - CONFLICT_MARGIN)
      .map(({ source }) => source);
    if (rivals.length) conflicts.push({ target, sourceFields: [winner, ...new Set(rivals)] });
  }
  const conflicted = new Set(conflicts.flatMap((c) => c.sourceFields));

  const required = new Set(importType.requiredFields);
  const matches: FieldMatch[] = scored.map(({ profile, candidates }) => {
    const samples = profile.samples.filter((s) => !isBlank(s)).slice(0, 5).map(displaySample);
    if (ignored.has(profile.name)) {
      return { sourceField: profile.name, target: null, confidence: 1, method: 'saved', status: 'ignored', reason: 'Ignored for this partner', alternatives: candidates.slice(0, 3), samples };
    }
    const chosen = assigned.get(profile.name);
    const alternatives = candidates.filter((c) => c.target !== chosen?.target).slice(0, 3);
    if (!chosen) {
      return { sourceField: profile.name, target: null, confidence: candidates[0]?.confidence ?? 0, method: 'none', status: 'unmapped', reason: 'No confident match', alternatives: candidates.slice(0, 3), samples };
    }
    let status = chosen.method === 'saved' ? 'auto' : statusFor(chosen.confidence);
    let reason = chosen.reason;
    if (status === 'auto' && required.has(chosen.target) && (chosen.method === 'fuzzy' || chosen.method === 'values')) {
      status = 'needs_confirmation';
      reason += '; required fields are never auto-mapped from a fuzzy match';
    }
    if (conflicted.has(profile.name)) {
      status = 'needs_confirmation';
      reason += `; another column also looks like "${chosen.target}"`;
    }
    return { sourceField: profile.name, target: chosen.target, confidence: Number(chosen.confidence.toFixed(3)), method: chosen.method, status, reason, alternatives, samples };
  });

  const mapping: Record<string, CanonicalFieldName> = {};
  for (const m of matches) if (m.target && m.status === 'auto') mapping[m.sourceField] = m.target;
  const mappedTargets = new Set(matches.filter((m) => m.target).map((m) => m.target));
  const missingRequired = importType.requiredFields.filter((f) => !mappedTargets.has(f));

  return {
    matches,
    missingRequired,
    conflicts,
    needsConfirmation: missingRequired.length > 0 || matches.some((m) => m.status === 'needs_confirmation'),
    mapping,
    fingerprint: fingerprintFields(profiles.map((p) => p.name)),
  };
}

/**
 * Apply a human's decisions on top of a proposal. Returns the final mapping or the
 * reasons it is still not usable.
 */
export function applyDecisions(
  proposal: MappingProposal,
  decisions: SavedMapping,
  importType: ImportTypeConfig,
): { mapping: Record<string, CanonicalFieldName>; problems: string[] } {
  const mapping: Record<string, CanonicalFieldName> = {};
  for (const m of proposal.matches) {
    const decided = m.sourceField in decisions ? decisions[m.sourceField] : undefined;
    if (decided === null) continue;
    const target = decided ?? (m.status === 'auto' ? m.target : null);
    if (target) mapping[m.sourceField] = target;
  }
  const problems: string[] = [];
  const seen = new Map<CanonicalFieldName, string>();
  for (const [source, target] of Object.entries(mapping)) {
    if (!(CANONICAL_FIELD_NAMES as readonly string[]).includes(target)) problems.push(`"${target}" is not a product field`);
    const other = seen.get(target);
    if (other) problems.push(`"${source}" and "${other}" are both mapped to "${target}"`);
    seen.set(target, source);
  }
  for (const f of importType.requiredFields) if (!seen.has(f)) problems.push(`Required field "${f}" is not mapped`);
  for (const m of proposal.matches) {
    if (m.status === 'needs_confirmation' && !(m.sourceField in decisions)) problems.push(`"${m.sourceField}" still needs a decision`);
  }
  return { mapping, problems };
}

/** Compare field sets between two runs of the same partner. */
export function diffFields(previous: string[], current: string[]): { added: string[]; removed: string[] } {
  const prev = new Set(previous);
  const curr = new Set(current);
  return { added: current.filter((f) => !prev.has(f)), removed: previous.filter((f) => !curr.has(f)) };
}
