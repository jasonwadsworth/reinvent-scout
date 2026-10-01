import type { IndexRecord } from "../catalog/index-record.js";
import {
  admitConcepts, BUILD_CUE, CERTIFICATION, EXPLAINER, mentionsOf, namedStorySubjects, NEWS, PARTNER, SPONSORED, STORY, TITLE_STRENGTH, usedAt,
  type AbsentTopic, type Admission, type ConceptMatch, type ProfileConcept,
} from "./concepts.js";
import type { Reason } from "./score.js";
import { offStackAbout, type OffStack } from "./off-stack.js";

/** The All lens asks "which sessions are about what this code is built on", at any level: a concept
 * counts when the title names it or the abstract does, corroborated when it does so only once. */
const ALL_ADMISSION: Admission = { singleCorroborated: true, broadNeedsBuildCue: false };

/** Sessions nobody can attend as a session about the technology: AWS Partner bootcamps and
 * certification or exam preparation. */
function excluded(record: IndexRecord): boolean {
  return record.type === "Exam prep" || [PARTNER, CERTIFICATION].some(pattern => pattern.test(record.title));
}

/** The services of the profile the session names: `any` anywhere, in a list or not; `outsideLists` only where it is not
 * one name among an enumeration. */
function namedProfileServices(concepts: readonly ProfileConcept[], record: IndexRecord, abstract: string): { any: ProfileConcept[]; outsideLists: ProfileConcept[] } {
  const services = concepts.filter(concept => concept.kind === "service");
  const outside = (concept: ProfileConcept): boolean => [record.title, abstract].some(text => mentionsOf(concept.matchers, text).length > 0);
  const listed = (concept: ProfileConcept): boolean => [record.title, abstract].some(text => mentionsOf(concept.matchers, text, true).length > 0);
  return { any: services.filter(concept => outside(concept) || listed(concept)), outsideLists: services.filter(outside) };
}

/** The profile's services that fewer than `fraction` of the catalog's sessions name, in a list or not: a rare name in a
 * session's list (Claude Code) says something about the session, a common one (Lambda) does not. */
export function rareProfileServices(concepts: readonly ProfileConcept[], records: readonly IndexRecord[], abstractOf: (record: IndexRecord) => string, fraction: number): Set<ProfileConcept> {
  const named = new Map<ProfileConcept, number>();
  for (const record of records) {
    for (const concept of namedProfileServices(concepts, record, abstractOf(record)).any) named.set(concept, (named.get(concept) ?? 0) + 1);
  }
  return new Set(concepts.filter(concept => concept.kind === "service" && (named.get(concept) ?? 0) < fraction * records.length));
}

/** The concepts a session is about, none when it cannot be attended as such. `rare` are the profile's services that few
 * sessions name: one a session only lists adds weight to a session that is already about something. */
export function matchAllConcepts(concepts: readonly ProfileConcept[], record: IndexRecord, abstract: string, rare: ReadonlySet<ProfileConcept> = new Set()): ConceptMatch[] {
  const matches = admittedConcepts(concepts, record, abstract);
  if (matches.length === 0 || rare.size === 0) return matches;
  const matched = new Set(matches.map(match => match.concept));
  const listed = namedProfileServices(concepts, record, abstract).any.filter(concept => rare.has(concept) && !matched.has(concept));
  return [...matches, ...listed.map(named)];
}

const named = (concept: ProfileConcept): ConceptMatch =>
  ({ concept, strength: 1, phrase: concept.name, boosted: false, site: { inTitle: false, index: -1, length: 0 } });

function admittedConcepts(concepts: readonly ProfileConcept[], record: IndexRecord, abstract: string): ConceptMatch[] {
  if (excluded(record)) return [];
  const matches = admitConcepts(concepts, record, abstract, ALL_ADMISSION);
  // A broad topic (agents, generative AI) is too widespread to make a session about the code on its own: alone,
  // the title must also say how to build or design it (as in the Explain lens), or the session must name a service
  // of the profile (even in a list), which is what ties the topic to this code. That service then counts as named.
  if (matches.length > 0 && matches.every(match => match.concept.titleOnly)) {
    const services = namedProfileServices(concepts, record, abstract);
    if (!BUILD_CUE.test(record.title) && services.any.length === 0) return [];
    // A service named only in a list may admit the session but adds no weight to it (unless it is rare: see `matchAllConcepts`).
    return [...matches, ...services.outsideLists.map(named)];
  }
  // Patterns are words a session uses about anything ("serverless", "event-driven"): with no service of the
  // profile among them, one must be named in the title to make the session about it.
  const onlyPatterns = matches.every(match => match.concept.kind === "pattern");
  return onlyPatterns && !matches.some(match => match.strength === TITLE_STRENGTH) ? [] : matches;
}

