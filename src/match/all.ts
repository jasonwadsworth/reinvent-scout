import type { IndexRecord } from "../catalog/index-record.js";
import {
  admitConcepts, CERTIFICATION, CUSTOMER_STORY, EXPLAINER, MODERNIZATION, NAMED_STORY, NEWS, PARTNER, SPONSORED, STORY, usedAt,
  TITLE_STRENGTH, type AbsentTopic, type Admission, type ConceptMatch, type ProfileConcept,
} from "./concepts.js";
import type { Reason } from "./score.js";

/** The All lens asks "which sessions are about what this code is built on", at any level: a concept
 * counts when the title names it or the abstract does, corroborated when it does so only once. */
const ALL_ADMISSION: Admission = { singleCorroborated: true, broadNeedsBuildCue: false };

/** Sessions nobody can attend as a session about the technology: AWS Partner bootcamps and
 * certification or exam preparation. */
function excluded(record: IndexRecord): boolean {
  return record.type === "Exam prep" || [PARTNER, CERTIFICATION].some(pattern => pattern.test(record.title));
}

/** The concepts a session is about, none when it cannot be attended as such. */
export function matchAllConcepts(concepts: readonly ProfileConcept[], record: IndexRecord, abstract: string): ConceptMatch[] {
  if (excluded(record)) return [];
  const matches = admitConcepts(concepts, record, abstract, ALL_ADMISSION);
  // A broad topic (agents, generative AI) is too widespread to make a session about the code on its own: it
  // adds to a session that names something else the profile has, and never admits one alone.
  if (matches.every(match => match.concept.titleOnly)) return [];
  // Patterns are words a session uses about anything ("serverless", "event-driven"): with no service of the
  // profile among them, one must be named in the title to make the session about it.
  const onlyPatterns = matches.every(match => match.concept.kind === "pattern");
  return onlyPatterns && !matches.some(match => match.strength === TITLE_STRENGTH) ? [] : matches;
}

/** A sponsored code ends in "-S" (and, for a repeat, a number). */
const SPONSORED_CODE = /-S\d*$/;

/** Why a session ranks after every other: a vendor's pitch, a news or launch talk, what one customer built,
 * tooling that moves code onto the concept, a session made for an industry, or a talk about a broad
 * topic (agents, generative AI) the code does not use. Still worth listing for someone who has the basics. */
export function demotionReason(record: IndexRecord, abstract: string, absent: readonly AbsentTopic[] = []): string | undefined {
  const about = absent.find(topic => topic.phrase.test(record.title));
  const reasons = [
    SPONSORED.test(record.title) || SPONSORED_CODE.test(record.abbreviation ?? "") ? "sponsored session" : undefined,
    NEWS.test(record.title) ? "news or launch session" : undefined,
    (STORY.test(record.title) && !EXPLAINER.test(record.title)) || CUSTOMER_STORY.test(abstract) || NAMED_STORY.test(abstract) ? "customer story" : undefined,
    MODERNIZATION.test(record.title) ? "modernization or migration session" : undefined,
    record.industries.length > 0 ? "industry session" : undefined,
    about === undefined ? undefined : `about ${about.label}, which this code does not use`,
  ].filter((reason): reason is string => reason !== undefined);
  return reasons.length === 0 ? undefined : reasons.join(" and ");
}

/** A catalog session (repeat sittings already grouped) with the concepts it is about. */
export interface AllSession {
  key: string;
  record: IndexRecord;
  matches: ConceptMatch[];
  /** How relevant the whole session is to the profile; the last word between otherwise equal sessions. */
  relevance: number;
  demoted?: string;
}

export interface RankedAll {
  key: string;
  /** Every concept the session is about; the one it is most about comes first. */
  matches: ConceptMatch[];
}

const isInterest = (match: ConceptMatch): boolean => match.concept.kind === "interest";

/** The concepts the session is about, most about first: the strongest match, an evidenced concept before a
 * stated interest, then the most central. */
function primaryFirst(matches: readonly ConceptMatch[]): ConceptMatch[] {
  return [...matches].sort((a, b) => b.strength - a.strength || Number(isInterest(a)) - Number(isInterest(b)) || b.concept.centrality - a.concept.centrality || a.concept.name.localeCompare(b.concept.name));
}

interface Ranked {
  session: AllSession;
  matches: ConceptMatch[];
  centrality: number;
  strongest: number;
  /** Some concept of the profile's evidence, not only a stated interest. */
  evidenced: boolean;
}

const TOP = 10;
const TOP_SHARE = 3;
/** With fewer concepts than this admitting any session, capping a concept's share would leave the list thin. */
const MIN_CONCEPTS_FOR_CAP = 4;

/**
 * Orders sessions by, in sequence: demoted sessions after every other; the strongest match (a title that
 * names a concept before an abstract that only does); a session about the profile's evidence before one
 * about only a stated interest; the summed centrality of the concepts they are
 * about (the code's central concepts first); the number of concepts; relevance; a scheduled session
 * before an unscheduled one; the key. Each key is compared only when the ones before it tie; none is
 * added to another. Then no concept is the main subject of more than three of the first ten, unless
 * fewer than four concepts have any session; what the cap holds back follows in order.
 */
export function rankAll(sessions: readonly AllSession[]): RankedAll[] {
  const ranked = sessions.map((session): Ranked => {
    const matches = primaryFirst(session.matches);
    return {
      session, matches,
      centrality: matches.reduce((sum, match) => sum + match.concept.centrality, 0),
      strongest: Math.max(...matches.map(match => match.strength)),
      evidenced: matches.some(match => !isInterest(match)),
    };
  });
  ranked.sort((a, b) =>
    Number(a.session.demoted !== undefined) - Number(b.session.demoted !== undefined)
    || b.strongest - a.strongest
    || Number(b.evidenced) - Number(a.evidenced)
    || b.centrality - a.centrality
    || b.matches.length - a.matches.length
    || b.session.relevance - a.session.relevance
    || Number(b.session.record.startDate !== null) - Number(a.session.record.startDate !== null)
    || a.session.key.localeCompare(b.session.key));
  const admitted = new Set(ranked.flatMap(entry => entry.matches.map(match => match.concept)));
  const capped = admitted.size >= MIN_CONCEPTS_FOR_CAP;
  const top: Ranked[] = [];
  const held: Ranked[] = [];
  const share = new Map<ProfileConcept, number>();
  for (const entry of ranked) {
    const main = entry.matches[0]!.concept;
    if (capped && top.length < TOP && (share.get(main) ?? 0) >= TOP_SHARE) {
      held.push(entry);
      continue;
    }
    if (top.length < TOP) share.set(main, (share.get(main) ?? 0) + 1);
    top.push(entry);
  }
  return [...top, ...held].map(entry => ({ key: entry.session.key, matches: entry.matches }));
}


const BASE_WEIGHT = 20;
const STRENGTH_WEIGHT = 10;

/** Why a session is listed: the concept it is about, the phrase that says so, and where the code uses it. */
export function allReason(match: ConceptMatch, repoCount: number): Reason {
  const { citations, where } = usedAt(match.concept, repoCount);
  return {
    kind: "matchesConcept",
    detail: `Matches ${match.concept.kind === "interest" ? "your interest in " : ""}${match.concept.name} ("${match.phrase}")${where}.`,
    evidence: match.phrase, profileEvidence: citations,
    weight: BASE_WEIGHT + STRENGTH_WEIGHT * (match.strength + (match.boosted ? 1 : 0)),
  };
}
