import { toPublicIndexRecord } from "../catalog/index-record.js";
import type { SkippedRule } from "./lens-signals.js";
import type { MatchCandidate, MatchResult } from "./match.js";

/** The MCP-facing candidate shape, deliberately leaner than the CLI's own (which reuses the full
 * `toPublicIndexRecord` -- reasonable for a human terminal, too heavy for metered agent context
 * held to a real 30 KB response budget; see the size note above `DEFAULT_MATCH_SESSIONS_LIMIT`).
 * Keeps only what a caller needs to identify, explain and schedule a candidate: `code`/`sessionId`
 * to reference it (e.g. for `favorite_sessions`), `title`/`type`/`levelBand` to describe it,
 * `score`/`reasons` (and, for Fix and Next-level, `lensRules`) for why it matched, and `offerings` for when and where.
 *
 * `type` was dropped in an earlier revision to fit the size budget by shape-trimming alone, then
 * restored once the budget was enforced on the response instead (see `buildMatchResponse`): a
 * caller that cannot tell a Workshop from a Chalk talk is missing something real for a tool whose
 * whole job is helping choose sessions, and the response-level truncation now pays for it in one
 * fewer candidate when space is actually tight, rather than never having it at all. `services` is
 * not restored alongside it -- it stays redundant with what `reasons` already names explicitly,
 * unlike `type`, which `reasons` says nothing about at all under the `all` lens. */
export function toLeanCandidate(candidate: MatchCandidate): Record<string, unknown> {
  const record = toPublicIndexRecord(candidate.record);
  return {
    code: candidate.code,
    sessionId: record.sessionId,
    title: record.title,
    type: record.type,
    levelBand: record.levelBand,
    score: candidate.score,
    reasons: candidate.reasons,
    offerings: candidate.offerings,
    ...(candidate.lensRules === undefined ? {} : { lensRules: candidate.lensRules }),
  };
}

/** Lead's decision, replacing an earlier hint ("ask again with a smaller limit..."): a smaller
 * `limit` cannot reach the omitted candidates at all -- there is no `offset` on `match_sessions`,
 * so asking for fewer just returns fewer of the exact same top-ranked set. Names the real count
 * instead, and only suggests what can actually change which candidates rank highest. */
function truncationHint(omitted: number): string {
  return (
    `${omitted} lower-ranked candidates were omitted to fit the response budget. ` +
    "A narrower lens or a more specific profile changes what ranks highest."
  );
}

export interface MatchSessionsResponse {
  candidates: Record<string, unknown>[];
  truncated: boolean;
  returned: number;
  requested: number;
  /** How many of `matchSessions`' own ranked candidates (already capped at `requested`, so this
   * is never inflated by asking for more than the catalog actually has) were left out purely for
   * size -- `0` whenever `truncated` is `false`. Deliberately not `requested - returned`: when the
   * catalog simply has fewer matches than `requested`, that gap is not an omission, and reporting
   * it as one would tell a caller candidates were dropped for size when none were. */
  omitted: number;
  hint?: string;
  /** Next-level paths skipped because the profile already made the move. */
  skippedRules: SkippedRule[];
}

/** Builds one candidate-count's worth of response. Kept as the one place that decides the shape
 * for a given `candidates`/`truncated` pair, so both call sites below (the initial
 * everything-fits attempt, and every trial inside the truncation loop) measure the exact same
 * shape the caller will actually receive -- never an approximation of it. */
function buildResponse(
  candidates: Record<string, unknown>[],
  requested: number,
  totalMatched: number,
  truncated: boolean,
  skippedRules: SkippedRule[],
): MatchSessionsResponse {
  const omitted = totalMatched - candidates.length;
  return {
    candidates,
    truncated,
    returned: candidates.length,
    requested,
    omitted,
    ...(truncated ? { hint: truncationHint(omitted) } : {}),
    skippedRules,
  };
}

/** The one match response shape, shared by the CLI's `match --json` and the MCP `match_sessions`
 * tool. `fits` decides whether a candidate response is within the caller's size budget; the
 * default accepts everything (the CLI has no budget). */
export function buildMatchResponse(
  result: MatchResult,
  requested: number,
  fits: (value: unknown) => boolean = () => true,
  toCandidate: (candidate: MatchCandidate) => Record<string, unknown> = toLeanCandidate,
): MatchSessionsResponse {
  const leanCandidates = result.candidates.map(toCandidate);
  const { skippedRules } = result;
  const totalMatched = leanCandidates.length;
  const everything = buildResponse(leanCandidates, requested, totalMatched, false, skippedRules);
  if (fits(everything)) {
    return everything;
  }

  // Not everything fits -- greedily include candidates in ranked order (the same order
  // matchSessions already ranked them in; never reordered or re-scored here), each checked as a
  // whole prospective response against the budget (using the same truncated:true/hint shape the
  // final response will have, so the check is honest about the overhead that shape itself costs),
  // stopping before the first one that would push the response over. A candidate is either whole
  // or left out entirely -- never partially serialized to make room.
  const included: Record<string, unknown>[] = [];
  for (const candidate of leanCandidates) {
    const trial = buildResponse([...included, candidate], requested, totalMatched, true, skippedRules);
    if (!fits(trial)) {
      break;
    }
    included.push(candidate);
  }

  return buildResponse(included, requested, totalMatched, true, skippedRules);
}

