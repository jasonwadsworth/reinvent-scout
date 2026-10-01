import type { IndexRecord } from "../catalog/index-record.js";
import type { LevelBandRange } from "../catalog/query.js";
import { ValidationError } from "../core/errors.js";

/** The bands the catalog's own level labels fall in (100 Foundational ... 500 Distinguished). */
export const LEVEL_BANDS: readonly number[] = [100, 200, 300, 400, 500];

export const FORMAT_ACTIONS = ["prefer", "avoid", "exclude"] as const;
export type FormatAction = (typeof FORMAT_ACTIONS)[number];

/** What to do with sessions of one catalog type, optionally only at some levels. */
export interface FormatRule {
  /** A catalog session type; resolved to the catalog's own spelling (any case, or a unique prefix). */
  type: string;
  action: FormatAction;
  /** The rule only applies to sessions in this range. */
  levels?: LevelBandRange | undefined;
}

/** What the user asked of the sessions, applied to every lens, the map and a focus. */
export interface SessionPreferences {
  /** A hard filter, inclusive; a session with no level is left out, as in `catalog search`. */
  levels?: LevelBandRange | undefined;
  /** Applied in order; for a given session the first rule that matches wins. `exclude` removes the session like a level filter;
   * `prefer` and `avoid` only move it, to a tier after the demotion tier and before every other ranking key. */
  formats?: FormatRule[] | undefined;
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

/** A typed type name as the catalog spells it: an exact match in any case, else the one type that starts with it. */
function resolveType(typed: string, known: readonly string[]): string {
  const wanted = typed.trim().toLowerCase();
  const exact = known.find(type => type.toLowerCase() === wanted);
  if (exact !== undefined) return exact;
  const starting = wanted === "" ? [] : known.filter(type => type.toLowerCase().startsWith(wanted));
  if (starting.length === 1) return starting[0]!;
  if (starting.length > 1) {
    throw new ValidationError(`Session type "${typed}" is ambiguous: ${starting.join(", ")}. Use the full name.`);
  }
  throw new ValidationError(`Unknown session type "${typed}". Types in the catalog: ${known.join(", ")}.`);
}

/** The preferences checked against the catalog and spelled the way it spells them; `undefined` when there is nothing to apply. */
export function resolvePreferences(preferences: SessionPreferences | undefined, index: readonly IndexRecord[]): SessionPreferences | undefined {
  if (preferences === undefined) return undefined;
  const levels = preferences.levels === undefined ? undefined : validateLevels(preferences.levels);
  const known = [...new Set(index.flatMap(record => record.type === null ? [] : [record.type]))].sort();
  const formats = (preferences.formats ?? []).map((rule): FormatRule => {
    if (!FORMAT_ACTIONS.includes(rule.action)) {
      throw new ValidationError(`A format rule's action must be one of ${FORMAT_ACTIONS.join(", ")}, got "${String(rule.action)}".`);
    }
    return { type: resolveType(rule.type, known), action: rule.action, ...(rule.levels === undefined ? {} : { levels: validateLevels(rule.levels) }) };
  });
  if (levels === undefined && formats.length === 0) return undefined;
  return { ...(levels === undefined ? {} : { levels }), ...(formats.length === 0 ? {} : { formats }) };
}

/** "400–500", or "300" for a single band: the way a person says it. */
export function describeLevels(levels: LevelBandRange): string {
  return levels.min === levels.max ? String(levels.min) : `${levels.min}–${levels.max}`;
}

const inRange = (band: number | null, range: LevelBandRange): boolean => band !== null && band >= range.min && band <= range.max;

/** The first rule that applies to the session. */
export function ruleFor(preferences: SessionPreferences | undefined, record: IndexRecord): FormatRule | undefined {
  return preferences?.formats?.find(rule => rule.type === record.type && (rule.levels === undefined || inRange(record.levelBand, rule.levels)));
}

/** Whether the session is one the user's preferences leave in. */
export function admits(preferences: SessionPreferences | undefined, record: IndexRecord): boolean {
  if (preferences?.levels !== undefined && !inRange(record.levelBand, preferences.levels)) return false;
  return ruleFor(preferences, record)?.action !== "exclude";
}

/** 1 for a preferred session, -1 for an avoided one, 0 for the rest. */
export function tierOf(preferences: SessionPreferences | undefined, record: IndexRecord): number {
  const action = ruleFor(preferences, record)?.action;
  return action === "prefer" ? 1 : action === "avoid" ? -1 : 0;
}

/** The items with preferred sessions first and avoided ones last, each tier in the order it came in. */
export function byTier<T>(preferences: SessionPreferences | undefined, items: readonly T[], recordOf: (item: T) => IndexRecord): T[] {
  if (preferences?.formats === undefined) return [...items];
  // `sort` is stable, so each tier keeps the order the items came in.
  return items.map(item => ({ item, tier: tierOf(preferences, recordOf(item)) })).sort((a, b) => b.tier - a.tier).map(entry => entry.item);
}

const article = (name: string): string => (/^[aeiou]/i.test(name) ? "an" : "a");

/** Why a session was moved, in the words of the user's own rule; absent when no preference moved it. */
export function formatNote(preferences: SessionPreferences | undefined, record: IndexRecord): string | undefined {
  const rule = ruleFor(preferences, record);
  if (rule === undefined || rule.action === "exclude") return undefined;
  const type = rule.type.toLowerCase();
  return rule.action === "prefer"
    ? `${article(type)} ${type}, which you prefer`
    : `ranked lower: ${article(type)} ${type}, which you asked to avoid${rule.levels === undefined ? "" : ` at ${describeLevels(rule.levels)}`}`;
}

/** The sentence a `why` summary ends with, or the summary itself when no preference moved the session. */
export function annotate(summary: string, note: string | undefined): string {
  return note === undefined ? summary : `${summary.replace(/\.$/, "")} (${note}).`;
}

const GERUNDS: Record<FormatAction, string> = { prefer: "Preferring", avoid: "Avoiding", exclude: "Excluding" };

/** The line that tells the reader a list was restricted or reordered, for the readable output. */
export function describePreferences(preferences: SessionPreferences | undefined): string | undefined {
  const parts: string[] = [];
  if (preferences?.levels !== undefined) parts.push(`Only sessions at level ${describeLevels(preferences.levels)}.`);
  for (const action of FORMAT_ACTIONS) {
    const rules = (preferences?.formats ?? []).filter(rule => rule.action === action);
    if (rules.length > 0) {
      parts.push(`${GERUNDS[action]} ${rules.map(rule => `${rule.type.toLowerCase()}s${rule.levels === undefined ? "" : ` at ${describeLevels(rule.levels)}`}`).join(", ")}.`);
    }
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
  const excluded = (preferences?.formats ?? []).filter(rule => rule.action === "exclude")
    .map(rule => `${rule.type}${rule.levels === undefined ? "" : ` at ${describeLevels(rule.levels)}`}`);
  if (without === 0 || (preferences?.levels === undefined && excluded.length === 0)) return undefined;
  const restriction = [
    ...(preferences?.levels === undefined ? [] : [`at ${describeLevels(preferences.levels)}`]),
    ...(excluded.length === 0 ? [] : [`after excluding ${excluded.join(", ")}`]),
  ].join(" ");
  return `${without} session${without === 1 ? " matches" : "s match"}, none ${restriction}`;
}
