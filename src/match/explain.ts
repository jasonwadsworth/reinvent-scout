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
  /** Only a title that names the concept and says how to build or design it admits a session. */
  titleOnly: boolean;
}

export interface UncoveredConcept {
  concept: string;
  /** Tells a service from a pattern of the same name. */
  kind: "service" | "pattern";
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
/** A customer story ("How customers scaled X") tells what one team did rather than teaching X; "how
 * to", "how it works" and questions stay. */
const STORY = /(?:^|[:\-–—]\s+)how\b/i;
const EXPLAINER = /\bhow (?:to|do|does|can|should)\b|\bworks\b/i;
/** AWS Partner bootcamps are technical but restricted to AWS Partners ("This bootcamp is for AWS
 * Partners only"), so most attendees cannot use them as an introduction. */
const PARTNER = /^AWS Partner:/i;
/** A news, launch or recap session lists changes; it does not teach the technology. */
const NEWS = /\bwhat[’']s new\b|\b\w+[’']s new\b|\bnew (?:features?|capabilit(?:y|ies)|instances?|models?|execution|silicon|releases?|launches|services?)\b|\byear in review\b|\bthe latest\b|\bannouncements?\b|\brecap\b|\blaunch(?:es|ed)\b/i;
/** Modernization and migration sessions are about tooling that moves code onto the concept. */
const MODERNIZATION = /\bmoderni[sz]\w*|\bmigrat\w*|\btransform(?:ation|ing)?\b/i;
/** A customer story told in the abstract: the session is what one team built, not how the thing works. */
const CUSTOMER_STORY = /\bhow (?:a |one |our )?customers?\b|\[customer\]/i;
/** Games and exam prep are competitions and test practice, not explanations. */
const NON_EXPLANATORY_TYPES: readonly string[] = ["Gamified learning", "Exam prep"];
/** Certification and training paths teach the exam, not the technology. */
const CERTIFICATION = /\bcertification\b|\bcertified\b|\bcertify\b|\bproficien\w*|\bexam\b/i;
/** What a title says when the session is about building or designing the thing, not applying it. */
const BUILD_CUE = /\b(?:build(?:ing)?|architect\w*|patterns?|best practices|design(?:ing)?|getting started|introduction|fundamentals|basics|101|how to|what is)\b/i;
/** A title that reads as an introduction ranks ahead of one that does not. */
const INTRO_CUE = /\b(?:getting started|introduction|intro to|fundamentals|basics|101|beginners?|from scratch|your first)\b/i;

interface PatternEntry {
  phrase: RegExp;
  tags: readonly string[];
  /** A term so widespread that a session mentioning it is rarely about it: only a title that names
   * it and says how to build or design it (see `BUILD_CUE`) admits. */
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
  ["agentic", { phrase: /\bagentic\b|\b(?:AI )?agents?\b|\bmulti[- ]agent\b/i, tags: ["Agentic AI"], broad: true }],
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

const PREFIX = /^(?:Amazon|AWS)\s+/i;
const PREPOSITIONS: readonly string[] = ["for", "on", "with", "of", "in", "and"];
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * How a session names a service beyond `serviceNamePatterns`: the distinctive last word of a
 * multi-word name ("AgentCore" for "Amazon Bedrock AgentCore"; only a camel-case word, never an
 * ordinary one such as "Service"), and a name that needs its prefix when the prefix is shared
 * across a coordinated list ("Amazon Polly and Transcribe").
 */
function serviceMatchers(name: string, catalogName: string | null, tails: readonly string[]): RegExp[] {
  const matchers = serviceNamePatterns(name, catalogName);
  const stripped = (catalogName ?? name).replace(/\s*\(.*\)\s*$/, "").replace(PREFIX, "").trim();
  const words = stripped.split(/\s+/);
  const last = words[words.length - 1] ?? "";
  // "PostgreSQL" is not the name of "RDS for PostgreSQL": the tail must not sit behind a preposition.
  if (words.length > 1 && !words.some(word => PREPOSITIONS.includes(word.toLowerCase())) && /^[A-Z][a-z]+[A-Z]\w*$/.test(last)) {
    matchers.push(new RegExp(`(?<![\\w-])${last}(?![\\w-])`));
  }
  if (words.length === 1 && PREFIX.test(catalogName ?? name) && /^[A-Z][a-z]+$/.test(last) && tails.length > 0) {
    const known = tails.map(escapeRegExp).join("|");
    // Every earlier item must be a known service, and the name must end its item: what follows is the end,
    // punctuation, "and" or "or". "Amazon Bedrock and Connect to Your Data" is a title, not a list of services.
    matchers.push(new RegExp(`\\b(?:Amazon|AWS) (?:(?:${known})(?:, | and | or |, and |, or ))+${last}(?=$|[,.;:!?)]|\\s+(?:and|or)\\b)`));
  }
  return matchers;
}

/** Short names of catalog services ("Polly", "SQS"): the display name and its parenthesized form, unprefixed. */
function serviceTails(catalogServices: readonly string[]): string[] {
  const tails = new Set<string>();
  for (const service of catalogServices) {
    const parenthesized = /\(([^)]+)\)\s*$/.exec(service)?.[1];
    for (const form of [service.replace(/\s*\(.*\)\s*$/, ""), parenthesized]) {
      const tail = form?.replace(PREFIX, "").trim();
      if (tail !== undefined && tail.length > 1) tails.add(tail);
    }
  }
  return [...tails];
}

/** "ecs" for "Amazon Elastic Container Service (Amazon ECS)": the parenthesized short name, lowercase. */
function shortNames(catalogName: string): string[] {
  const parenthesized = /\(([^)]+)\)\s*$/.exec(catalogName)?.[1];
  return parenthesized === undefined ? [] : [parenthesized.replace(PREFIX, "").trim().toLowerCase()];
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
export function buildConcepts(profile: ResolvedProfile, catalogServices: readonly string[] = []): { concepts: ExplainConcept[]; uncovered: UncoveredConcept[] } {
  const drafts = new Map<string, Draft>();
  const tails = serviceTails(catalogServices);
  for (const service of profile.services) {
    if (service.catalogName !== null && PLATFORM_SERVICES.includes(service.catalogName)) continue;
    const key = `service:${(service.catalogName ?? service.name).toLowerCase()}`;
    const draft = drafts.get(key);
    const supporting = service.role === "supporting";
    if (draft === undefined) {
      drafts.set(key, {
        name: service.catalogName ?? service.name, kind: "service", supporting,
        citations: [...service.evidence], matchers: serviceMatchers(service.name, service.catalogName, tails),
        catalogName: service.catalogName, tags: [], titleOnly: false,
      });
    } else {
      draft.supporting = draft.supporting && supporting;
      draft.citations.push(...service.evidence);
      draft.matchers.push(...serviceMatchers(service.name, service.catalogName, tails));
    }
  }
  const uncovered: UncoveredConcept[] = [];
  for (const pattern of profile.patterns) {
    if (isGapOrDeadCode(pattern.name)) continue;
    const entry = PATTERN_PHRASES.get(pattern.name.toLowerCase());
    if (entry === undefined) {
      uncovered.push({ concept: pattern.name, kind: "pattern", reason: NO_PHRASE_REASON });
      continue;
    }
    const twin = [...drafts.values()].find(draft => draft.kind === "service" && shortNames(draft.name).includes(pattern.name.toLowerCase()));
    if (twin !== undefined) {
      // The pattern and the service are one concept (ecs and Amazon ECS): one citation list, one turn.
      twin.citations.push(...pattern.evidence);
      twin.matchers.push(entry.phrase);
      twin.tags = [...twin.tags, ...entry.tags];
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
 * abstract, outside a listing. An abstract alone must be corroborated by a listed service or a
 * matching tag, which never make a match on their own. */
export function matchConcepts(concepts: readonly ExplainConcept[], record: IndexRecord, abstract: string): ConceptMatch[] {
  if (CUSTOMER_STORY.test(abstract) || (record.type !== null && NON_EXPLANATORY_TYPES.includes(record.type))) return [];
  if (SPONSORED.test(record.title) || [NEWS, MODERNIZATION, CERTIFICATION, PARTNER].some(pattern => pattern.test(record.title))
    || (STORY.test(record.title) && !EXPLAINER.test(record.title))) return [];
  const matches: ConceptMatch[] = [];
  for (const concept of concepts) {
    const inTitle = mentions(concept, record.title)[0];
    const inAbstract = mentions(concept, abstract);
    const boosted = isBoosted(concept, record);
    const admitted = concept.titleOnly
      ? (BUILD_CUE.test(record.title) ? inTitle : undefined)
      : inTitle ?? (boosted && inAbstract.length >= ABSTRACT_MENTIONS ? inAbstract[0] : undefined);
    if (admitted === undefined) continue;
    matches.push({
      concept, strength: inTitle === undefined ? ABSTRACT_STRENGTH : TITLE_STRENGTH,
      phrase: admitted[0], boosted,
    });
  }
  return matches;
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
  concepts: readonly ExplainConcept[],
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
  const options = new Map<ExplainConcept, Option[]>(concepts.map(concept => [concept, []]));
  const advanced = new Map<ExplainConcept, Option[]>(concepts.map(concept => [concept, []]));
  for (const session of sessions) {
    const target = introductoryBand(session) ? options : session.record.levelBand === ADVANCED_BAND ? advanced : undefined;
    for (const match of target === undefined ? [] : session.matches) {
      target!.get(match.concept)?.push({
        session, match, introduction: INTRO_CUE.test(session.record.title),
        format: session.record.type === null ? 0 : (typeWeights.get(session.record.type) ?? 0),
      });
    }
  }
  const queues = new Map<ExplainConcept, Option[]>();
  for (const [concept, list] of options) {
    queues.set(concept, list.sort(bestFirst).slice());
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
      kind: concept.kind,
      reason: closest === undefined ? NOT_COVERED_REASON : `${NO_INTRODUCTION_REASON}: ${closest.session.key} "${closest.session.record.title}"`,
    };
  });
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
export function explainReason(match: ConceptMatch, repoCount: number): Reason {
  const unique = new Map<string, Evidence>();
  for (const citation of match.concept.citations) {
    if (!unique.has(citationKey(citation))) unique.set(citationKey(citation), { ...citation });
  }
  const citations = [...unique.values()];
  const places = citations.slice(0, LISTED_CITATIONS).map(citation => place(citation, repoCount));
  const more = citations.length - LISTED_CITATIONS;
  const where = places.length === 0 ? "" : `, which this code uses at ${places.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
  return {
    kind: "explainsConcept",
    detail: `Explains ${match.concept.name} ("${match.phrase}")${where}.`,
    evidence: match.phrase, profileEvidence: citations,
    weight: BASE_WEIGHT + STRENGTH_WEIGHT * (match.strength + (match.boosted ? 1 : 0)),
  };
}
