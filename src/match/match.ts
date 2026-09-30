import { buildStackFit, hasCoreService } from "./stack-fit.js";
import { buildConcepts, explainReason, matchConcepts, selectExplain, type ConceptMatch, type UncoveredConcept } from "./explain.js";
import { activeLensRules, scoreLensSignals, skippedLensRules, type LensHit, type SkippedRule } from "./lens-signals.js";
import { readRaw, type CatalogStoreDeps } from "../catalog/store.js";
import { baseSessionCode, requireCurrentIndex } from "../catalog/query.js";
import type { IndexRecord } from "../catalog/index-record.js";
import type { Venue } from "../catalog/venue.js";
import type { ResolvedProfile } from "../profile/profile.js";
import { getLensProfile, type Lens } from "./lens.js";
import { buildCorpusStats, scoreSession, type MatchQuery, type Reason } from "./score.js";

/** A core service listed by fewer than this fraction of catalog sessions is distinctive enough to
 * fit a Fix session on its own. */
const RARE_SERVICE_FRACTION = 0.03;

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
  /** Fix and Next-level only: the source pattern names of every rule that admitted this session. */
  lensRules?: string[];
}

export interface MatchResult {
  candidates: MatchCandidate[];
  /** Next-level paths the profile evidences but already completed, e.g. "profile already has
   * agentic" -- always present, empty when nothing was skipped. */
  skippedRules: SkippedRule[];
  /** Explain only, always present there: concepts of the profile no session could be matched to,
   * each with the reason. Absent under every other lens. */
  uncovered?: UncoveredConcept[];
}

/** What interleaving needs from the winning sitting of a lens candidate. */
interface LensInfo {
  hits: LensHit[];
  relevance: number;
}

