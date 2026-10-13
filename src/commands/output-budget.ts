import type { OnsitePreferences } from "../onsite/config.js";
import type { NearbyResult } from "../onsite/recommend.js";
import type { SchedulePlan } from "../schedule/plan.js";

/**
 * The most stdout one script command may write. Claude Code's Bash tool truncates output over
 * 30,000 characters by default, so the budget stays under that: 24 KiB of raw JSON is about the
 * same content as the old 30 KiB MCP envelope, where every quote of the inner JSON was escaped.
 */
export const OUTPUT_BUDGET_BYTES = 24 * 1024;

export function outputBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function shortenDescription(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max)}…[shortened]` : text;
}

/** Domain has already examined every hard commitment. Only the read presentation is bounded. */
export function boundedSchedulePlan(raw: SchedulePlan) {
  const result = { ...raw, selected: [...raw.selected], rejected: [...raw.rejected], alternatives: [...raw.alternatives], blockedBy: [...raw.blockedBy], alreadyReserved: [...raw.alreadyReserved], alreadyReservedAlternative: [...raw.alreadyReservedAlternative], omitted: { selected: 0, rejected: 0, alternatives: 0, blockedBy: 0, alreadyReserved: 0, alreadyReservedAlternative: 0 } };
  for (const key of ["alternatives", "rejected", "selected", "blockedBy", "alreadyReserved", "alreadyReservedAlternative"] as const) {
    while (outputBytes(result) >= OUTPUT_BUDGET_BYTES && result[key].length) {
      result[key].pop(); result.omitted[key]++;
    }
  }
  return result;
}

export function boundedNearbyResult(raw: NearbyResult) {
  const result = { ...raw, candidates: [...raw.candidates], coverage: { ...raw.coverage } };
  while (outputBytes(result) >= OUTPUT_BUDGET_BYTES && result.candidates.length) {
    result.candidates.pop(); result.coverage.omitted++;
  }
  return result;
}
export function boundedOnsitePreferences(raw: OnsitePreferences) {
  const result = { ...raw, sessionWalkUp: [...raw.sessionWalkUp], routes: [...raw.routes], omitted: { sessionWalkUp: 0, routes: 0 } };
  for (const key of ["sessionWalkUp", "routes"] as const) {
    while (outputBytes(result) >= OUTPUT_BUDGET_BYTES && result[key].length) { result[key].pop(); result.omitted[key]++; }
  }
  return result;
}
