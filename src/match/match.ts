import type { CatalogStoreDeps } from "../catalog/store.js";
import { requireCurrentIndex } from "../catalog/query.js";
import type { IndexRecord } from "../catalog/index-record.js";
import type { Venue } from "../catalog/venue.js";
import type { ResolvedProfile } from "../profile/profile.js";
import { getLensProfile, type Lens } from "./lens.js";
import { buildCorpusStats, scoreSession, type MatchQuery, type Reason } from "./score.js";

export interface MatchOptions {
  /** Defaults to `"all"` -- no level restriction, no format preference. */
  lens?: Lens;
  /** Caps the number of candidates (groups, not raw sittings -- see `MatchCandidate.offerings`)
   * returned, after ranking. */
  limit?: number;
}

/** One scheduled sitting of a session -- a repeat carries the same talk on a different day, so an
 * agent (or a person building a schedule) needs every sitting's own time and place even though the
 * candidates it's choosing between are grouped by talk, not by sitting. */
export interface MatchOffering {
  sessionId: string;
  abbreviation: string | null;
  startDate: string | null;
  startTime: string | null;
  venue: Venue | null;
  room: string | null;
}

export interface MatchCandidate {
  /** The session's base code with any repeat suffix removed (see `baseSessionCode`) -- the stable
   * identity every sitting of the same talk shares. Equal to the record's own `abbreviation` (or,
   * lacking one, its `sessionId`) for a session with no repeats. */
  code: string;
  /** The best-scoring sitting's own fields, exactly as scored -- except `title`, which has any
   * trailing " [REPEAT]" marker stripped (see `stripRepeatTitleMarker`), since the group's
   * displayed title must read the same regardless of which specific sitting happened to score
   * highest. */
  record: IndexRecord;
  /** The best-scoring sitting's own score -- never a sum across repeats, which would double-count
   * what is really one talk. */
  score: number;
  reasons: Reason[];
  /** Every sitting of this talk, sorted by start time (unscheduled sittings last) -- always at
   * least one element, even for a session with no repeats at all. */
  offerings: MatchOffering[];
}

/** Appends `value` to `list` only the first time its case-insensitive form is seen -- used for
 * `topics`/`areasOfInterest` below, which `scoreSession` already compares case-insensitively
 * against a session's own fields. Keeps the first spelling encountered, since there's no reason to
 * prefer a later one. */
function pushDeduped(list: string[], seen: Set<string>, value: string): void {
  const key = value.toLowerCase();
  if (!seen.has(key)) {
    seen.add(key);
    list.push(value);
  }
}

/**
 * Builds the scorer's query from a resolved, agent-authored profile:
 *
 * - `services`: every *distinct* catalog display name a service resolved to (an unresolved one has
 *   nothing to exact-match against a session's own `services`, so it's simply absent here -- it
 *   still contributes through `text` below via its own `name`). Deduplicated: resolution is
 *   many-to-one by design (a short key, a display name, and an SDK package name can all resolve to
 *   the same service), and the README's own documented use case -- an agent citing the same
 *   service found in two different files under two different spellings -- would otherwise emit the
 *   same 50-point exact-match reason once per spelling, multiplying the strongest signal this
 *   scorer has by however many ways the profile happened to name it.
 * - `topics`: each *distinct* pattern `name`, deduplicated case-insensitively (`scoreSession`
 *   already compares topics case-insensitively, so "serverless" and "Serverless" are the same
 *   topic to it and must not each produce their own reason) -- a pattern like "serverless" or
 *   "event-driven" is the closest agent-authored equivalent to one of the catalog's own topic
 *   labels.
 * - `areasOfInterest`: the profile's own `interests`, deduplicated the same case-insensitive way.
 * - `text`: every piece of free-text prose the profile carries -- each service's own `name` (not
 *   just the ones that resolved, and not deduplicated: term-frequency saturation already caps how
 *   much repeating the same word can matter) and `usage`, each pattern's `name` and `note`,
 *   `interests`, and every intent's `text` -- joined into one string for BM25-lite scoring. A
 *   service's own `name` is included here even when it also produced an exact match above, since a
 *   text match on the same term costs nothing extra to compute and helps sessions that mention the
 *   service without it being in their formal `services` list.
 */
function buildMatchQuery(profile: ResolvedProfile): MatchQuery {
  const seenServices = new Set<string>();
  const services: string[] = [];
  const textParts: string[] = [];

  for (const service of profile.services) {
    if (service.catalogName !== null && !seenServices.has(service.catalogName)) {
      seenServices.add(service.catalogName);
      services.push(service.catalogName);
    }
    textParts.push(service.name);
    if (service.usage !== undefined) {
      textParts.push(service.usage);
    }
  }

  const seenTopics = new Set<string>();
  const topics: string[] = [];
  for (const pattern of profile.patterns) {
    pushDeduped(topics, seenTopics, pattern.name);
    textParts.push(pattern.name);
    if (pattern.note !== undefined) {
      textParts.push(pattern.note);
    }
  }

  const seenInterests = new Set<string>();
  const areasOfInterest: string[] = [];
  for (const interest of profile.interests ?? []) {
    pushDeduped(areasOfInterest, seenInterests, interest);
  }
  textParts.push(...(profile.interests ?? []));

  for (const intent of profile.intents ?? []) {
    textParts.push(intent.text);
  }

  return { services, topics, areasOfInterest, text: textParts.join(" ") };
}

