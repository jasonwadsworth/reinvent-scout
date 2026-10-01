import { ValidationError } from "../core/errors.js";
import { FACET_FIELDS, valuesOf } from "./facets.js";
import { baseSessionCode, requireCurrentIndex } from "./query.js";
import type { CatalogStoreDeps } from "./store.js";

export const FILTER_FIELDS = ["level", ...FACET_FIELDS] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

export interface FilterValue {
  value: string;
  /** How many distinct talks have it; a repeat of one talk counts once. */
  count: number;
}

export interface FieldValues {
  /** How many distinct values the field has. */
  total: number;
  values: FilterValue[];
  /** How many values were left out by `limit`. */
  more?: number;
}

export interface CatalogFilters {
  fields: Partial<Record<FilterField, FieldValues>>;
}

export interface ListFiltersOptions {
  /** One field only. */
  field?: string;
  /** At most this many values per field, the ones with most sessions first. */
  limit?: number;
}

/**
 * The values a person can filter or prefer on, for each field of the catalog, with how many talks have each. Read-only and local: it needs
 * no profile and no sign-in. Values of the fields a rule can name come back most sessions first; levels come back in order.
 */
export function listFilters(deps: CatalogStoreDeps, options: ListFiltersOptions = {}): CatalogFilters {
  const named = FILTER_FIELDS.find(field => field === options.field);
  if (options.field !== undefined && named === undefined) {
    throw new ValidationError(`Unknown field "${options.field}". Fields: ${FILTER_FIELDS.join(", ")}.`);
  }
  const wanted: readonly FilterField[] = named === undefined ? FILTER_FIELDS : [named];
  const index = requireCurrentIndex(deps);
  const fields: CatalogFilters["fields"] = {};
  for (const field of wanted) {
    // Per talk, the set of values any of its sittings has.
    const talks = new Map<string, Set<string>>();
    for (const record of index) {
      const code = baseSessionCode(record);
      const seen = talks.get(code) ?? new Set<string>();
      for (const value of field === "level" ? (record.levelBand === null ? [] : [String(record.levelBand)]) : valuesOf(field, record)) seen.add(value);
      talks.set(code, seen);
    }
    const counts = new Map<string, number>();
    for (const seen of talks.values()) for (const value of seen) counts.set(value, (counts.get(value) ?? 0) + 1);
    const all = [...counts.entries()]
      .sort((a, b) => (field === "level" ? Number(a[0]) - Number(b[0]) : b[1] - a[1] || a[0].localeCompare(b[0])))
      .map(([value, count]) => ({ value, count }));
    const values = options.limit === undefined ? all : all.slice(0, options.limit);
    fields[field] = { total: all.length, values, ...(values.length < all.length ? { more: all.length - values.length } : {}) };
  }
  return { fields };
}
