import { toPublicIndexRecord } from "../catalog/index-record.js";
import type { UncoveredConcept } from "./concepts.js";
import type { SessionPreferences } from "./levels.js";
import type { SkippedRule } from "./lens-signals.js";
import type { ProfileMap, MapTopic } from "./map.js";
import type { FocusCandidate, FocusEntry, FocusResult } from "./focus.js";
import type { MatchCandidate, MatchResult } from "./match.js";
import type { Reason } from "./score.js";

/** Reasons that only explain the ranking (a shared service, topic, wording, level or format; under
 * `all`, a concept the session is about, which `why` already says). The lens reasons (`pillarGap`,
 * `migrationPath`, `explainsConcept`) carry every source that admitted a candidate, so they are not
 * ranking reasons. */
const LENS_REASON_KINDS: readonly Reason["kind"][] = ["pillarGap", "migrationPath", "explainsConcept"];

export function isRankingReason(reason: Reason): boolean {
  return !LENS_REASON_KINDS.includes(reason.kind);
}

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
    why: candidate.why,
    score: candidate.score,
    reasons: candidate.reasons,
    offerings: candidate.offerings,
    ...(candidate.lensRules === undefined ? {} : { lensRules: candidate.lensRules }),
    ...(candidate.demoted === undefined ? {} : { demoted: candidate.demoted }),
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
  /** Present (`true`) only when the response would not fit its budget with every candidate's ranking
   * reasons, so they were left off all of them; `why` and the lens reasons are intact. */
  rankingReasonsOmitted?: true;
  /** Next-level paths skipped because the profile already made the move. */
  skippedRules: SkippedRule[];
  /** Explain only, always present there: profile concepts no session could be matched to. Absent
   * under the other lenses, whose output is unchanged. */
  uncovered?: UncoveredConcept[];
  /** The preferences that were applied, so the agent can say what the list was restricted to; absent when there were none. */
  preferences?: SessionPreferences;
  /** Present when the preferences left nothing of a result that has sessions without them. */
  reason?: string;
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
  uncovered: UncoveredConcept[] | undefined,
  applied: Pick<MatchSessionsResponse, "preferences" | "reason">,
  rankingReasonsOmitted = false,
): MatchSessionsResponse {
  const omitted = totalMatched - candidates.length;
  return {
    candidates,
    truncated,
    returned: candidates.length,
    requested,
    omitted,
    ...(truncated ? { hint: truncationHint(omitted) } : {}),
    ...(rankingReasonsOmitted ? { rankingReasonsOmitted: true as const } : {}),
    skippedRules,
    ...(uncovered === undefined ? {} : { uncovered }),
    ...(applied.preferences === undefined ? {} : { preferences: applied.preferences }),
    ...(applied.reason === undefined ? {} : { reason: applied.reason }),
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
  const { skippedRules, uncovered } = result;
  const applied = { ...(result.preferences === undefined ? {} : { preferences: result.preferences }), ...(result.reason === undefined ? {} : { reason: result.reason }) };
  const totalMatched = leanCandidates.length;
  const everything = buildResponse(leanCandidates, requested, totalMatched, false, skippedRules, uncovered, applied);
  if (fits(everything)) {
    return everything;
  }

  // Not everything fits. What explains a candidate to the reader is `why` and the lens reasons; the
  // ranking reasons only explain the ranking, so they go first, from every candidate, before any
  // candidate is left out.
  const withoutRanking = result.candidates.map(candidate =>
    toCandidate({ ...candidate, reasons: candidate.reasons.filter(reason => !isRankingReason(reason)) }));
  const trimmed = buildResponse(withoutRanking, requested, totalMatched, false, skippedRules, uncovered, applied, true);
  if (fits(trimmed)) {
    return trimmed;
  }

  // Still not everything fits -- greedily include candidates in ranked order (the same order
  // matchSessions already ranked them in; never reordered or re-scored here), each checked as a
  // whole prospective response against the budget (using the same truncated:true/hint shape the
  // final response will have, so the check is honest about the overhead that shape itself costs),
  // stopping before the first one that would push the response over. A candidate is either whole
  // or left out entirely -- never partially serialized to make room.
  const included: Record<string, unknown>[] = [];
  for (const candidate of withoutRanking) {
    const trial = buildResponse([...included, candidate], requested, totalMatched, true, skippedRules, uncovered, applied, true);
    if (!fits(trial)) {
      break;
    }
    included.push(candidate);
  }

  return buildResponse(included, requested, totalMatched, true, skippedRules, uncovered, applied, true);
}


export interface FocusResponse {
  results: Array<{ topic: string; goal: string; total: number; candidates: Record<string, unknown>[]; reason?: string }>;
  /** True when sessions were left out, from the end of the longest lists, to fit the budget. */
  truncated: boolean;
  /** How many sessions were left out; 0 when `truncated` is false. */
  omitted: number;
  /** Present (`true`) only when ranking reasons were left off every candidate to fit the budget. */
  rankingReasonsOmitted?: true;
  /** The preferences that were applied; absent when there were none. */
  preferences?: SessionPreferences;
}

function focusResponse(entries: readonly FocusEntry[], candidates: readonly Record<string, unknown>[][], omitted: number, rankingReasonsOmitted: boolean, preferences: SessionPreferences | undefined): FocusResponse {
  return {
    results: entries.map((entry, position) => ({
      topic: entry.topic, goal: entry.goal, total: entry.total, candidates: candidates[position]!,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    })),
    truncated: omitted > 0,
    omitted,
    ...(rankingReasonsOmitted ? { rankingReasonsOmitted: true as const } : {}),
    ...(preferences === undefined ? {} : { preferences }),
  };
}

/** The lean candidate of a focused result, with the later choices it would also have matched. */
export function toLeanFocusCandidate(candidate: FocusCandidate): Record<string, unknown> {
  return { ...toLeanCandidate(candidate), ...(candidate.alsoMatches === undefined ? {} : { alsoMatches: candidate.alsoMatches }) };
}

/**
 * The one focused-match response shape, shared by the CLI's `match --focus --json` and the MCP `match_sessions` tool with a
 * `focus`. Budgeted like `buildMatchResponse`: when it does not fit, every candidate's ranking reasons go first, then sessions
 * from the end of the longest list, one at a time, so every choice keeps its first sessions; nothing is ever partly serialized.
 */
export function buildFocusResponse(
  result: FocusResult,
  fits: (value: unknown) => boolean = () => true,
  toCandidate: (candidate: FocusCandidate) => Record<string, unknown> = toLeanFocusCandidate,
): FocusResponse {
  const lean = (strip: boolean): Record<string, unknown>[][] => result.results.map(entry => entry.candidates.map(candidate =>
    toCandidate(strip ? { ...candidate, reasons: candidate.reasons.filter(reason => !isRankingReason(reason)) } : candidate)));
  const everything = focusResponse(result.results, lean(false), 0, false, result.preferences);
  if (fits(everything)) return everything;
  const kept = lean(true);
  let omitted = 0;
  let response = focusResponse(result.results, kept, omitted, true, result.preferences);
  while (!fits(response) && kept.some(list => list.length > 0)) {
    const longest = kept.reduce((best, list) => (list.length > best.length ? list : best), kept[0]!);
    longest.pop();
    omitted++;
    response = focusResponse(result.results, kept, omitted, true, result.preferences);
  }
  return response;
}

/** The map, trimmed to the budget when a large profile would not fit: first to one place per topic, then to none, then without notes. */
export function buildMapResponse(map: ProfileMap, fits: (value: unknown) => boolean = () => true): ProfileMap {
  const each = (change: (topic: MapTopic) => MapTopic): ProfileMap => ({
    services: map.services.map(change), patterns: map.patterns.map(change), gaps: map.gaps.map(change), nextSteps: map.nextSteps.map(change),
    ...(map.preferences === undefined ? {} : { preferences: map.preferences }),
  });
  const oneIn = (topic: MapTopic): MapTopic => ({ ...topic, evidence: topic.evidence.slice(0, 1) });
  const without = (topic: MapTopic, key: "more" | "note"): MapTopic => Object.fromEntries(Object.entries(topic).filter(([name]) => name !== key)) as unknown as MapTopic;
  const noneIn = (topic: MapTopic): MapTopic => without({ ...topic, evidence: [] }, "more");
  const noNote = (topic: MapTopic): MapTopic => without(noneIn(topic), "note");
  for (const trimmed of [map, each(oneIn), each(noneIn), each(noNote)]) {
    if (fits(trimmed)) return trimmed;
  }
  return each(noNote);
}
