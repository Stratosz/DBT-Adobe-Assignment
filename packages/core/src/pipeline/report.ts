import { ISSUE_CATALOG, displayValue, type Issue, type IssueCode, type RecordLocation, type Severity } from '../errors.ts';
import type { CanonicalFieldName } from '../schema/canonical.ts';

/**
 * Groups thousands of individual issues into a handful of actionable lines:
 * "412 records: PRICE_UNPARSEABLE in column "VK-Preis" — examples ... — what to do".
 * Keeps counts exact but only a few samples/locations per group, so memory stays bounded.
 */
export interface IssueGroup {
  code: IssueCode;
  severity: Severity;
  field?: CanonicalFieldName | undefined;
  sourceField?: string | undefined;
  count: number;
  title: string;
  hint: string;
  samples: string[];
  locations: RecordLocation[];
}

const MAX_SAMPLES = 5;
const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export class IssueAggregator {
  private groups = new Map<string, Omit<IssueGroup, 'title' | 'hint'>>();

  add(issue: Issue): void {
    const key = `${issue.code}|${issue.severity}|${issue.field ?? ''}|${issue.sourceField ?? ''}`;
    let g = this.groups.get(key);
    if (!g) {
      g = { code: issue.code, severity: issue.severity, field: issue.field, sourceField: issue.sourceField, count: 0, samples: [], locations: [] };
      this.groups.set(key, g);
    }
    g.count++;
    if (issue.value !== undefined && g.samples.length < MAX_SAMPLES) {
      const v = displayValue(issue.value, 40);
      if (!g.samples.includes(v)) g.samples.push(v);
    }
    if (issue.location && g.locations.length < MAX_SAMPLES) g.locations.push(issue.location);
  }

  result(): IssueGroup[] {
    return [...this.groups.values()]
      .map((g) => {
        const def = ISSUE_CATALOG[g.code];
        return { ...g, title: def.title, hint: def.hint({ field: g.field, sourceField: g.sourceField, samples: g.samples, count: g.count }) };
      })
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count);
  }
}

export function describeLocation(loc: RecordLocation | undefined): string {
  if (!loc) return '';
  if (loc.line !== undefined) return `line ${loc.line}`;
  if (loc.pointer) return loc.pointer;
  return `record ${loc.index + 1}`;
}
