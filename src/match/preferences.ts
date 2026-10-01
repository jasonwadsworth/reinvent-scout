import type { IndexRecord } from "../catalog/index-record.js";
import type { LevelBandRange } from "../catalog/query.js";
import { FACET_FIELDS, valuesOf, type FacetField } from "../catalog/facets.js";
import { ValidationError } from "../core/errors.js";

/** The bands the catalog's own level labels fall in (100 Foundational ... 500 Distinguished). */
export const LEVEL_BANDS: readonly number[] = [100, 200, 300, 400, 500];

export { FACET_FIELDS, valuesOf, type FacetField } from "../catalog/facets.js";
export const FACET_ACTIONS = ["only", "prefer", "avoid", "exclude"] as const;
export type FacetAction = (typeof FACET_ACTIONS)[number];

/** What to do with sessions that have one value of one catalog field, optionally only at some levels. */
export interface FacetRule {
  field: FacetField;
  /** A value of the field's catalog vocabulary; resolved to the catalog's own spelling (any case, or a unique prefix). */
  value: string;
  action: FacetAction;
  /** The rule only applies to sessions in this range. */
  levels?: LevelBandRange | undefined;
}

/** What the user asked of the sessions, applied to every lens, the map and a focus. */
export interface SessionPreferences {
  /** A hard filter, inclusive; a session with no level is left out, as in `catalog search`. */
  levels?: LevelBandRange | undefined;
  /**
   * `only` keeps just the sessions with the value (several on one field are a union, different fields an intersection; a session with
   * no value for that field is left out), `exclude` removes them. `prefer` and `avoid` only move a session, to a tier after the demotion
   * partition and before every other ranking key: within one field the first matching rule decides, across fields the effects add up.
   */
  rules?: FacetRule[] | undefined;
}

/** The introductory bands `explain` and `understand` are for. */
const INTRODUCTORY: LevelBandRange = { min: 100, max: 200 };

export function validateLevels(levels: LevelBandRange): LevelBandRange {
  const { min, max } = levels;
  if (!LEVEL_BANDS.includes(min) || !LEVEL_BANDS.includes(max)) {
    throw new ValidationError(`levels must be bands of ${LEVEL_BANDS.join(", ")}, got ${min} to ${max}.`);
  }
  if (min > max) {
    throw new ValidationError(`levels min must not be above max, got ${min} to ${max}.`);
  }
  return { min, max };
}

const FIELD_NAMES: Record<FacetField, string> = {
  format: "format", venue: "venue", day: "day", topic: "topic", area: "area of interest", industry: "industry", role: "role",
};

/** A field's vocabulary in the catalog: each value once, the ones most sessions have first. */
export function vocabularyOf(field: FacetField, index: readonly IndexRecord[]): string[] {
  const counts = new Map<string, number>();
  for (const record of index) for (const value of new Set(valuesOf(field, record))) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value]) => value);
}

const SHOWN_VALUES = 12;

/** A typed value as the catalog spells it: an exact match in any case, else the one value that starts with it. */
function resolveValue(field: FacetField, typed: string, known: readonly string[]): string {
  const wanted = typed.trim().toLowerCase();
  const name = FIELD_NAMES[field];
  const exact = known.find(value => value.toLowerCase() === wanted);
  if (exact !== undefined) return exact;
  const starting = wanted === "" ? [] : known.filter(value => value.toLowerCase().startsWith(wanted));
  if (starting.length === 1) return starting[0]!;
  if (starting.length > 1) {
    throw new ValidationError(`The ${name} "${typed}" is ambiguous: ${starting.slice(0, SHOWN_VALUES).join(", ")}. Use the full name.`);
  }
  const near = wanted === "" ? [] : known.filter(value => value.toLowerCase().includes(wanted));
  const closest = (near.length > 0 ? near : known).slice(0, SHOWN_VALUES);
  throw new ValidationError(`Unknown ${name} "${typed}". ${near.length > 0 ? "Closest values" : "Values in the catalog"}: ${closest.join(", ")}${closest.length < known.length && near.length === 0 ? ", ..." : ""} (\`list_filters\` lists them all).`);
}