/** A sponsored code ends in "-S" (and, for a repeat, a number). */
const SPONSORED_CODE = /-S\d*$/;
/** A customer the catalog marks in the abstract. The abstract's own "how customers ..." is description, not a story. */
const CUSTOMER_MARKER = /\[customer\]/i;
/** Tooling and programs that move code onto a technology. A technical talk about modernizing one does not count. */
const MIGRATION_PROGRAM = /\bAWS Transform\b|\b(?:migration|modernization) (?:acceleration|program|factory|hub|tooling|assessment)\b/i;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What decides which sessions are demoted, beyond the session itself. */
export interface DemotionContext {
  /** Broad topics the profile does not use. */
  absent?: readonly AbsentTopic[];
  /** Short names of the services of the catalog and the profile ("Kiro", "Lambda"): a session that says how one works,
   * or one that "built" something, is about the service and not a customer. */
  services?: readonly string[];
  /** Words the catalog's industry names are made of (see `industryTerms`). */
  industries?: readonly string[];
  /** Technologies the profile does not use (see `offStackOf`): a title about one is about it, not about the code. */
  offStack?: OffStack;
}


const INDUSTRY_FILLER: readonly string[] = ["and", "services", "goods", "life", "sciences"];

/** The words of the catalog's industry names ("Media & Entertainment" gives media and entertainment). */
export function industryTerms(records: readonly IndexRecord[]): string[] {
  const words = records.flatMap(record => record.industries).flatMap(name => name.toLowerCase().split(/[^a-z]+/));
  return [...new Set(words.filter(word => word !== "" && !INDUSTRY_FILLER.includes(word)))];
}

function namesService(text: string, services: readonly string[]): boolean {
  return services.some(service => new RegExp(`^${escapeRegExp(service)}\\b`, "i").test(text));
}

/** The title frames the session as a story ("How Deutsche Bahn made ..."), unless it is a how-to or says how a service works. */
function titleStory(title: string, services: readonly string[]): boolean {
  if (!STORY.test(title) || EXPLAINER.test(title)) return false;
  const after = /(?:^|[:\-–—]\s+)how\s+(.*)$/i.exec(title)?.[1] ?? "";
  return !namesService(after, services);
}

/** Why a session ranks after every other: a vendor's pitch, a news or launch talk, what one customer built,
 * migration tooling, a session made for an industry, or a talk about a broad topic (agents, generative AI) the
 * code does not use. Still worth listing for someone who has the basics. */
export function demotionReason(record: IndexRecord, abstract: string, context: DemotionContext = {}): string | undefined {
  const { absent = [], services = [], industries = [], offStack } = context;
  const about = absent.find(topic => topic.phrase.test(record.title));
  const tool = offStack === undefined ? undefined : offStackAbout(record.title, offStack);
  // An industry session applies technology to a vertical's problem: the title names the vertical, or does not say it is about building
  // or designing the technology (as "Build a flash-sale control plane with CloudFront" does).
  const industry = record.industries.length > 0
    && (!BUILD_CUE.test(record.title) || industries.some(word => new RegExp(`\\b${escapeRegExp(word)}`, "i").test(record.title)));
  const story = titleStory(record.title, services) || CUSTOMER_MARKER.test(abstract)
    || namedStorySubjects(abstract).some(subject => !namesService(subject, services));
  const reasons = [
    SPONSORED.test(record.title) || SPONSORED_CODE.test(record.abbreviation ?? "") ? "sponsored session" : undefined,
    NEWS.test(record.title) ? "news or launch session" : undefined,
    story ? "customer story" : undefined,
    MIGRATION_PROGRAM.test(record.title) ? "modernization or migration session" : undefined,
    industry ? "industry session" : undefined,
    about === undefined && tool === undefined ? undefined : `about ${[about?.label, tool].filter(label => label !== undefined).join(" and ")}, which this code does not use`,
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
  /** From the user's format preferences: 1 preferred, -1 avoided, 0 neither. */
  tier?: number;
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
 * Orders sessions by, in sequence: demoted sessions after every other; the user's preferred formats before neutral ones before avoided ones; the strongest match (a title that
 * names a concept before an abstract that only does); a session about the profile's evidence before one
 * about only a stated interest; the summed centrality of the concepts they are
 * about (the code's central concepts first); the number of concepts; relevance; a scheduled session
 * before an unscheduled one; the key. Each key is compared only when the ones before it tie; none is
 * added to another. Then no concept is the main subject of more than three of the first ten, unless
 * fewer than four concepts have any session. After the ten come the sessions the cap held back and the rest
 * of the undemoted ones, in rank order; the demoted sessions come last, in rank order.
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
    || (b.session.tier ?? 0) - (a.session.tier ?? 0)
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
  const rest: Ranked[] = [];
  const share = new Map<ProfileConcept, number>();
  for (const entry of ranked.filter(candidate => candidate.session.demoted === undefined)) {
    const main = entry.matches[0]!.concept;
    if (top.length >= TOP || (capped && (share.get(main) ?? 0) >= TOP_SHARE)) {
      rest.push(entry);
      continue;
    }
    share.set(main, (share.get(main) ?? 0) + 1);
    top.push(entry);
  }
  return [...top, ...rest, ...ranked.filter(candidate => candidate.session.demoted !== undefined)].map(entry => ({ key: entry.session.key, matches: entry.matches }));
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
