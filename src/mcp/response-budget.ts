import { RESPONSE_BUDGET_BYTES, type ReserveSessionsResult, type CancelReservationResult } from "../schedule/reservations.js";
import type { SchedulePlan } from "../schedule/plan.js";

export function responseBytes(value: unknown, isError = false): number {
  return Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) }), "utf8");
}
export function shortenDescription(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max)}…[shortened]` : text;
}
/** Requested IDs and their outcomes are never removed. Optional conflict lists are capped, with
 * intact retained IDs and explicit omissions; re-read the schedule for the full conflict list. */
export function boundedReservationResult(raw: ReserveSessionsResult) {
  const result = {
    ...raw,
    failed: raw.failed.map(failure => ({ ...failure, code: shortenDescription(failure.code, 64),
      ...(failure.reason === undefined ? {} : { reason: shortenDescription(failure.reason) }),
      ...(failure.conflictsWith === undefined ? {} : { conflictsWith: failure.conflictsWith.slice(0, 4).map(conflict => ({ ...conflict, title: conflict.title === null ? null : shortenDescription(conflict.title) })) }),
      omittedConflicts: Math.max(0, (failure.conflictsWith?.length ?? 0) - 4),
    })),
    ...(raw.verificationError === undefined ? {} : { verificationError: shortenDescription(raw.verificationError) }),
    ...(raw.aborted === undefined ? {} : { aborted: { reason: shortenDescription(raw.aborted.reason, 64), message: shortenDescription(raw.aborted.message) } }),
    detailsTruncated: false,
    conflictHint: "For omitted conflicts, read the complete schedule before retrying.",
  };
  result.detailsTruncated = JSON.stringify(result.failed) !== JSON.stringify(raw.failed.map(failure => ({ ...failure, omittedConflicts: 0 }))) || result.verificationError !== raw.verificationError || JSON.stringify(result.aborted) !== JSON.stringify(raw.aborted);
  for (const failure of result.failed) {
    while (responseBytes(result, true) >= RESPONSE_BUDGET_BYTES && failure.conflictsWith?.length) {
      failure.conflictsWith.pop(); failure.omittedConflicts++; result.detailsTruncated = true;
    }
  }
  if (responseBytes(result, true) >= RESPONSE_BUDGET_BYTES) {
    for (const failure of result.failed) delete failure.reason;
    result.detailsTruncated = true;
  }
  // Unknown server codes can themselves be arbitrarily long Unicode descriptions. The failed
  // array preserves the refusal state even when only a marked prefix of the code will fit.
  for (const max of [32, 16, 8, 0]) {
    if (responseBytes(result, true) < RESPONSE_BUDGET_BYTES) break;
    for (const failure of result.failed) failure.code = shortenDescription(failure.code, max);
    result.detailsTruncated = true;
  }
  return result;
}
export function boundedCancelResult(raw: CancelReservationResult) {
  return { ...raw,
    ...(raw.error === undefined ? {} : { error: shortenDescription(raw.error) }),
    ...(raw.verificationError === undefined ? {} : { verificationError: shortenDescription(raw.verificationError) }),
  };
}
/** Domain has already examined every hard commitment. Only the read presentation is bounded. */
export function boundedSchedulePlan(raw: SchedulePlan) {
  const result = { ...raw, selected: [...raw.selected], rejected: [...raw.rejected], alternatives: [...raw.alternatives], blockedBy: [...raw.blockedBy], alreadyReserved: [...raw.alreadyReserved], omitted: { selected: 0, rejected: 0, alternatives: 0, blockedBy: 0, alreadyReserved: 0 } };
  for (const key of ["alternatives", "rejected", "selected", "blockedBy", "alreadyReserved"] as const) {
    while (responseBytes(result) >= RESPONSE_BUDGET_BYTES && result[key].length) {
      result[key].pop(); result.omitted[key]++;
    }
  }
  return result;
}