/** The preferences checked against the catalog and spelled the way it spells them; `undefined` when there is nothing to apply. */
export function resolvePreferences(preferences: SessionPreferences | undefined, index: readonly IndexRecord[]): SessionPreferences | undefined {
  if (preferences === undefined) return undefined;
  const levels = preferences.levels === undefined ? undefined : validateLevels(preferences.levels);
  const vocabularies = new Map<FacetField, string[]>();
  const rules = (preferences.rules ?? []).map((rule): FacetRule => {
    if (!FACET_FIELDS.includes(rule.field)) {
      throw new ValidationError(`A rule's field must be one of ${FACET_FIELDS.join(", ")}, got "${String(rule.field)}".`);
    }
    if (!FACET_ACTIONS.includes(rule.action)) {
      throw new ValidationError(`A rule's action must be one of ${FACET_ACTIONS.join(", ")}, got "${String(rule.action)}".`);
    }
    if (!vocabularies.has(rule.field)) vocabularies.set(rule.field, vocabularyOf(rule.field, index));
    return { field: rule.field, value: resolveValue(rule.field, rule.value, vocabularies.get(rule.field)!), action: rule.action, ...(rule.levels === undefined ? {} : { levels: validateLevels(rule.levels) }) };
  });
  if (levels === undefined && rules.length === 0) return undefined;
  return { ...(levels === undefined ? {} : { levels }), ...(rules.length === 0 ? {} : { rules }) };
}

/** "400–500", or "300" for a single band: the way a person says it. */
export function describeLevels(levels: LevelBandRange): string {
  return levels.min === levels.max ? String(levels.min) : `${levels.min}–${levels.max}`;
}

const inRange = (band: number | null, range: LevelBandRange): boolean => band !== null && band >= range.min && band <= range.max;

/** Whether the rule is about this session: its level range holds the session, and one of the session's values is the rule's. */
const appliesTo = (rule: FacetRule, record: IndexRecord): boolean => rule.levels === undefined || inRange(record.levelBand, rule.levels);
const matches = (rule: FacetRule, record: IndexRecord): boolean => appliesTo(rule, record) && valuesOf(rule.field, record).includes(rule.value);

/** Whether the session is one the user's preferences leave in. */
export function admits(preferences: SessionPreferences | undefined, record: IndexRecord): boolean {
  if (preferences?.levels !== undefined && !inRange(record.levelBand, preferences.levels)) return false;
  const rules = preferences?.rules ?? [];
  if (rules.some(rule => rule.action === "exclude" && matches(rule, record))) return false;
  // Every field with an `only` rule that is about this session must have one of them match: a union within a field, an intersection across fields.
  return FACET_FIELDS.every(field => {
    const only = rules.filter(rule => rule.field === field && rule.action === "only" && appliesTo(rule, record));
    return only.length === 0 || only.some(rule => matches(rule, record));
  });
}

/** The rule that moves the session on a field: the first prefer or avoid rule that is about it. */
function movers(preferences: SessionPreferences | undefined, record: IndexRecord): FacetRule[] {
  const rules = preferences?.rules ?? [];
  return FACET_FIELDS.flatMap(field => {
    const first = rules.find(rule => rule.field === field && (rule.action === "prefer" || rule.action === "avoid") && matches(rule, record));
    return first === undefined ? [] : [first];
  });
}

/** How far the user's preferences move the session: +1 for each field that prefers it, -1 for each that avoids it. */
export function tierOf(preferences: SessionPreferences | undefined, record: IndexRecord): number {
  return movers(preferences, record).reduce((sum, rule) => sum + (rule.action === "prefer" ? 1 : -1), 0);
}

/** The items with the most preferred sessions first and the most avoided last, each tier in the order it came in. */
export function byTier<T>(preferences: SessionPreferences | undefined, items: readonly T[], recordOf: (item: T) => IndexRecord): T[] {
  if (preferences?.rules === undefined) return [...items];
  // `sort` is stable, so each tier keeps the order the items came in.
  return items.map(item => ({ item, tier: tierOf(preferences, recordOf(item)) })).sort((a, b) => b.tier - a.tier).map(entry => entry.item);
}

const article = (name: string): string => (/^[aeiou]/i.test(name) ? "an" : "a");

/** How a rule's value reads in a sentence about a session: "a chalk talk", "at MGM Grand", "on 2026-12-03", "about Serverless". */
function phrase(rule: FacetRule): string {
  switch (rule.field) {
    case "format": return `${article(rule.value)} ${rule.value.toLowerCase()}`;
    case "venue": return `at ${rule.value}`;
    case "day": return `on ${rule.value}`;
    case "topic": return `about ${rule.value}`;
    case "area": return `in ${rule.value}`;
    case "industry": return `for ${rule.value}`;
    case "role": return `for ${rule.value}`;
  }
}

