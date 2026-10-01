import type { Command } from "commander";
import type { LevelBandRange } from "../catalog/query.js";
import { ValidationError } from "../core/errors.js";
import { FACET_ACTIONS, FACET_FIELDS, type FacetAction, type FacetField, type FacetRule, type SessionPreferences } from "../match/preferences.js";

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

/** `--only`, `--prefer`, `--avoid` and `--exclude`: "[<field>:]<value>[@<band>]", the field being a format when it is left out. */
export function parseFacetRule(action: FacetAction, raw: string): FacetRule {
  const at = raw.lastIndexOf("@");
  const body = (at === -1 ? raw : raw.slice(0, at)).trim();
  const colon = body.indexOf(":");
  const named = colon === -1 ? undefined : body.slice(0, colon).trim().toLowerCase();
  const field = named !== undefined && (FACET_FIELDS as readonly string[]).includes(named) ? (named as FacetField) : undefined;
  if (field === undefined && action === "only") {
    throw new ValidationError(`--only takes "<field>:<value>" with a field of ${FACET_FIELDS.join(", ")}, like "venue:mgm", got "${raw}".`);
  }
  const value = (field === undefined ? body : body.slice(colon + 1)).trim();
  if (value === "") {
    throw new ValidationError(`--${action} takes a value, like "chalk talk" or "venue:mgm@300-500", got "${raw}".`);
  }
  return { field: field ?? "format", value, action, ...(at === -1 ? {} : { levels: parseLevelBandRange(raw.slice(at + 1).trim(), `--${action} ...@`) }) };
}

/**
 * Adds `--level`, `--only`, `--prefer`, `--avoid` and `--exclude` to a command and returns what reads them back as the session preferences.
 * The rules keep the order they were typed in, since the first rule that matches a session wins; they are parsed when read, inside the command's own error handling.
 */
export function addPreferenceOptions(command: Command): (level: string | undefined) => SessionPreferences | undefined {
  const typed: Array<{ action: FacetAction; raw: string }> = [];
  command.option("--level <band>", "only sessions at this level band, e.g. 400 or a range like 400-500");
  for (const action of FACET_ACTIONS) {
    const effect = { only: "keep only sessions with this value", prefer: "rank sessions with this value first", avoid: "rank them last", exclude: "leave them out" }[action];
    const fields = action === "only" ? `<field>:<value>[@band], a field of ${FACET_FIELDS.join(", ")}` : `[<field>:]<value>[@band], a format when the field is left out, e.g. "chalk talk" or "venue:mgm@300-500"`;
    command.option(`--${action} <rule>`, `${effect}: ${fields}; repeatable`, (value: string, previous: string[] = []) => {
      typed.push({ action, raw: value });
      return [...previous, value];
    });
  }
  return (level) => {
    const rules = typed.splice(0).map(({ action, raw }) => parseFacetRule(action, raw));
    if (level === undefined && rules.length === 0) return undefined;
    return { ...(level === undefined ? {} : { levels: parseLevelBandRange(level) }), ...(rules.length === 0 ? {} : { rules }) };
  };
}
