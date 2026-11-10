import type { CanonicalFieldName } from './canonical.ts';

/**
 * Import types are configuration, not code. Each one says which fields must be present,
 * which fields it is allowed to write, and how much bad data it tolerates before the run
 * is held for review instead of committed.
 *
 * The threshold protects the catalog from a broken export (e.g. a partner's ERP emits a
 * file where every price is empty): we would rather hold the whole file than half-apply it.
 */
export interface ImportTypeConfig {
  id: ImportTypeId;
  label: string;
  description: string;
  requiredFields: CanonicalFieldName[];
  /** Fields this import type may write. Anything else mapped is ignored (reported as info). */
  writableFields: CanonicalFieldName[];
  /** Max share of records that may be quarantined (0..1) before the run is HELD_FOR_REVIEW. */
  maxErrorRate: number;
}

export const IMPORT_TYPE_IDS = ['full_catalog', 'price_update', 'inventory_update'] as const;
export type ImportTypeId = (typeof IMPORT_TYPE_IDS)[number];

export const IMPORT_TYPES: Record<ImportTypeId, ImportTypeConfig> = {
  full_catalog: {
    id: 'full_catalog',
    label: 'Full catalog',
    description: 'Complete product data. Upserts products; never deletes products missing from the file.',
    requiredFields: ['sku', 'name', 'price'],
    writableFields: ['sku', 'name', 'price', 'currency', 'quantity', 'availability', 'gtin', 'brand', 'category', 'url', 'updated_at'],
    maxErrorRate: 0.05,
  },
  price_update: {
    id: 'price_update',
    label: 'Price update',
    description: 'Price changes only. Strict threshold: wrong prices cost money.',
    requiredFields: ['sku', 'price'],
    writableFields: ['sku', 'price', 'currency', 'updated_at'],
    maxErrorRate: 0.02,
  },
  inventory_update: {
    id: 'inventory_update',
    label: 'Inventory update',
    description: 'Stock levels only. More tolerant: stale stock self-corrects on the next feed.',
    requiredFields: ['sku', 'quantity'],
    writableFields: ['sku', 'quantity', 'availability', 'updated_at'],
    maxErrorRate: 0.1,
  },
};

/** Bounds for a per-upload override, so a user cannot accidentally disable the safety net. */
export const ERROR_RATE_OVERRIDE_BOUNDS = { min: 0, max: 0.5 } as const;

export interface ResolvedPolicy {
  importType: ImportTypeConfig;
  maxErrorRate: number;
  overridden: boolean;
  overrideReason: string | null;
}

export class PolicyError extends Error {}

export function resolvePolicy(
  importTypeId: string,
  override?: { maxErrorRate?: number | null; reason?: string | null },
): ResolvedPolicy {
  const importType = IMPORT_TYPES[importTypeId as ImportTypeId];
  if (!importType) {
    throw new PolicyError(`Unknown import type "${importTypeId}". Expected one of: ${IMPORT_TYPE_IDS.join(', ')}`);
  }
  const value = override?.maxErrorRate;
  if (value === undefined || value === null) {
    return { importType, maxErrorRate: importType.maxErrorRate, overridden: false, overrideReason: null };
  }
  if (!Number.isFinite(value) || value < ERROR_RATE_OVERRIDE_BOUNDS.min || value > ERROR_RATE_OVERRIDE_BOUNDS.max) {
    throw new PolicyError(
      `Error-rate override ${value} is out of bounds [${ERROR_RATE_OVERRIDE_BOUNDS.min}, ${ERROR_RATE_OVERRIDE_BOUNDS.max}]`,
    );
  }
  const reason = override?.reason?.trim();
  if (!reason) {
    throw new PolicyError('An error-rate override needs a reason (it is stored on the run for audit)');
  }
  return { importType, maxErrorRate: value, overridden: true, overrideReason: reason };
}
