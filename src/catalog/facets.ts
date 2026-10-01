import type { IndexRecord } from "./index-record.js";

/** The catalog fields a session can be asked for by value, in the words a person uses. */
export const FACET_FIELDS = ["format", "venue", "day", "topic", "area", "industry", "role"] as const;
export type FacetField = (typeof FACET_FIELDS)[number];

/** Where each field lives in the catalog's own index. */
const FIELD_VALUES: Record<FacetField, (record: IndexRecord) => readonly string[]> = {
  format: record => (record.type === null ? [] : [record.type]),
  venue: record => (record.venue === null ? [] : [record.venue]),
  day: record => (record.startDate === null ? [] : [record.startDate]),
  topic: record => record.topics,
  area: record => record.areasOfInterest,
  industry: record => record.industries,
  role: record => record.roles,
};

/** The values of a field a session has. */
export function valuesOf(field: FacetField, record: IndexRecord): readonly string[] {
  return FIELD_VALUES[field](record);
}

