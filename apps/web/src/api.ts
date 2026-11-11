// Thin typed client for the ingestion API. Types mirror the API responses the UI reads.

export interface ImportType {
  id: string;
  label: string;
  description: string;
  requiredFields: string[];
  maxErrorRate: number;
  minQuarantinedToHold: number;
  maxPriceChange: number | null;
}
export interface Meta {
  importTypes: ImportType[];
  overrideBounds: { min: number; max: number };
  formats: { id: string; label: string; extensions: string[] }[];
  fields: { name: string; type: string; description: string }[];
}
export interface Partner {
  id: string;
  name: string;
  description: string | null;
  productCount: number;
  savedMappings: number;
  locale: { decimalSeparator: string; dateOrder: string; defaultCurrency: string };
}
export type Role = 'uploader' | 'reviewer' | 'admin';
export interface Me {
  id: string;
  name: string;
  role: Role;
}

export type RunStatus = 'RECEIVED' | 'AWAITING_MAPPING' | 'QUEUED' | 'PROCESSING' | 'COMMITTED' | 'HELD_FOR_REVIEW' | 'REJECTED' | 'FAILED';
export const IN_FLIGHT: RunStatus[] = ['RECEIVED', 'QUEUED', 'PROCESSING'];

export interface Counts {
  total: number;
  accepted: number;
  acceptedWithWarnings: number;
  quarantined: number;
  duplicateSkus: number;
  skippedStale?: number;
  flaggedForReview?: number;
}
export interface RunSummary {
  id: string;
  partnerId: string;
  importType: string;
  filename: string | null;
  format: string | null;
  status: RunStatus;
  statusReason: string | null;
  counts: Counts | null;
  errorRate: number | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Candidate {
  target: string;
  confidence: number;
  method: string;
  reason: string;
}
export interface FieldMatch {
  sourceField: string;
  target: string | null;
  confidence: number;
  method: string;
  status: 'auto' | 'needs_confirmation' | 'unmapped' | 'ignored';
  reason: string;
  alternatives: Candidate[];
  samples: string[];
}
export interface IssueGroup {
  code: string;
  severity: 'error' | 'warning' | 'info';
  field?: string;
  sourceField?: string;
  count: number;
  title: string;
  hint: string;
  samples: string[];
  locations: { index: number; line?: number; pointer?: string }[];
}
export interface AuditEvent {
  id: number;
  at: string;
  actorId: string;
  actorRole: Role;
  action: string;
  runId: string | null;
  partnerId: string | null;
  details: Record<string, unknown> | null;
}
export interface SavedMappingRow {
  sourceField: string;
  target: string | null;
  decidedAt: string;
  decidedInRun: string | null;
  decidedBy: string | null;
}

export interface RunDetail extends RunSummary {
  sizeBytes: number;
  attempts: number;
  policy: { maxErrorRate: number; overridden: boolean; overrideReason: string | null };
  analysis: {
    format: string | null;
    detectionMethod: string | null;
    encoding: string;
    proposal: { matches: FieldMatch[]; missingRequired: string[]; conflicts: { target: string; sourceFields: string[] }[] } | null;
  } | null;
  drift: { changed: boolean; firstRun: boolean; added?: string[]; removed?: string[] } | null;
  result: {
    counts: Counts;
    errorRate: number;
    maxErrorRate: number;
    issueGroups: IssueGroup[];
    durationMs: number;
    recordsPerSecond: number;
    decisionReason: string;
    holdReasons?: string[];
  } | null;
  fatal: { code: string; message: string; hint: string } | null;
  commit: { inserted: number; updated: number; unknownSkus: number; skippedStale?: number } | null;
  mapping: Record<string, string> | null;
  audit: AuditEvent[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly details?: { problems?: string[]; runId?: string },
  ) {
    super(message);
  }
}

// The key lives in sessionStorage (cleared when the tab closes). Storage can throw in some
// contexts, so fall back to memory.
const KEY_STORAGE = 'feed-intake-api-key';
let memoryKey: string | null = null;
export const session = {
  get(): string | null {
    try {
      return sessionStorage.getItem(KEY_STORAGE) ?? memoryKey;
    } catch {
      return memoryKey;
    }
  },
  set(key: string | null) {
    memoryKey = key;
    try {
      if (key) sessionStorage.setItem(KEY_STORAGE, key);
      else sessionStorage.removeItem(KEY_STORAGE);
    } catch {
      /* memory only */
    }
  },
};

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const key = session.get();
  const headers = new Headers(init.headers);
  if (key) headers.set('authorization', `Bearer ${key}`);
  const res = await fetch(url, { ...init, headers });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const e = body?.error ?? {};
    if (res.status === 401) onUnauthorized();
    throw new ApiError(res.status, e.code ?? 'HTTP_ERROR', e.message ?? `Request failed (${res.status})`, e.hint, e.details);
  }
  return body as T;
}

const send = <T>(method: string, url: string, body: unknown) =>
  request<T>(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  me: () => request<Me>('/api/me'),
  meta: () => request<Meta>('/api/meta'),
  partners: () => request<Partner[]>('/api/partners'),
  runs: () => request<RunSummary[]>('/api/runs?limit=30'),
  run: (id: string) => request<RunDetail>(`/api/runs/${id}`),
  upload: (form: FormData) => request<RunDetail>('/api/runs', { method: 'POST', body: form }),
  confirmMapping: (id: string, decisions: Record<string, string | null>) => send<RunDetail>('POST', `/api/runs/${id}/mapping`, { decisions, remember: true }),
  approve: (id: string, reason: string) => send<RunDetail>('POST', `/api/runs/${id}/approve`, { reason }),
  reject: (id: string, reason: string) => send<RunDetail>('POST', `/api/runs/${id}/reject`, { reason }),
  mappings: (partnerId: string) => request<SavedMappingRow[]>(`/api/partners/${partnerId}/mappings`),
  setMapping: (partnerId: string, sourceField: string, target: string | null) =>
    send<SavedMappingRow[]>('PUT', `/api/partners/${partnerId}/mappings/${encodeURIComponent(sourceField)}`, { target }),
  deleteMapping: (partnerId: string, sourceField: string) =>
    request<SavedMappingRow[]>(`/api/partners/${partnerId}/mappings/${encodeURIComponent(sourceField)}`, { method: 'DELETE' }),
  audit: (partnerId: string) => request<AuditEvent[]>(`/api/audit?partnerId=${partnerId}&limit=50`),
  /** Downloads need the auth header, so fetch as a blob instead of a plain link. */
  async downloadQuarantine(id: string) {
    const res = await fetch(`/api/runs/${id}/quarantine`, { headers: { authorization: `Bearer ${session.get() ?? ''}` } });
    if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD_FAILED', 'Download failed');
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'quarantine';
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

export const ROLE_RANK: Record<Role, number> = { uploader: 0, reviewer: 1, admin: 2 };
export const can = (me: Me | null, role: Role) => !!me && ROLE_RANK[me.role] >= ROLE_RANK[role];
