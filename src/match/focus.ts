import { ValidationError } from "../core/errors.js";
import type { CatalogStoreDeps } from "../catalog/store.js";
import { readRaw } from "../catalog/store.js";
import { requireCurrentIndex } from "../catalog/query.js";
import { hasCoreService } from "./stack-fit.js";
import { selectExplain } from "./explain.js";
import { getLensProfile } from "./lens.js";
import {
  allRanked, explainCandidate, explainSessions, knownServices, lensSkippedRules, roundCandidate, rulesRanked, whyFor, buildMatchQuery,
  type GroupedCandidate, type LensContext, type MatchCandidate,
} from "./match.js";
import { buildCorpusStats } from "./score.js";
import { conceptKey, GOALS, buildTopics, type Goal, type Topic } from "./topics.js";
import type { ResolvedProfile } from "../profile/profile.js";

export interface FocusChoice {
  topic: string;
  goal: Goal;
}

export interface FocusOptions {
  /** How many sessions each choice lists. Defaults to 5; 1 to 10. */
  perTopic?: number;
}

/** A session listed under a choice, with the later choices it would also have matched. */
export type FocusCandidate = MatchCandidate & { alsoMatches?: string[] };

export interface FocusEntry {
  topic: string;
  goal: Goal;
  /** Every session this choice alone would list, before the cap and before sessions an earlier choice took. */
  total: number;
  candidates: FocusCandidate[];
  /** Why there are no sessions, when there are none. */
  reason?: string;
}

export interface FocusResult {
  results: FocusEntry[];
}

export const MAX_FOCUS_CHOICES = 6;
export const DEFAULT_PER_TOPIC = 5;
export const MAX_PER_TOPIC = 10;

interface Listed {
  candidates: MatchCandidate[];
  reason?: string;
}

/** What `mapProfile` and `matchFocus` both read: the topics of a profile and, per topic and goal, the sessions its lens would list. */
export interface FocusEngine {
  topics: Topic[];
  list(topic: Topic, goal: Goal): Listed;
}

const NO_INTRODUCTION = "no introductory (100/200) session names it in its title or twice in its abstract";

export function createFocusEngine(profile: ResolvedProfile, deps: CatalogStoreDeps): FocusEngine {
  const index = requireCurrentIndex(deps);
  const rawById = new Map((readRaw(deps) ?? []).map(session => [session.sessionId, session]));
  const ctx: LensContext = {
    profile, index, rawById, query: buildMatchQuery(profile), corpusStats: buildCorpusStats(index),
    abstractOf: record => rawById.get(record.sessionId)?.abstract ?? "",
  };
  const topics = buildTopics(profile, knownServices(profile, index));
  const cache = new Map<string, unknown>();
  const once = <T>(key: string, build: () => T): T => {
    if (!cache.has(key)) cache.set(key, build());
    return cache.get(key) as T;
  };
  const finish = (candidates: readonly GroupedCandidate[], lens: "all" | "explain" | "fix" | "next-level"): MatchCandidate[] =>
    candidates.map(candidate => roundCandidate(candidate, whyFor(candidate, lens, profile, ctx.abstractOf)));

  const understand = (topic: Topic): Listed => {
    const { concepts, unmapped, groups } = once("explain", () => explainSessions(ctx));
    const concept = concepts.find(candidate => conceptKey(candidate) === topic.conceptKey);
    if (concept === undefined) {
      const unworded = unmapped.find(entry => entry.concept.toLowerCase() === topic.label.toLowerCase());
      return { candidates: [], reason: unworded?.reason ?? NO_INTRODUCTION };
    }
    const typeWeights = getLensProfile("explain").typeWeights;
    const byCode = new Map(groups.map(group => [group.code, group]));
    const sessions = groups.filter(group => group.explain!.some(match => match.concept === concept))
      .map(group => ({ key: group.code, record: group.record, matches: group.explain!.filter(match => match.concept === concept), rank: group.score }));
    const { selected, uncovered } = selectExplain(sessions, [concept], typeWeights);
    const candidates = finish(selected.map(entry => explainCandidate(byCode.get(entry.key)!, entry.matches, profile, typeWeights)), "explain");
    return candidates.length > 0 ? { candidates } : { candidates, reason: uncovered[0]?.reason ?? NO_INTRODUCTION };
  };

  const deepen = (topic: Topic): Listed => {
    const ranked = once("all", () => allRanked(ctx)).filter(candidate => candidate.explain!.some(match => conceptKey(match.concept) === topic.conceptKey));
    const candidates = finish(ranked, "all");
    return candidates.length > 0 ? { candidates } : { candidates, reason: `no session names ${topic.label} in its title or abstract` };
  };

  const improve = (topic: Topic): Listed => {
    if (topic.skipped !== undefined) return { candidates: [], reason: topic.skipped };
    const lens = topic.group === "gaps" ? "fix" : "next-level";
    const ranked = once(lens, () => rulesRanked(ctx, lens)).filter(candidate => candidate.lens?.hits.some(hit => hit.rule === topic.rule) === true);
    const candidates = finish(ranked, lens);
    if (candidates.length > 0) return { candidates };
    const blocked = lensSkippedRules(profile, lens).find(entry => entry.rule === topic.rule);
    return { candidates, reason: blocked?.reason ?? (hasCoreService(profile) ? "no session addresses it for your stack" : "profile has no core services to check stack fit") };
  };

  return {
    topics,
    list: (topic, goal) => once(`${topic.id}|${goal}`, () => goal === "understand" ? understand(topic) : goal === "deepen" ? deepen(topic) : improve(topic)),
  };
}

