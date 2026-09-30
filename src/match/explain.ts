import type { IndexRecord } from "../catalog/index-record.js";
import type { Evidence, ResolvedProfile } from "../profile/profile.js";
import { getLensProfile } from "./lens.js";
import { unlistedMatches } from "./listing.js";
import type { Reason } from "./score.js";
import { PLATFORM_SERVICES, serviceNamePatterns } from "./stack-fit.js";

/** A thing in the profile a newcomer would want explained: a core service (or, at half weight, a
 * supporting one) or a non-gap pattern the profile evidences. */
export interface ExplainConcept {
  name: string;
  kind: "service" | "pattern";
  /** 1 for a core service or a pattern, 0.5 for a supporting service. */
  weight: number;
  /** Distinct cited files (per repo) times `weight`: how much of the code the concept underlies. */
  centrality: number;
  citations: Evidence[];
  /** What names the concept in a session's text. */
  matchers: RegExp[];
  /** Catalog display name, for a service the catalog knows. */
  catalogName: string | null;
  /** Catalog topics and areas of interest that boost, never admit, a session. */
  tags: readonly string[];
  /** Only a title that names the concept admits a session. */
  titleOnly: boolean;
}

export interface UncoveredConcept {
  concept: string;
  reason: string;
}

export interface ConceptMatch {
  concept: ExplainConcept;
  /** 3 for the concept named in the title, 2 for it named at least twice in the abstract. */
  strength: number;
  /** The text of the session that named the concept. */
  phrase: string;
  /** The session also lists the service or carries a matching tag. Never admits on its own. */
  boosted: boolean;
}

