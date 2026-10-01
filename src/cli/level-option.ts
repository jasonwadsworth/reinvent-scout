import type { LevelBandRange } from "../catalog/query.js";
import { ValidationError } from "../core/errors.js";

/** `--level`: a band ("400") or an inclusive range ("400-500"). */
export function parseLevelBandRange(raw: string): LevelBandRange {
  const rangeMatch = /^(\d+)-(\d+)$/.exec(raw);
  if (rangeMatch) {
    return { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) };
  }
  const singleMatch = /^(\d+)$/.exec(raw);
  if (singleMatch) {
    const band = Number(singleMatch[1]);
    return { min: band, max: band };
  }
  throw new ValidationError(`--level must be a number or a range like "100-200", got "${raw}".`);
}
