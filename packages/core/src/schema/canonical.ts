import { z } from 'zod';

/**
 * The canonical product model every partner feed is normalized into.
 *
 * `aliases` are header names we have seen in the wild (or expect to). They feed the
 * mapper's exact-alias step and the fuzzy similarity step. Adding an alias here is the
 * cheapest way to teach the system about a new partner's naming.
 */
export type FieldType =
  | 'string'
  | 'decimal'
  | 'integer'
  | 'currency'
  | 'gtin'
  | 'availability'
  | 'url'
  | 'datetime';

export interface CanonicalField {
  name: CanonicalFieldName;
  type: FieldType;
  description: string;
  aliases: string[];
}

export const CANONICAL_FIELD_NAMES = [
  'sku',
  'name',
  'price',
  'currency',
  'quantity',
  'availability',
  'gtin',
  'brand',
  'category',
  'url',
  'updated_at',
] as const;

export type CanonicalFieldName = (typeof CANONICAL_FIELD_NAMES)[number];

export const CANONICAL_FIELDS: Record<CanonicalFieldName, CanonicalField> = {
  sku: {
    name: 'sku',
    type: 'string',
    description: 'Partner stock keeping unit; unique per partner',
    aliases: ['sku', 'product_id', 'item_code', 'item_id', 'article_number', 'artikelnummer', 'product_code', 'part_number', 'style_code', 'item_number', 'sku_code'],
  },
  name: {
    name: 'name',
    type: 'string',
    description: 'Display name / title',
    aliases: ['name', 'title', 'product_name', 'item_name', 'product_title', 'bezeichnung', 'item_title'],
  },
  price: {
    name: 'price',
    type: 'decimal',
    description: 'Unit selling price, major currency units',
    aliases: ['price', 'unit_price', 'retail_price', 'list_price', 'sale_price', 'selling_price', 'price_amount', 'amount', 'preis', 'pricing_amount'],
  },
  currency: {
    name: 'currency',
    type: 'currency',
    description: 'ISO 4217 currency code',
    aliases: ['currency', 'currency_code', 'curr', 'ccy', 'waehrung', 'price_currency', 'pricing_currency'],
  },
  quantity: {
    name: 'quantity',
    type: 'integer',
    description: 'Units in stock (>= 0)',
    aliases: ['quantity', 'qty', 'stock', 'stock_qty', 'stock_quantity', 'inventory', 'on_hand', 'available_qty', 'stock_level', 'bestand', 'inventory_qty'],
  },
  availability: {
    name: 'availability',
    type: 'availability',
    description: 'in_stock | out_of_stock | preorder | discontinued',
    aliases: ['availability', 'in_stock', 'stock_status', 'avail', 'availability_status', 'verfuegbarkeit', 'lieferstatus'],
  },
  gtin: {
    name: 'gtin',
    type: 'gtin',
    description: 'GTIN-8/12/13/14 (EAN/UPC) with valid check digit',
    aliases: ['gtin', 'ean', 'upc', 'barcode', 'ean13', 'gtin13', 'ean_code'],
  },
  brand: {
    name: 'brand',
    type: 'string',
    description: 'Brand / manufacturer',
    aliases: ['brand', 'manufacturer', 'vendor', 'marke', 'brand_name', 'hersteller'],
  },
  category: {
    name: 'category',
    type: 'string',
    description: 'Category path, ">"-separated',
    aliases: ['category', 'product_type', 'categories', 'department', 'kategorie', 'category_path'],
  },
  url: {
    name: 'url',
    type: 'url',
    description: 'Product page URL (http/https)',
    aliases: ['url', 'link', 'product_url', 'permalink', 'product_link', 'web_url'],
  },
  updated_at: {
    name: 'updated_at',
    type: 'datetime',
    description: 'Last modification time at the source (ISO 8601, UTC)',
    aliases: ['updated_at', 'last_modified', 'modified', 'updated', 'last_updated', 'modified_at', 'timestamp', 'changed_at', 'geaendert_am', 'aktualisiert', 'letzte_aenderung'],
  },
};

export const AVAILABILITY_VALUES = ['in_stock', 'out_of_stock', 'preorder', 'discontinued'] as const;
export type Availability = (typeof AVAILABILITY_VALUES)[number];

/**
 * Shape of a normalized product. All non-sku fields are nullable because import types
 * only require a subset (e.g. an inventory update carries sku + quantity only).
 * Business rules (non-negative, ISO currency, etc.) are enforced by the normalizers;
 * this schema is the final type guard before anything is persisted.
 */
export const NormalizedProductSchema = z.object({
  sku: z.string().min(1).max(128),
  name: z.string().min(1).nullable(),
  price: z.number().nonnegative().finite().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  quantity: z.number().int().nonnegative().nullable(),
  availability: z.enum(AVAILABILITY_VALUES).nullable(),
  gtin: z.string().regex(/^\d{8}$|^\d{12,14}$/).nullable(),
  brand: z.string().nullable(),
  category: z.string().nullable(),
  url: z.string().url().nullable(),
  updated_at: z.string().datetime().nullable(),
});

export type NormalizedProduct = z.infer<typeof NormalizedProductSchema>;

export function emptyProduct(sku: string): NormalizedProduct {
  return {
    sku,
    name: null,
    price: null,
    currency: null,
    quantity: null,
    availability: null,
    gtin: null,
    brand: null,
    category: null,
    url: null,
    updated_at: null,
  };
}
