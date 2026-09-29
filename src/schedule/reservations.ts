import type { ApiClient } from "../api/client.js";
import { OAuthError } from "../auth/oauth.js";
import { readIndex } from "../catalog/store.js";
import { DEFAULT_EVENT_ID } from "../catalog/sync.js";
import { AuthRequiredError, isRequestNotSent, NotFoundError, NotRegisteredError, OperationUnavailableError, ThrottledError, ValidationError } from "../core/errors.js";
import type { FavoriteFailure } from "./favorites.js";
import { acquireWriteQuota, type WriteQuotaDeps } from "./write-quota.js";

export const MAX_RESERVATION_IDS = 50;
export const MAX_SESSION_ID_LENGTH = 128;
export const RESPONSE_BUDGET_BYTES = 30 * 1024;

/** Bounds mandatory per-ID ledgers before any write. JSON-in-text escaping and UTF8 both count.
 * Reserve room for per-ID states and envelope fields; optional descriptions can be shortened. */
export function validateSessionIds(input: readonly string[], allowEmpty = false, writeLedger = true): string[] {
  // Trim first: a padded ID would otherwise pass the checks and be sent to the API as-is.
  const trimmed = input.map(id => typeof id === "string" ? id.trim() : id);
  if ((!allowEmpty && trimmed.length === 0) || trimmed.length > MAX_RESERVATION_IDS || trimmed.some(id => typeof id !== "string" || id.length === 0 || Array.from(id).length > MAX_SESSION_ID_LENGTH)) {
    throw new ValidationError(`Expected ${allowEmpty ? "0" : "1"}–${MAX_RESERVATION_IDS} session IDs, each 1–${MAX_SESSION_ID_LENGTH} characters.`);
  }
  const ids = [...new Set(trimmed)];
  if (writeLedger && Buffer.byteLength(JSON.stringify(JSON.stringify(ids)), "utf8") * 2 + 8192 > RESPONSE_BUDGET_BYTES) {
    throw new ValidationError("These IDs cannot fit the mandatory outcome ledger; submit a smaller batch before any write.");
  }
  return ids;
}

export interface ReserveSessionsResult {
  successful: string[];
  alreadyScheduled: string[];
  failed: FavoriteFailure[];
  uncertain: string[];
  notAttempted: string[];
  verified: { reserved: string[] } | null;
  mismatch: string[];
  verificationError?: string;
  aborted?: { reason: string; message: string };
}
export interface ReservationDeps extends WriteQuotaDeps {
  apiClient: Pick<ApiClient, "reserveSessions" | "getSchedule">;
  eventId?: string;
}
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
/** Known rejections/token failures prove no write. Everything else (including lost responses and
 * malformed acknowledgements) needs reconciliation, never a blind POST replay. */