/** The profile's topics, without counting sessions: what a typed topic name is resolved against. */
export function profileTopics(profile: ResolvedProfile, deps: CatalogStoreDeps): Topic[] {
  return buildTopics(profile, knownServices(profile, requireCurrentIndex(deps)));
}

const ids = (topics: readonly Topic[]): string => topics.map(topic => topic.id).join(", ");

function validate(topics: readonly Topic[], choices: readonly FocusChoice[], perTopic: number): Topic[] {
  if (choices.length < 1 || choices.length > MAX_FOCUS_CHOICES) {
    throw new ValidationError(`Focus takes 1 to ${MAX_FOCUS_CHOICES} choices, got ${choices.length}.`);
  }
  if (!Number.isInteger(perTopic) || perTopic < 1 || perTopic > MAX_PER_TOPIC) {
    throw new ValidationError(`perTopic must be a whole number from 1 to ${MAX_PER_TOPIC}, got ${perTopic}.`);
  }
  return choices.map(choice => {
    const topic = topics.find(candidate => candidate.id === choice.topic);
    if (topic === undefined) throw new ValidationError(`Unknown topic "${choice.topic}". Valid topics: ${ids(topics)}.`);
    if (!GOALS.includes(choice.goal)) throw new ValidationError(`Unknown goal "${String(choice.goal)}". Goals: ${GOALS.join(", ")}.`);
    // A next step the profile already took keeps its goal, which then says why it has nothing to offer.
    const applicable = topic.group === "gaps" || topic.group === "nextSteps" ? ["improve"] : ["understand", "deepen"];
    if (!applicable.includes(choice.goal)) {
      throw new ValidationError(`Goal "${choice.goal}" does not apply to "${topic.id}" (applicable: ${applicable.join(", ")}).`);
    }
    return topic;
  });
}

/**
 * The sessions for each of the user's choices: one topic of the profile and what to do with it. Each choice runs the lens that
 * goal stands for, restricted to that topic, with that lens's own admission, demotions and ranking. A session listed under an
 * earlier choice is left out of later ones, which the earlier candidate notes in `alsoMatches`.
 */
export function matchFocus(profile: ResolvedProfile, deps: CatalogStoreDeps, choices: readonly FocusChoice[], options: FocusOptions = {}): FocusResult {
  const engine = createFocusEngine(profile, deps);
  const perTopic = options.perTopic ?? DEFAULT_PER_TOPIC;
  const topics = validate(engine.topics, choices, perTopic);
  const taken = new Map<string, FocusCandidate>();
  const results = choices.map((choice, position): FocusEntry => {
    const topic = topics[position]!;
    const { candidates, reason } = engine.list(topic, choice.goal);
    const fresh: FocusCandidate[] = [];
    for (const candidate of candidates) {
      const earlier = taken.get(candidate.code);
      if (earlier === undefined) {
        const copy: FocusCandidate = { ...candidate };
        fresh.push(copy);
        taken.set(candidate.code, copy);
      } else {
        earlier.alsoMatches = [...(earlier.alsoMatches ?? []), topic.id];
      }
    }
    const listed = fresh.slice(0, perTopic);
    return { topic: topic.id, goal: choice.goal, total: candidates.length, candidates: listed, ...(candidates.length === 0 && reason !== undefined ? { reason } : {}) };
  });
  return { results };
}