const SUPPORTING_WEIGHT = 0.5;
const TITLE_STRENGTH = 3;
const ABSTRACT_STRENGTH = 2;
const ABSTRACT_MENTIONS = 2;
/** A sponsored session is the sponsor's pitch for its own product, not an introduction to a technology. */
const SPONSORED = /\(sponsored by /i;

interface PatternEntry {
  phrase: RegExp;
  tags: readonly string[];
  /** A term so widespread that a session mentioning it twice is rarely about it: only a title
   * that names it admits. */
  broad?: boolean;
}

/**
 * The session wording for each pattern the profiling guide names. Deliberately phrases, not single
 * words, where the bare word is ordinary prose ("API" appears in nearly every agent talk). A pattern
 * absent from this map cannot be matched and is reported as uncovered.
 */
const PATTERN_PHRASES: ReadonlyMap<string, PatternEntry> = new Map([
  ["serverless", { phrase: /\bserverless\b/i, tags: ["Serverless", "Lambda-Based Applications"] }],
  ["event-driven", { phrase: /\bevent[- ](?:driven|based)\b/i, tags: ["Event-Driven Architecture"] }],
  ["api", { phrase: /\b(?:REST|HTTP|GraphQL|WebSocket)\s+APIs?\b|\bAPI (?:design|development|management|first|Gateway)\b|\bbuilding APIs\b/i, tags: [] }],
  ["multi-tenant", { phrase: /\bmulti[- ]tenan(?:t|cy)\b|\bSaaS\b/i, tags: ["SaaS"] }],
  ["multi-account", { phrase: /\bmulti[- ]account\b|\bAWS Organizations\b|\bControl Tower\b|\blanding zones?\b/i, tags: [] }],
  ["iac-cdk", { phrase: /\b(?:CDK|Cloud Development Kit|infrastructure[- ]as[- ]code|IaC)\b/i, tags: [] }],
  ["containers", { phrase: /\bcontainer(?:s|ized|ization)?\b/i, tags: ["Containers"] }],
  ["ecs", { phrase: /\bECS\b|\bElastic Container Service\b/i, tags: ["Containers"] }],
  ["eks", { phrase: /\bEKS\b|\bKubernetes\b|\bElastic Kubernetes Service\b/i, tags: ["Kubernetes", "Containers"] }],
  ["agentic", { phrase: /\bagentic\b|\bAI agents?\b|\bmulti[- ]agent\b/i, tags: ["Agentic AI"], broad: true }],
  ["genai-single-call", { phrase: /\bgenerative AI\b|\bGenAI\b|\bLLMs?\b|\bfoundation models?\b/i, tags: ["Generative AI"], broad: true }],
  ["streaming", { phrase: /\bstreaming\b|\bKinesis\b|\bKafka\b/i, tags: [] }],
  ["data-lake", { phrase: /\bdata lakes?\b|\blakehouse\b/i, tags: [] }],
]);

/** Every phrase above, so a lowercase list of them ("serverless, containers, and event-driven") is
 * read as a list of names rather than prose. */
const PATTERN_VOCABULARY = new RegExp([...PATTERN_PHRASES.values()].map(entry => `(?:${entry.phrase.source})`).join("|"), "i");

const NO_PHRASE_REASON = "no session phrase is defined for this pattern, so no session can be matched to it";

function isGapOrDeadCode(name: string): boolean {
  const key = name.toLowerCase();
  return key.startsWith("gap-") || key === "dead-code";
}

const fileKey = (citation: Evidence): string => JSON.stringify([citation.repo, citation.file]);

interface Draft {
  name: string;
  kind: "service" | "pattern";
  supporting: boolean;
  citations: Evidence[];
  matchers: RegExp[];
  catalogName: string | null;
  tags: readonly string[];
  titleOnly: boolean;
}

/** The profile's concepts, most central first, and the patterns that cannot be matched at all. A
 * platform service, a gap pattern and dead code are not something the code is built from. */
export function buildConcepts(profile: ResolvedProfile): { concepts: ExplainConcept[]; uncovered: UncoveredConcept[] } {
  const drafts = new Map<string, Draft>();
  for (const service of profile.services) {
    if (service.catalogName !== null && PLATFORM_SERVICES.includes(service.catalogName)) continue;
    const key = `service:${(service.catalogName ?? service.name).toLowerCase()}`;
    const draft = drafts.get(key);
    const supporting = service.role === "supporting";
    if (draft === undefined) {
      drafts.set(key, {
        name: service.catalogName ?? service.name, kind: "service", supporting,
        citations: [...service.evidence], matchers: serviceNamePatterns(service.name, service.catalogName),
        catalogName: service.catalogName, tags: [], titleOnly: false,
      });
    } else {
      draft.supporting = draft.supporting && supporting;
      draft.citations.push(...service.evidence);
      draft.matchers.push(...serviceNamePatterns(service.name, service.catalogName));
    }
  }
  const uncovered: UncoveredConcept[] = [];
  for (const pattern of profile.patterns) {
    if (isGapOrDeadCode(pattern.name)) continue;
    const entry = PATTERN_PHRASES.get(pattern.name.toLowerCase());
    if (entry === undefined) {
      uncovered.push({ concept: pattern.name, reason: NO_PHRASE_REASON });
      continue;
    }
    const key = `pattern:${pattern.name.toLowerCase()}`;
    const draft = drafts.get(key);
    if (draft === undefined) {
      drafts.set(key, { name: pattern.name, kind: "pattern", supporting: false, citations: [...pattern.evidence], matchers: [entry.phrase], catalogName: null, tags: entry.tags, titleOnly: entry.broad === true });
    } else {
      draft.citations.push(...pattern.evidence);
    }
  }
  const concepts = [...drafts.values()].map((draft): ExplainConcept => {
    const weight = draft.supporting ? SUPPORTING_WEIGHT : 1;
    return {
      name: draft.name, kind: draft.kind, weight,
      centrality: new Set(draft.citations.map(fileKey)).size * weight,
      citations: draft.citations, matchers: draft.matchers, catalogName: draft.catalogName, tags: draft.tags, titleOnly: draft.titleOnly,
    };
  });
  concepts.sort((a, b) => b.centrality - a.centrality || b.weight - a.weight
    || Number(b.kind === "pattern") - Number(a.kind === "pattern") || b.citations.length - a.citations.length || a.name.localeCompare(b.name));
  return { concepts, uncovered };
}

/** Where `concept` is named in `text` outside an enumeration, each place once even when two of its
 * spellings overlap ("Amazon DynamoDB" and "DynamoDB"). */
function mentions(concept: ExplainConcept, text: string): RegExpExecArray[] {
  // "Lambda, DynamoDB & SQS" is an enumeration like the "and" form.
  const spoken = text.replace(/ & /g, " and ");
  const all = concept.matchers.flatMap(matcher => unlistedMatches(matcher, spoken, PATTERN_VOCABULARY));
  all.sort((a, b) => a.index - b.index || b[0].length - a[0].length);
  const distinct: RegExpExecArray[] = [];
  let end = 0;
  for (const match of all) {
    if (match.index < end) continue;
    distinct.push(match);
    end = match.index + match[0].length;
  }
  return distinct;
}

function isBoosted(concept: ExplainConcept, record: IndexRecord): boolean {
  if (concept.catalogName !== null && record.services.includes(concept.catalogName)) return true;
  const wanted = new Set(concept.tags.map(tag => tag.toLowerCase()));
  return [...record.topics, ...record.areasOfInterest].some(value => wanted.has(value.toLowerCase()));
}

/** The concepts a session is about: it names the concept in its title, or at least twice in its
 * abstract, outside a listing. A tag or a listed service can lift a match, never make one. */
export function matchConcepts(concepts: readonly ExplainConcept[], record: IndexRecord, abstract: string): ConceptMatch[] {
  if (SPONSORED.test(record.title)) return [];
  const matches: ConceptMatch[] = [];
  for (const concept of concepts) {
    const inTitle = mentions(concept, record.title)[0];
    const inAbstract = mentions(concept, abstract);
    const admitted = inTitle ?? (!concept.titleOnly && inAbstract.length >= ABSTRACT_MENTIONS ? inAbstract[0] : undefined);
    if (admitted === undefined) continue;
    matches.push({
      concept, strength: inTitle === undefined ? ABSTRACT_STRENGTH : TITLE_STRENGTH,
      phrase: admitted[0], boosted: isBoosted(concept, record),
    });
  }
  return matches;
}

/** Level 100 and 200: what the Explain lens is for. */
const INTRODUCTORY_BANDS: readonly number[] = getLensProfile("explain").levelBands ?? [];
const FALLBACK_BAND = 300;
const NOT_COVERED_REASON = "no introductory (100/200) or 300-level session is about it";

/** A catalog session (repeat sittings already grouped) with the concepts it is about. */
export interface ExplainSession {
  key: string;
  record: IndexRecord;
  matches: ConceptMatch[];
  /** Breaks ties between equally strong matches: how relevant the session is to the profile. */
  rank: number;
}

export interface SelectedMatch extends ConceptMatch {
  /** A 300-level session taken because no introductory one covers the concept. */
  fallback: boolean;
}

export interface ExplainSelection {
  key: string;
  /** Every concept the session explains; the one it was taken for comes first. */
  matches: SelectedMatch[];
}

interface Option {
  session: ExplainSession;
  match: SelectedMatch;
  score: number;
}

const FORMAT_SCALE = 10;

/**
 * Picks sessions round-robin across concepts in centrality order, the best session per concept each
 * round, so a short list covers as many concepts as it can. A concept a session already explains
 * does not take another session in the first round. Sessions at level 100 or 200 come first; after
 * all of them, a concept none of them covers may take one 300-level session that names it in its
 * title. A concept with no session at all is reported as uncovered.
 */
export function selectExplain(
  sessions: readonly ExplainSession[],
  concepts: readonly ExplainConcept[],
  typeWeights: ReadonlyMap<string, number> = getLensProfile("explain").typeWeights,
): { selected: ExplainSelection[]; uncovered: UncoveredConcept[] } {
  const introductoryBand = (session: ExplainSession): boolean =>
    session.record.levelBand !== null && INTRODUCTORY_BANDS.includes(session.record.levelBand);
  const eligible = sessions.filter(session => introductoryBand(session) || session.record.levelBand === FALLBACK_BAND);
  const introductory = new Set(eligible
    .filter(introductoryBand)
    .flatMap(session => session.matches.map(match => match.concept)));
  const options = new Map<ExplainConcept, Option[]>(concepts.map(concept => [concept, []]));
  for (const session of eligible) {
    const fallback = session.record.levelBand === FALLBACK_BAND;
    for (const match of session.matches) {
      if (fallback && (introductory.has(match.concept) || match.strength < TITLE_STRENGTH)) continue;
      const format = session.record.type === null ? 0 : (typeWeights.get(session.record.type) ?? 0);
      options.get(match.concept)?.push({
        session, match: { ...match, fallback },
        score: match.strength + (match.boosted ? 1 : 0) + format / FORMAT_SCALE,
      });
    }
  }
  const queues = new Map<ExplainConcept, Option[]>();
  for (const [concept, list] of options) {
    list.sort((a, b) => b.score - a.score || b.session.rank - a.session.rank || a.session.key.localeCompare(b.session.key));
    queues.set(concept, list[0]?.match.fallback === true ? list.slice(0, 1) : [...list]);
  }

  const selected: ExplainSelection[] = [];
  const taken = new Set<string>();
  const covered = new Set<ExplainConcept>();
  const order = new Map(concepts.map((concept, index) => [concept, index]));
  const take = (concept: ExplainConcept): void => {
    const queue = queues.get(concept)!;
    while (queue.length > 0 && taken.has(queue[0]!.session.key)) queue.shift();
    const option = queue.shift();
    if (option === undefined) return;
    taken.add(option.session.key);
    const positionOf = (match: SelectedMatch): number => match.concept === option.match.concept ? -1 : order.get(match.concept)!;
    const matches = option.session.matches
      .flatMap(match => options.get(match.concept)?.find(entry => entry.session === option.session)?.match ?? [])
      .sort((a, b) => positionOf(a) - positionOf(b));
    for (const match of matches) covered.add(match.concept);
    selected.push({ key: option.session.key, matches });
  };
  // Introductory sessions come first, round-robin; the 300-level fallbacks follow them, one per concept.
  const withIntroduction = concepts.filter(concept => introductory.has(concept));
  for (let round = 0; withIntroduction.some(concept => queues.get(concept)!.length > 0); round++) {
    for (const concept of withIntroduction) {
      if (!(round === 0 && covered.has(concept))) take(concept);
    }
  }
  for (const concept of concepts.filter(concept => !introductory.has(concept))) {
    if (!covered.has(concept)) take(concept);
  }
  const uncovered = concepts
    .filter(concept => options.get(concept)!.length === 0)
    .map(concept => ({ concept: concept.name, reason: NOT_COVERED_REASON }));
  return { selected, uncovered };
}

const BASE_WEIGHT = 20;
const STRENGTH_WEIGHT = 10;
const LISTED_CITATIONS = 3;

function citationKey(citation: Evidence): string {
  return JSON.stringify([citation.repo, citation.file, citation.line, citation.snippet, citation.note]);
}

/** "src/db/table.ts:14", with the repo in front when the profile spans several. */
function place(citation: Evidence, repoCount: number): string {
  const file = repoCount > 1 ? `${citation.repo}/${citation.file}` : citation.file;
  return citation.line === undefined ? file : `${file}:${citation.line}`;
}

/** Why a session is listed: what it explains, the phrase that says so, and where the code uses it. */
export function explainReason(match: SelectedMatch, repoCount: number): Reason {
  const unique = new Map<string, Evidence>();
  for (const citation of match.concept.citations) {
    if (!unique.has(citationKey(citation))) unique.set(citationKey(citation), { ...citation });
  }
  const citations = [...unique.values()];
  const places = citations.slice(0, LISTED_CITATIONS).map(citation => place(citation, repoCount));
  const more = citations.length - LISTED_CITATIONS;
  const where = places.length === 0 ? "" : `, which this code uses at ${places.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
  const fallback = match.fallback ? " No introductory session covers it, so this 300-level one is included." : "";
  return {
    kind: "explainsConcept",
    detail: `Explains ${match.concept.name} ("${match.phrase}")${where}.${fallback}`,
    evidence: match.phrase, profileEvidence: citations,
    weight: BASE_WEIGHT + STRENGTH_WEIGHT * (match.strength + (match.boosted ? 1 : 0)),
  };
}