/** A per-record scoring result, before repeat sessions are grouped into a `MatchCandidate` --
 * every field a `MatchCandidate` needs except `code` and `offerings`, which only exist once
 * records are grouped. */
interface ScoredRecord {
  record: IndexRecord;
  score: number;
  reasons: Reason[];
}

/**
 * The real catalog's own repeat-sitting suffix: `-R` optionally followed by digits --
 * `ARC325-R`, `ARC325-R1`, `ARC325-R2` are the same talk sat on different days. Deliberately
 * narrow, matching only `R`: a broader `-[A-Z]\d*$` would also match `-S`, the catalog's unrelated
 * marker for a sponsored session, and the real catalog has at least one base code where that
 * collision is not hypothetical -- `AIM214` (a SageMaker session) and `AIM214-S` (an unrelated
 * sponsored talk) share a base string but are two different sessions. Merging them would attach
 * one session's sittings to the other's title in output an agent reads as fact.
 */
const REPEAT_SUFFIX_PATTERN = /-R\d*$/;

/** The group identity a repeat session shares with its siblings: its `abbreviation` with any
 * repeat suffix removed, or its `sessionId` when it has no abbreviation at all (which can't
 * collide with a real abbreviation-derived code, and can't itself be shared by two different
 * sessions, so it's always a safe, unique fallback group of one). */
function baseSessionCode(record: IndexRecord): string {
  if (record.abbreviation === null) {
    return record.sessionId;
  }
  return record.abbreviation.replace(REPEAT_SUFFIX_PATTERN, "");
}

/** The real catalog marks *some* (not all) repeat sittings' titles with a trailing " [REPEAT]" --
 * confirmed inconsistent across real repeat groups (several carry no marker on any member), so a
 * group's displayed title can't simply trust whichever member happened to score highest to already
 * be marker-free. Strips it unconditionally; a title that never had the marker is returned
 * unchanged. */
const REPEAT_TITLE_MARKER_PATTERN = /\s*\[REPEAT\]\s*$/i;

function stripRepeatTitleMarker(title: string): string {
  return title.replace(REPEAT_TITLE_MARKER_PATTERN, "");
}

function toOffering(record: IndexRecord): MatchOffering {
  return {
    sessionId: record.sessionId,
    abbreviation: record.abbreviation,
    startDate: record.startDate,
    startTime: record.startTime,
    venue: record.venue,
    room: record.room,
  };
}

/** Ascending by start date then start time; a sitting with no `startDate` at all (unscheduled)
 * sorts last, since there's nothing yet to place it relative to a scheduled one. */
function compareOfferings(a: MatchOffering, b: MatchOffering): number {
  if (a.startDate !== b.startDate) {
    if (a.startDate === null) {
      return 1;
    }
    if (b.startDate === null) {
      return -1;
    }
    return a.startDate.localeCompare(b.startDate);
  }
  return (a.startTime ?? "").localeCompare(b.startTime ?? "");
}

/**
 * Groups scored records by `baseSessionCode`, collapsing every repeat sitting of the same talk
 * into one `MatchCandidate`. The group's `score` and `reasons` come from its best-scoring member
 * (never a sum -- these are the same talk, not independent signals to add together), and every
 * member, including that same top scorer, appears in `offerings`. A group of one (no repeats)
 * still gets a one-element `offerings` list, so a caller never has to special-case "no repeats"
 * separately from "some repeats."
 */
function groupByCode(scoredRecords: readonly ScoredRecord[]): MatchCandidate[] {
  const groups = new Map<string, ScoredRecord[]>();
  for (const scored of scoredRecords) {
    const code = baseSessionCode(scored.record);
    const members = groups.get(code);
    if (members === undefined) {
      groups.set(code, [scored]);
    } else {
      members.push(scored);
    }
  }

  const candidates: MatchCandidate[] = [];
  for (const [code, members] of groups) {
    let winner = members[0]!;
    for (const member of members) {
      if (member.score > winner.score) {
        winner = member;
      }
    }
    const offerings = members.map((member) => toOffering(member.record)).sort(compareOfferings);
    candidates.push({
      code,
      record: { ...winner.record, title: stripRepeatTitleMarker(winner.record.title) },
      score: winner.score,
      reasons: winner.reasons,
      offerings,
    });
  }
  return candidates;
}

/** Rounds to two decimal places at the output boundary only. `scoreSession`'s BM25-lite saturation
 * arithmetic routinely produces floating-point noise (3 * (1/2.5) is 1.2000000000000002, not a
 * clean 1.2) that carries no information, reads as unpolished in agent-facing JSON, and costs
 * tokens for nothing -- but that same raw precision is exactly what `candidates.sort` below needs
 * to rank consistently, so rounding happens once, here, after sorting is already done, never
 * inside the scorer itself. */
function roundToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundCandidate(candidate: MatchCandidate): MatchCandidate {
  return {
    code: candidate.code,
    record: candidate.record,
    score: roundToTwoDecimals(candidate.score),
    reasons: candidate.reasons.map((reason) => ({
      ...reason,
      weight: roundToTwoDecimals(reason.weight),
    })),
    offerings: candidate.offerings,
  };
}

/**
 * Ranks the local catalog against a resolved profile, applying `options.lens`'s level-band
 * restriction (a session with no level band on record is excluded whenever the lens restricts by
 * level, never assumed to satisfy it) and format preference (an additional `"format"` reason,
 * appended on top of `scoreSession`'s own reasons) before sorting.
 *
 * A session with nothing to say for it -- no service, topic, area-of-interest, or text signal at
 * all from `scoreSession` -- is excluded entirely, before the lens's format bonus is even
 * considered, rather than returned at the bottom with a `0`. The format bonus is a tiebreak among
 * sessions that already share a real signal with the profile, never a standalone reason to include
 * one that shares nothing with it -- gating on it too would let a session earn a place purely by
 * being the lens's favored type. This is also what makes a profile with no signals at all return an
 * empty list instead of every session in the catalog in an arbitrary order.
 *
 * Every repeat sitting of the same talk (see `baseSessionCode`) is collapsed into one
 * `MatchCandidate` before ranking, so `options.limit` counts distinct talks, not raw sittings, and
 * an agent asking for thirty candidates gets thirty genuinely different choices rather than the
 * same talk occupying several slots under different suffixes. `catalog search` is deliberately
 * left ungrouped -- it's a raw listing, not a ranked set of choices to pick between.
 *
 * Ties break first on whether the group's best-scoring sitting is actually scheduled (`startDate`
 * present) -- an otherwise-equal group with nothing yet scheduled ranks below one that does, since
 * there's nothing yet to act on for it -- and then on `code`, the same deterministic tiebreak
 * `catalog/query.ts`'s local search uses on `abbreviation`.
 *
 * Throws `CatalogMissingError`/`CatalogUnusableError` exactly like `queryCatalog`, since there's
 * nothing to rank against until a catalog has been synced.
 *
 * Every emitted `score` and `reason.weight` is rounded to two decimal places -- sorting above
 * uses each candidate's full, unrounded precision, and only the returned candidates themselves are
 * rounded, so ranking is unaffected by the rounding and an agent never sees BM25-lite's raw
 * floating-point noise (see `roundToTwoDecimals`).
 */
export function matchSessions(
  profile: ResolvedProfile,
  deps: CatalogStoreDeps,
  options: MatchOptions = {},
): MatchCandidate[] {
  const lens = options.lens ?? "all";
  const lensProfile = getLensProfile(lens);
  const index = requireCurrentIndex(deps);
  const query = buildMatchQuery(profile);
  // Built once, over the whole loaded catalog, and reused for every candidate below -- inverse
  // document frequency is a corpus-wide statistic, not a per-record one; computing it fresh per
  // record would be both wasteful and simply wrong, since it needs to see every document to know
  // how rare a term actually is.
  const corpusStats = buildCorpusStats(index);

  const scoredRecords: ScoredRecord[] = [];

  for (const record of index) {
    if (lensProfile.levelBands !== null) {
      if (record.levelBand === null || !lensProfile.levelBands.includes(record.levelBand)) {
        continue;
      }
    }

    const base = scoreSession(record, query, corpusStats);
    // Gated on the scorer's own score, before the lens's format bonus is even considered -- a
    // format preference is a tiebreak among sessions that already share a real signal with the
    // profile (a service, a topic, an area of interest, or free-text overlap), never a standalone
    // reason to include a session that shares nothing with it at all. Gating on the *combined*
    // score instead (the bug this replaced) let being a Breakout session or Chalk talk alone earn
    // a place in the results, and outrank a session with a real but modest text match.
    if (base.score <= 0) {
      continue;
    }

    const reasons = [...base.reasons];
    let score = base.score;

    const formatBonus = record.type !== null ? lensProfile.typeWeights.get(record.type) : undefined;
    if (formatBonus !== undefined) {
      reasons.push({
        kind: "format",
        detail: `${record.type} sessions are favored under the ${lens} lens.`,
        weight: formatBonus,
        evidence: record.type!,
      });
      score += formatBonus;
    }

    scoredRecords.push({ record, score, reasons });
  }

  const candidates = groupByCode(scoredRecords);

  candidates.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    const aScheduled = a.record.startDate !== null;
    const bScheduled = b.record.startDate !== null;
    if (aScheduled !== bScheduled) {
      return aScheduled ? -1 : 1;
    }
    return a.code.localeCompare(b.code);
  });

  const limited = options.limit === undefined ? candidates : candidates.slice(0, options.limit);
  return limited.map(roundCandidate);
}
