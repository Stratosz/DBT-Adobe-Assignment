// Thin typed client for the ingestion API. Types mirror the API responses the UI reads.

export interface ImportType { id: string; label: string; description: string; requiredFields: string[]; maxErrorRate: number }
export interface Meta {
  importTypes: ImportType[];
  overrideBounds: { min: number; max: number };
  formats: { id: string; label: string; extensions: string[] }[];
  fields: { name: string; type: string; description: string }[];
}
export interface Partner { id: string; name: string; description: string | null; productCount: number; savedMappings: number; locale: { decimalSeparator: string; dateOrder: string; defaultCurrency: string } }

export type RunStatus = 'RECEIVED' | 'AWAITING_MAPPING' | 'PROCESSING' | 'COMMITTED' | 'HELD_FOR_REVIEW' | 'REJECTED' | 'FAILED';

export interface Counts { total: number; accepted: number; acceptedWithWarnings: number; quarantined: number; duplicateSkus: number }
export interface RunSummary { id: string; partnerId: string; importType: string; filename: string | null; format: string | null; status: RunStatus; statusReason: string | null; counts: Counts | null; errorRate: number | null; createdAt: string }

export interface Candidate { target: string; confidence: number; method: string; reason: string }
export interface FieldMatch { sourceField: string; target: string | null; confidence: number; method: string; status: 'auto' | 'needs_confirmation' | 'unmapped' | 'ignored'; reason: string; alternatives: Candidate[]; samples: string[] }
export interface IssueGroup { code: string; severity: 'error' | 'warning' | 'info'; field?: string; sourceField?: string; count: number; title: string; hint: string; samples: string[]; locations: { index: number; line?: number; pointer?: string }[] }

export interface RunDetail extends RunSummary {
  sizeBytes: number;
  policy: { maxErrorRate: number; overridden: boolean; overrideReason: string | null };
  analysis: { format: string | null; detectionMethod: string | null; encoding: string; proposal: { matches: FieldMatch[]; missingRequired: string[]; conflicts: { target: string; sourceFields: string[] }[] } | null } | null;
  drift: { changed: boolean; firstRun: boolean; added?: string[]; removed?: string[] } | null;
  result: { counts: Counts; errorRate: number; maxErrorRate: number; issueGroups: IssueGroup[]; durationMs: number; recordsPerSecond: number; decisionReason: string } | null;
  fatal: { code: string; message: string; hint: string } | null;
  commit: { inserted: number; updated: number; unknownSkus: number } | null;
  mapping: Record<string, string> | null;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly hint?: string, readonly details?: { problems?: string[]; runId?: string }) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const e = body?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'HTTP_ERROR', e.message ?? `Request failed (${res.status})`, e.hint, e.details);
  }
  return body as T;
}

const post = <T>(url: string, body: unknown) => request<T>(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  meta: () => request<Meta>('/api/meta'),
  partners: () => request<Partner[]>('/api/partners'),
  runs: () => request<RunSummary[]>('/api/runs?limit=30'),
  run: (id: string) => request<RunDetail>(`/api/runs/${id}`),
  upload: (form: FormData) => request<RunDetail>('/api/runs', { method: 'POST', body: form }),
  confirmMapping: (id: string, decisions: Record<string, string | null>) => post<RunDetail>(`/api/runs/${id}/mapping`, { decisions, remember: true }),
  approve: (id: string, reason: string) => post<RunDetail>(`/api/runs/${id}/approve`, { reason }),
  reject: (id: string, reason: string) => post<RunDetail>(`/api/runs/${id}/reject`, { reason }),
  quarantineUrl: (id: string) => `/api/runs/${id}/quarantine`,
};