interface GroupedCandidate extends MatchCandidate {
  lens?: LensInfo;
  explain?: ConceptMatch[];
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
 * - `supportingServices`: the same, for services marked `role: "supporting"` (scored at half
 *   weight); a name that is also core is dropped here by `scoreSession`, so it counts once.
 * - `services`: every *distinct* core catalog display name a service resolved to (an unresolved one has
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
  const supportingServices: string[] = [];
  const textParts: string[] = [];

  for (const service of profile.services) {
    if (service.catalogName !== null && service.role !== "supporting" && !seenServices.has(service.catalogName)) {
      seenServices.add(service.catalogName);
      services.push(service.catalogName);
    }
    if (service.role !== "supporting") {
      textParts.push(service.name);
      if (service.usage !== undefined) {
        textParts.push(service.usage);
      }
    }
  }

  const seenSupporting = new Set<string>();
  for (const service of profile.services) {
    if (service.catalogName !== null && service.role === "supporting" && !seenSupporting.has(service.catalogName)) {
      seenSupporting.add(service.catalogName);
      supportingServices.push(service.catalogName);
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

  return { services, supportingServices, topics, areasOfInterest, text: textParts.join(" ") };
}

/** A per-record scoring result, before repeat sessions are grouped into a `MatchCandidate` --
 * every field a `MatchCandidate` needs except `code` and `offerings`, which only exist once
 * records are grouped. */
interface ScoredRecord {
  record: IndexRecord;
  score: number;
  reasons: Reason[];
  lens?: LensInfo;
  explain?: ConceptMatch[];
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
function groupByCode(scoredRecords: readonly ScoredRecord[]): GroupedCandidate[] {
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

  const candidates: GroupedCandidate[] = [];
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
      ...(winner.lens === undefined ? {} : { lens: winner.lens }),
      ...(winner.explain === undefined ? {} : { explain: winner.explain }),
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

function roundCandidate(candidate: GroupedCandidate): MatchCandidate {
  return {
    code: candidate.code,
    record: candidate.record,
    score: roundToTwoDecimals(candidate.score),
    reasons: candidate.reasons.map((reason) => ({
      ...reason,
      weight: roundToTwoDecimals(reason.weight),
    })),
    offerings: candidate.offerings,
    ...(candidate.lens === undefined ? {} : { lensRules: candidate.lens.hits.map((hit) => hit.rule) }),
  };
}

function compareByScore(a: GroupedCandidate, b: GroupedCandidate): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  const aScheduled = a.record.startDate !== null;
  const bScheduled = b.record.startDate !== null;
  if (aScheduled !== bScheduled) {
    return aScheduled ? -1 : 1;
  }
  return a.code.localeCompare(b.code);
}

/**
 * Fix and Next-level ordering: one ranked list per activated rule (signal strength first, then
 * profile relevance), merged round-robin with rules ordered by their best candidate's score. A
 * session several rules admitted appears once, at its earliest position. Without this, general
 * relevance ranks everything after admission and a session that mentions a rule's phrase in
 * passing (and shares the repo's services) buries the precise one.
 */
function interleaveByRule(candidates: readonly GroupedCandidate[]): GroupedCandidate[] {
  const lists = new Map<string, { candidate: GroupedCandidate; strength: number }[]>();
  for (const candidate of candidates) {
    for (const hit of candidate.lens?.hits ?? []) {
      const list = lists.get(hit.rule) ?? [];
      list.push({ candidate, strength: hit.strength });
      lists.set(hit.rule, list);
    }
  }
  const ranked = [...lists.entries()].map(([rule, list]) => ({
    rule,
    list: list
      .sort((a, b) =>
        b.strength - a.strength
        || b.candidate.lens!.relevance - a.candidate.lens!.relevance
        || compareByScore(a.candidate, b.candidate))
      .map((entry) => entry.candidate),
  }));
  ranked.sort((a, b) =>
    Math.max(...b.list.map((c) => c.score)) - Math.max(...a.list.map((c) => c.score))
    || a.rule.localeCompare(b.rule));

  const merged: GroupedCandidate[] = [];
  const emitted = new Set<string>();
  for (let depth = 0; ranked.some(({ list }) => depth < list.length); depth++) {
    for (const { list } of ranked) {
      const candidate = list[depth];
      if (candidate !== undefined && !emitted.has(candidate.code)) {
        emitted.add(candidate.code);
        merged.push(candidate);
      }
    }
  }
  return merged;
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
  return matchSessionsDetailed(profile, deps, options).candidates;
}

const NO_CORE_SERVICES_REASON = "profile has no core services to check stack fit";

/** Paths already taken, plus -- when the profile has no core service, so the stack gate admits
 * nothing -- every other activated rule, so an empty result says why. */
function lensSkippedRules(profile: ResolvedProfile, lens: "fix" | "next-level"): SkippedRule[] {
  const taken = skippedLensRules(profile, lens);
  if (hasCoreService(profile)) {
    return taken;
  }
  return [
    ...taken,
    ...activeLensRules(profile, lens).map((rule) => ({ rule, reason: NO_CORE_SERVICES_REASON })),
  ];
}

/**
 * The Explain lens: the sessions that teach the technologies and architecture the profile is built
 * on (see `explain.ts`). Repeat sittings are grouped before selection, so a talk counts once, and
 * each candidate's reasons name the concept and the code that uses it. A profile concept no session
 * is about comes back in `uncovered` rather than being filled with weaker matches.
 */
function matchExplain(
  profile: ResolvedProfile,
  index: readonly IndexRecord[],
  rawById: ReadonlyMap<string, { abstract?: string }>,
  query: MatchQuery,
  corpusStats: ReturnType<typeof buildCorpusStats>,
  limit: number | undefined,
): MatchResult {
  const { typeWeights } = getLensProfile("explain");
  const { concepts, uncovered: unmapped } = buildConcepts(profile);
  const scored: ScoredRecord[] = [];
  for (const record of index) {
    const matches = matchConcepts(concepts, record, rawById.get(record.sessionId)?.abstract ?? "");
    if (matches.length > 0) {
      scored.push({ record, score: scoreSession(record, query, corpusStats).score, reasons: [], explain: matches });
    }
  }
  const groups = groupByCode(scored);
  const byCode = new Map(groups.map((group) => [group.code, group]));
  const { selected, uncovered } = selectExplain(
    groups.map((group) => ({ key: group.code, record: group.record, matches: group.explain!, rank: group.score })),
    concepts,
    typeWeights,
  );
  const candidates = selected.map((entry) => explainCandidate(byCode.get(entry.key)!, entry.matches, profile, typeWeights));
  return {
    candidates: (limit === undefined ? candidates : candidates.slice(0, limit)).map(roundCandidate),
    skippedRules: [],
    uncovered: [...uncovered, ...unmapped],
  };
}

function explainCandidate(
  group: GroupedCandidate,
  matches: readonly ConceptMatch[],
  profile: ResolvedProfile,
  typeWeights: ReadonlyMap<string, number>,
): GroupedCandidate {
  const reasons: Reason[] = matches.map((match) => explainReason(match, profile.repos.length));
  const formatBonus = group.record.type === null ? undefined : typeWeights.get(group.record.type);
  if (formatBonus !== undefined) {
    reasons.push({
      kind: "format",
      detail: `${group.record.type} sessions are favored under the explain lens.`,
      weight: formatBonus,
      evidence: group.record.type!,
    });
  }
  return { ...group, reasons, score: reasons.reduce((sum, reason) => sum + reason.weight, 0) };
}

/** `matchSessions` plus what the ranking itself decided to skip -- see `MatchResult`. */
export function matchSessionsDetailed(
  profile: ResolvedProfile,
  deps: CatalogStoreDeps,
  options: MatchOptions = {},
): MatchResult {
  const lens = options.lens ?? "all";
  const lensProfile = getLensProfile(lens);
  const index = requireCurrentIndex(deps);
  const query = buildMatchQuery(profile);
  const rawById = lens !== "all"
    ? new Map((readRaw(deps) ?? []).map(session => [session.sessionId, session]))
    : undefined;
  // Built once, over the whole loaded catalog, and reused for every candidate below -- inverse
  // document frequency is a corpus-wide statistic, not a per-record one; computing it fresh per
  // record would be both wasteful and simply wrong, since it needs to see every document to know
  // how rare a term actually is.
  const corpusStats = buildCorpusStats(index);

  if (lens === "explain") {
    return matchExplain(profile, index, rawById!, query, corpusStats, options.limit);
  }

  // Fix has to be pickier than Next-level: its phrases (alarms, tests, IAM) appear in talks about any
  // stack, so one shared near-universal service such as CloudWatch is not evidence of fit.
  const fitsStack = buildStackFit(profile, lens === "fix"
    ? { minDistinct: 2, rareBelow: RARE_SERVICE_FRACTION, catalog: index }
    : {});
  const scoredRecords: ScoredRecord[] = [];

  for (const record of index) {
    if (lensProfile.levelBands !== null) {
      if (record.levelBand === null || !lensProfile.levelBands.includes(record.levelBand)) {
        continue;
      }
    }

    const lensBase = lens === "fix" || lens === "next-level"
      ? scoreLensSignals(record, profile, lens, rawById?.get(record.sessionId)?.abstract, fitsStack)
      : undefined;
    const base = lensBase ?? scoreSession(record, query, corpusStats);
    // Gated on the scorer's own score, before the lens's format bonus is even considered -- a
    // format preference is a tiebreak among sessions that already share a real signal with the
    // profile (a service, a topic, an area of interest, or free-text overlap), never a standalone
    // reason to include a session that shares nothing with it at all. Gating on the *combined*
    // score instead (the bug this replaced) let being a Breakout session or Chalk talk alone earn
    // a place in the results, and outrank a session with a real but modest text match.
    if (base.score <= 0) {
      continue;
    }

    let score = base.score;
    const reasons = [...base.reasons];
    let lensInfo: LensInfo | undefined;
    if (lensBase !== undefined) {
      const relevance = scoreSession(record, query, corpusStats);
      score += relevance.score;
      reasons.push(...relevance.reasons);
      lensInfo = { hits: lensBase.hits, relevance: relevance.score };
    }

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

    scoredRecords.push({ record, score, reasons, ...(lensInfo === undefined ? {} : { lens: lensInfo }) });
  }

  const candidates = groupByCode(scoredRecords);

  const isLens = lens === "fix" || lens === "next-level";
  const ordered = isLens ? interleaveByRule(candidates) : candidates.sort(compareByScore);

  const limited = options.limit === undefined ? ordered : ordered.slice(0, options.limit);
  return {
    candidates: limited.map(roundCandidate),
    skippedRules: isLens ? lensSkippedRules(profile, lens) : [],
  };
}
