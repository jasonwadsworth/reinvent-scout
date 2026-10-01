import type { IndexRecord } from "../catalog/index-record.js";
import type { LevelBandRange } from "../catalog/query.js";
import { ValidationError } from "../core/errors.js";

/** The bands the catalog's own level labels fall in (100 Foundational ... 500 Distinguished). */
export const LEVEL_BANDS: readonly number[] = [100, 200, 300, 400, 500];

/** What the user asked of the sessions, applied to every lens, the map and a focus. */
export interface SessionPreferences {
  /** A hard filter, inclusive; a session with no level is left out, as in `catalog search`. */
  levels?: LevelBandRange | undefined;
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

/** The preferences as given, checked; `undefined` when there is nothing to apply. */
export function validatePreferences(preferences: SessionPreferences | undefined): SessionPreferences | undefined {
  if (preferences === undefined) return undefined;
  const levels = preferences.levels === undefined ? undefined : validateLevels(preferences.levels);
  return levels === undefined ? undefined : { levels };
}

/** "400–500", or "300" for a single band: the way a person says it. */
export function describeLevels(levels: LevelBandRange): string {
  return levels.min === levels.max ? String(levels.min) : `${levels.min}–${levels.max}`;
}

/** The line that tells the reader a list was restricted, for the readable output. */
export function describePreferences(preferences: SessionPreferences | undefined): string | undefined {
  return preferences?.levels === undefined ? undefined : `Only sessions at level ${describeLevels(preferences.levels)}.`;
}

/** Whether the session is one the user's preferences leave in. */
export function admits(preferences: SessionPreferences | undefined, record: IndexRecord): boolean {
  const levels = preferences?.levels;
  if (levels === undefined) return true;
  return record.levelBand !== null && record.levelBand >= levels.min && record.levelBand <= levels.max;
}

/** Whether the preferences leave sessions of this band in. */
export function allowsBand(preferences: SessionPreferences | undefined, band: number): boolean {
  const levels = preferences?.levels;
  return levels === undefined || (band >= levels.min && band <= levels.max);
}

/** Whether any introductory (100/200) session can pass the preferences. */
export function allowsIntroductory(preferences: SessionPreferences | undefined): boolean {
  const levels = preferences?.levels;
  return levels === undefined || (levels.min <= INTRODUCTORY.max && levels.max >= INTRODUCTORY.min);
}

export const INTRODUCTORY_LABEL = describeLevels(INTRODUCTORY);

/** Why an introductory-only goal has nothing under the preferences. */
export function introductoryRefusal(subject: string, preferences: SessionPreferences, alternatives: string): string {
  return `${subject} lists introductory (${INTRODUCTORY_LABEL}) sessions, which is outside ${describeLevels(preferences.levels!)}; use ${alternatives}`;
}

/** What the preferences emptied, when the same result would not be empty without them: "4 sessions match, none at 400–500". */
export function emptiedBy(preferences: SessionPreferences | undefined, without: number): string | undefined {
  if (preferences?.levels === undefined || without === 0) return undefined;
  return `${without} session${without === 1 ? " matches" : "s match"}, none at ${describeLevels(preferences.levels)}`;
}
