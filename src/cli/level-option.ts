import type { Command } from "commander";
import type { LevelBandRange } from "../catalog/query.js";
import { ValidationError } from "../core/errors.js";
import { FORMAT_ACTIONS, type FormatAction, type FormatRule, type SessionPreferences } from "../match/preferences.js";

/** `--level`: a band ("400") or an inclusive range ("400-500"). */
export function parseLevelBandRange(raw: string, flag = "--level"): LevelBandRange {
  const rangeMatch = /^(\d+)-(\d+)$/.exec(raw);
  if (rangeMatch) {
    return { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) };
  }
  const singleMatch = /^(\d+)$/.exec(raw);
  if (singleMatch) {
    const band = Number(singleMatch[1]);
    return { min: band, max: band };
  }
  throw new ValidationError(`${flag} must be a number or a range like "100-200", got "${raw}".`);
}

/** `--prefer`, `--avoid` and `--exclude`: a session type, optionally only at some levels, as "breakout session@300-500". */
export function parseFormatRule(action: FormatAction, raw: string): FormatRule {
  const at = raw.lastIndexOf("@");
  const type = (at === -1 ? raw : raw.slice(0, at)).trim();
  if (type === "") {
    throw new ValidationError(`--${action} takes a session type, like "chalk talk" or "breakout session@300-500", got "${raw}".`);
  }
  return { type, action, ...(at === -1 ? {} : { levels: parseLevelBandRange(raw.slice(at + 1).trim(), `--${action} ...@`) }) };
}

/**
 * Adds `--level`, `--prefer`, `--avoid` and `--exclude` to a command and returns what reads them back as the session preferences.
 * The rules keep the order they were typed in, since the first rule that matches a session wins; they are parsed when read, inside the command's own error handling.
 */
export function addPreferenceOptions(command: Command): (level: string | undefined) => SessionPreferences | undefined {
  const typed: Array<{ action: FormatAction; raw: string }> = [];
  command.option("--level <band>", "only sessions at this level band, e.g. 400 or a range like 400-500");
  for (const action of FORMAT_ACTIONS) {
    const effect = { prefer: "rank sessions of this type first", avoid: "rank them last", exclude: "leave them out" }[action];
    command.option(`--${action} <type[@band]>`, `${effect}, e.g. "chalk talk" or "breakout session@300-500"; repeatable, first match wins`, (value: string, previous: string[] = []) => {
      typed.push({ action, raw: value });
      return [...previous, value];
    });
  }
  return (level) => {
    const formats = typed.splice(0).map(({ action, raw }) => parseFormatRule(action, raw));
    if (level === undefined && formats.length === 0) return undefined;
    return { ...(level === undefined ? {} : { levels: parseLevelBandRange(level) }), ...(formats.length === 0 ? {} : { formats }) };
  };
}
