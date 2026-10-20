import { ValidationError } from "../core/errors.js";

export const MAX_RESERVATION_IDS = 50;
export const MAX_SESSION_ID_LENGTH = 128;

/** Checks the ids `plan_schedule` is given: 0–50, each 1–128 characters after trimming.
 * Returns them trimmed and de-duplicated. */
export function validateSessionIds(input: readonly string[]): string[] {
  // Trim first: a padded ID would otherwise pass the checks and be used as-is.
  const trimmed = input.map(id => typeof id === "string" ? id.trim() : id);
  if (trimmed.length > MAX_RESERVATION_IDS || trimmed.some(id => typeof id !== "string" || id.length === 0 || Array.from(id).length > MAX_SESSION_ID_LENGTH)) {
    throw new ValidationError(`Expected 0–${MAX_RESERVATION_IDS} session IDs, each 1–${MAX_SESSION_ID_LENGTH} characters.`);
  }
  return [...new Set(trimmed)];
}