/** Why a session was moved, in the words of the user's own rules, every one that moved it; absent when none did. */
export function formatNote(preferences: SessionPreferences | undefined, record: IndexRecord): string | undefined {
  const moving = movers(preferences, record);
  const preferred = moving.filter(rule => rule.action === "prefer");
  const avoided = moving.filter(rule => rule.action === "avoid");
  const notes = [
    ...(preferred.length === 0 ? [] : [`${preferred.map(phrase).join(" ")}, which you prefer`]),
    ...(avoided.length === 0 ? [] : [`ranked lower: ${avoided.map(phrase).join(" ")}, which you asked to avoid${avoided.find(rule => rule.levels !== undefined)?.levels === undefined ? "" : ` at ${describeLevels(avoided.find(rule => rule.levels !== undefined)!.levels!)}`}`]),
  ];
  return notes.length === 0 ? undefined : notes.join("; ");
}

/** The sentence a `why` summary ends with, or the summary itself when no preference moved the session. */
export function annotate(summary: string, note: string | undefined): string {
  return note === undefined ? summary : `${summary.replace(/\.$/, "")} (${note}).`;
}

const GERUNDS: Record<FacetAction, string> = { only: "Only", prefer: "Preferring", avoid: "Avoiding", exclude: "Excluding" };

/** A rule's value as a short noun phrase for the readable line: "chalk talks", "venue MGM Grand". */
function named(rule: FacetRule): string {
  const where = rule.levels === undefined ? "" : ` at ${describeLevels(rule.levels)}`;
  return `${rule.field === "format" ? `${rule.value.toLowerCase()}s` : `${rule.field} ${rule.value}`}${where}`;
}

/** A rule's value as it is said when naming what emptied a result: "Workshop", "venue MGM Grand". */
function plain(rule: FacetRule): string {
  return `${rule.field === "format" ? rule.value : `${rule.field} ${rule.value}`}${rule.levels === undefined ? "" : ` at ${describeLevels(rule.levels)}`}`;
}

/** The line that tells the reader a list was restricted or reordered, for the readable output. */
export function describePreferences(preferences: SessionPreferences | undefined): string | undefined {
  const parts: string[] = [];
  if (preferences?.levels !== undefined) parts.push(`Only sessions at level ${describeLevels(preferences.levels)}.`);
  for (const action of FACET_ACTIONS) {
    const rules = (preferences?.rules ?? []).filter(rule => rule.action === action);
    if (rules.length > 0) parts.push(`${GERUNDS[action]} ${rules.map(named).join(", ")}.`);
  }
  return parts.length === 0 ? undefined : parts.join(" ");
}

/** Whether any introductory (100/200) session can pass the level preference. */
export function allowsIntroductory(preferences: SessionPreferences | undefined): boolean {
  const levels = preferences?.levels;
  return levels === undefined || (levels.min <= INTRODUCTORY.max && levels.max >= INTRODUCTORY.min);
}

/** Whether the level preference leaves sessions of this band in. */
export function allowsBand(preferences: SessionPreferences | undefined, band: number): boolean {
  const levels = preferences?.levels;
  return levels === undefined || (band >= levels.min && band <= levels.max);
}

export const INTRODUCTORY_LABEL = describeLevels(INTRODUCTORY);

/** Why an introductory-only goal has nothing under the preferences. */
export function introductoryRefusal(subject: string, preferences: SessionPreferences, alternatives: string): string {
  return `${subject} lists introductory (${INTRODUCTORY_LABEL}) sessions, which is outside ${describeLevels(preferences.levels!)}; use ${alternatives}`;
}

/** What the preferences emptied, when the same result would not be empty without them: "4 sessions match, none at 400–500". */
export function emptiedBy(preferences: SessionPreferences | undefined, without: number): string | undefined {
  const rules = preferences?.rules ?? [];
  const only = rules.filter(rule => rule.action === "only").map(plain);
  const excluded = rules.filter(rule => rule.action === "exclude").map(plain);
  if (without === 0 || (preferences?.levels === undefined && only.length === 0 && excluded.length === 0)) return undefined;
  const restriction = [
    ...(preferences?.levels === undefined ? [] : [`at ${describeLevels(preferences.levels)}`]),
    ...(only.length === 0 ? [] : [`with ${only.join(" or ")}`]),
    ...(excluded.length === 0 ? [] : [`after excluding ${excluded.join(", ")}`]),
  ].join(" ");
  return `${without} session${without === 1 ? " matches" : "s match"}, none ${restriction}`;
}
