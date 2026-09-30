import type { IndexRecord } from "../catalog/index-record.js";
import {
  admitConcepts, CERTIFICATION, CUSTOMER_STORY, EXPLAIN_ADMISSION, EXPLAINER, INTRO_CUE, MODERNIZATION, NEWS, NON_EXPLANATORY_TYPES,
  PARTNER, SPONSORED, STORY, TITLE_STRENGTH, usedAt, type ConceptMatch, type ProfileConcept, type UncoveredConcept,
} from "./concepts.js";
import { getLensProfile } from "./lens.js";
import type { Reason } from "./score.js";

/** The concepts an introductory session is about; a session that is a pitch, news, a story, training or a
 * game is about none. */
export function matchConcepts(concepts: readonly ProfileConcept[], record: IndexRecord, abstract: string): ConceptMatch[] {
  if (CUSTOMER_STORY.test(abstract) || (record.type !== null && NON_EXPLANATORY_TYPES.includes(record.type))) return [];
  if (SPONSORED.test(record.title) || [NEWS, MODERNIZATION, CERTIFICATION, PARTNER].some(pattern => pattern.test(record.title))
    || (STORY.test(record.title) && !EXPLAINER.test(record.title))) return [];
  return admitConcepts(concepts, record, abstract, EXPLAIN_ADMISSION);
}

/** Level 100 and 200: what the Explain lens is for. */
const INTRODUCTORY_BANDS: readonly number[] = getLensProfile("explain").levelBands ?? [];
const ADVANCED_BAND = 300;
const NO_INTRODUCTION_REASON = "no introductory (100/200) session is about it; the closest is a 300-level one";
const NOT_COVERED_REASON = "no introductory (100/200) or 300-level session is about it";

/** A catalog session (repeat sittings already grouped) with the concepts it is about. */
export interface ExplainSession {
  key: string;
  record: IndexRecord;
  matches: ConceptMatch[];
  /** Breaks ties between equally strong matches: how relevant the session is to the profile. */
  rank: number;
}

export interface ExplainSelection {
  key: string;
  /** Every concept the session explains; the one it was taken for comes first. */
  matches: ConceptMatch[];
}

interface Option {
  session: ExplainSession;
  match: ConceptMatch;
  /** Compared in this order, never added: a title beats an abstract whatever else is true. */
  introduction: boolean;
  format: number;
}

/**
 * Picks sessions round-robin across concepts in centrality order, the best session per concept each
 * round, so a short list covers as many concepts as it can. A concept a session already explains
 * does not take another session in the first round. Only level 100 and 200 sessions are listed. A
 * concept none of them is about is reported as uncovered; when a 300-level session names it in its
 * title, that session is named in the reason, but it is not listed because a 300-level talk does not
 * introduce anything. A concept with no session at all is reported as uncovered too.
 */
export function selectExplain(
  sessions: readonly ExplainSession[],
  concepts: readonly ProfileConcept[],
  typeWeights: ReadonlyMap<string, number> = getLensProfile("explain").typeWeights,
): { selected: ExplainSelection[]; uncovered: UncoveredConcept[] } {
  const introductoryBand = (session: ExplainSession): boolean =>
    session.record.levelBand !== null && INTRODUCTORY_BANDS.includes(session.record.levelBand);
  const bestFirst = (a: Option, b: Option): number =>
    b.match.strength - a.match.strength
    || Number(b.match.boosted) - Number(a.match.boosted)
    || Number(b.introduction) - Number(a.introduction)
    || b.format - a.format
    || b.session.rank - a.session.rank
    || a.session.key.localeCompare(b.session.key);
  const options = new Map<ProfileConcept, Option[]>(concepts.map(concept => [concept, []]));
  const advanced = new Map<ProfileConcept, Option[]>(concepts.map(concept => [concept, []]));
  for (const session of sessions) {
    const target = introductoryBand(session) ? options : session.record.levelBand === ADVANCED_BAND ? advanced : undefined;
    for (const match of target === undefined ? [] : session.matches) {
      target!.get(match.concept)?.push({
        session, match, introduction: INTRO_CUE.test(session.record.title),
        format: session.record.type === null ? 0 : (typeWeights.get(session.record.type) ?? 0),
      });
    }
  }
  const queues = new Map<ProfileConcept, Option[]>();
  for (const [concept, list] of options) {
    queues.set(concept, list.sort(bestFirst).slice());
  }

  const selected: ExplainSelection[] = [];
  const taken = new Set<string>();
  const covered = new Set<ProfileConcept>();
  const order = new Map(concepts.map((concept, index) => [concept, index]));
  const take = (concept: ProfileConcept): void => {
    const queue = queues.get(concept)!;
    while (queue.length > 0 && taken.has(queue[0]!.session.key)) queue.shift();
    const option = queue.shift();
    if (option === undefined) return;
    taken.add(option.session.key);
    const positionOf = (match: ConceptMatch): number => match.concept === option.match.concept ? -1 : order.get(match.concept)!;
    const matches = option.session.matches
      .flatMap(match => options.get(match.concept)?.find(entry => entry.session === option.session)?.match ?? [])
      .sort((a, b) => positionOf(a) - positionOf(b));
    for (const match of matches) covered.add(match.concept);
    selected.push({ key: option.session.key, matches });
  };
  const withIntroduction = concepts.filter(concept => options.get(concept)!.length > 0);
  for (let round = 0; withIntroduction.some(concept => queues.get(concept)!.length > 0); round++) {
    for (const concept of withIntroduction) {
      if (!(round === 0 && covered.has(concept))) take(concept);
    }
  }
  const uncovered = concepts.filter(concept => options.get(concept)!.length === 0).map(concept => {
    // A 300-level session is not an introduction, but it is worth naming when it names the concept in its title.
    const closest = advanced.get(concept)!.filter(option => option.match.strength >= TITLE_STRENGTH).sort(bestFirst)[0];
    return {
      concept: concept.name,
      kind: concept.kind === "pattern" ? ("pattern" as const) : ("service" as const),
      reason: closest === undefined ? NOT_COVERED_REASON : `${NO_INTRODUCTION_REASON}: ${closest.session.key} "${closest.session.record.title}"`,
    };
  });
  return { selected, uncovered };
}

const BASE_WEIGHT = 20;
const STRENGTH_WEIGHT = 10;

/** Why a session is listed: what it explains, the phrase that says so, and where the code uses it. */
export function explainReason(match: ConceptMatch, repoCount: number): Reason {
  const { citations, where } = usedAt(match.concept, repoCount);
  return {
    kind: "explainsConcept",
    detail: `Explains ${match.concept.name} ("${match.phrase}")${where}.`,
    evidence: match.phrase, profileEvidence: citations,
    weight: BASE_WEIGHT + STRENGTH_WEIGHT * (match.strength + (match.boosted ? 1 : 0)),
  };
}