export function isDefiniteWriteRejection(error: unknown): boolean {
  return error instanceof AuthRequiredError || error instanceof NotRegisteredError || error instanceof OperationUnavailableError || error instanceof ThrottledError || error instanceof OAuthError || error instanceof ValidationError || error instanceof NotFoundError;
}
function mustStop(error: unknown): boolean {
  return error instanceof AuthRequiredError || error instanceof NotRegisteredError || error instanceof OperationUnavailableError || error instanceof ThrottledError || error instanceof OAuthError;
}
export async function reserveSessions(input: readonly string[], deps: ReservationDeps): Promise<ReserveSessionsResult> {
  const ids = validateSessionIds(input);
  const event = deps.eventId ?? DEFAULT_EVENT_ID;
  const index = new Map((readIndex(deps) ?? []).map(record => [record.sessionId, record.title]));
  const result: ReserveSessionsResult = { successful: [], alreadyScheduled: [], failed: [], uncertain: [], notAttempted: [], verified: null, mismatch: [] };
  for (let offset = 0; offset < ids.length; offset += 10) {
    const chunk = ids.slice(offset, offset + 10);
    // A pacing failure occurs before the request; keep earlier outcomes and every unsent ID.
    try { await acquireWriteQuota("reserve", chunk.length, deps); }
    catch (error) {
      result.notAttempted.push(...ids.slice(offset));
      result.aborted = { reason: "pacingFailed", message: message(error) }; break;
    }
    try {
      const response = await deps.apiClient.reserveSessions(event, chunk);
      // Account for every requested ID exactly once, including incomplete or contradictory API
      // acknowledgements. Never accept an unsolicited ID as a result of this request.
      for (const id of chunk) {
        const successes = Array.isArray(response?.successful) ? response.successful.filter(value => value === id).length : 0;
        const failures = Array.isArray(response?.failed) ? response.failed.filter(value => value?.sessionId === id) : [];
        if (successes + failures.length !== 1 || (failures[0] && typeof failures[0].code !== "string")) { result.uncertain.push(id); continue; }
        if (successes === 1) { result.successful.push(id); continue; }
        const failure = failures[0]!;
        if (failure.code === "alreadyScheduled") { result.alreadyScheduled.push(id); continue; }
        result.failed.push({ sessionId: id, code: failure.code,
          ...(failure.code === "scheduleConflict" && Array.isArray(failure.conflictsWith)
            ? { conflictsWith: failure.conflictsWith.map(sessionId => ({ sessionId, title: index.get(sessionId) ?? null })) } : {}),
        });
      }
    } catch (error) {
      if (offset === 0 && (error instanceof AuthRequiredError || error instanceof NotRegisteredError || error instanceof OperationUnavailableError)) throw error;
      // A token failure means the request never left: nothing was sent, so nothing failed.
      if (isRequestNotSent(error)) result.notAttempted.push(...chunk);
      else if (isDefiniteWriteRejection(error)) result.failed.push(...chunk.map(sessionId => ({ sessionId, code: "requestFailed", reason: message(error) })));
      else result.uncertain.push(...chunk);
      if (mustStop(error)) {
        result.notAttempted.push(...ids.slice(offset + chunk.length));
        result.aborted = { reason: error instanceof Error ? error.name : "requestFailed", message: message(error) }; break;
      }
    }
  }
  try {
    const schedule = await deps.apiClient.getSchedule(event);
    const present = new Set(schedule.reserved);
    result.verified = { reserved: ids.filter(id => present.has(id)) };
    result.mismatch = [...result.successful, ...result.alreadyScheduled].filter(id => !present.has(id));
  } catch (error) { result.verificationError = message(error); }
  return result;
}

export interface CancelReservationResult {
  sessionId: string;
  outcome: "cancelled" | "alreadyAbsent" | "uncertain";
  verifiedAbsent: boolean | null;
  error?: string;
  verificationError?: string;
}
export async function cancelReservation(requestedId: string, deps: WriteQuotaDeps & { apiClient: Pick<ApiClient, "cancelReservation" | "getSchedule">; eventId?: string }): Promise<CancelReservationResult> {
  // The trimmed id is the one sent, read back and reported: a padded id would 404 and look absent.
  const [sessionId] = validateSessionIds([requestedId]) as [string];
  const event = deps.eventId ?? DEFAULT_EVENT_ID;
  await acquireWriteQuota("cancel", 1, deps);
  const result: CancelReservationResult = { sessionId, outcome: "cancelled", verifiedAbsent: null };
  try { await deps.apiClient.cancelReservation(event, sessionId); }
  catch (error) {
    if (error instanceof NotFoundError) result.outcome = "alreadyAbsent";
    else if (isDefiniteWriteRejection(error)) throw error;
    else { result.outcome = "uncertain"; result.error = message(error); }
  }
  try { result.verifiedAbsent = !(await deps.apiClient.getSchedule(event)).reserved.includes(sessionId); }
  catch (error) { result.verificationError = message(error); }
  return result;
}

export function reservationNeedsAttention(result: ReserveSessionsResult): boolean {
  return result.failed.length > 0 || result.uncertain.length > 0 || result.notAttempted.length > 0 || result.mismatch.length > 0 || result.verified === null || result.aborted !== undefined;
}
export function cancellationNeedsAttention(result: CancelReservationResult): boolean {
  return result.outcome === "uncertain" || result.verifiedAbsent !== true;
}
