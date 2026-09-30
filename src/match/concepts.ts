import type { IndexRecord } from "../catalog/index-record.js";
import type { Evidence, ResolvedProfile } from "../profile/profile.js";
import { listedMatches, unlistedMatches } from "./listing.js";
import type { MatchSite } from "./why.js";
import { PLATFORM_SERVICES, serviceNamePatterns } from "./stack-fit.js";

/** A thing the profile says the code is built from: a core service (or, at half weight, a
 * supporting one) or a non-gap pattern the profile evidences. */
export interface ProfileConcept {
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
  /** The profile's own words for how the code uses it: a service's `usage`, else a pattern's `note`. */
  note?: string;
}

export interface UncoveredConcept {
  concept: string;
  /** Tells a service from a pattern of the same name. */
  kind: "service" | "pattern";
  reason: string;
}

export interface ConceptMatch {
  concept: ProfileConcept;
  /** 3 for the concept named in the title, 2 for it named at least twice in the abstract. */
  strength: number;
  /** The text of the session that named the concept. */
  phrase: string;
  /** The session also lists the service or carries a matching tag. Never admits on its own. */
  boosted: boolean;
  /** Where `phrase` sits in the title or abstract, for quoting the sentence that says it. */
  site: MatchSite;
}

const SUPPORTING_WEIGHT = 0.5;
export const TITLE_STRENGTH = 3;
const ABSTRACT_STRENGTH = 2;
const ABSTRACT_MENTIONS = 2;
const SINGLE_STRENGTH = 1;
/** A sponsored session is the sponsor's pitch for its own product, not an introduction to a technology. */
export const SPONSORED = /\(sponsored by /i;
/** A customer story ("How customers scaled X") tells what one team did rather than teaching X; "how
 * to", "how it works" and questions stay. */
export const STORY = /(?:^|[:\-–—]\s+)how\b/i;
export const EXPLAINER = /\bhow (?:to|do|does|can|should)\b|\bworks\b/i;
/** AWS Partner bootcamps are technical but restricted to AWS Partners ("This bootcamp is for AWS
 * Partners only"), so most attendees cannot use them as an introduction. */
export const PARTNER = /^AWS Partner:/i;
/** A news, launch or recap session lists changes; it does not teach the technology. */
export const NEWS = /\bwhat[’']s new\b|\b\w+[’']s new\b|\bnew (?:features?|capabilit(?:y|ies)|instances?|models?|execution|silicon|releases?|launches|services?)\b|\byear in review\b|\bthe latest\b|\bannouncements?\b|\brecap\b|\blaunch(?:es|ed)\b/i;
/** Modernization and migration sessions are about tooling that moves code onto the concept. */
export const MODERNIZATION = /\bmoderni[sz]\w*|\bmigrat\w*|\btransform(?:ation|ing)?\b/i;
/** A customer story told in the abstract: the session is what one team built, not how the thing works. */
export const CUSTOMER_STORY = /\bhow (?:a |one |our )?customers?\b|\[customer\]/i;
/** Games and exam prep are competitions and test practice, not explanations. */
export const NON_EXPLANATORY_TYPES: readonly string[] = ["Gamified learning", "Exam prep"];
/** Certification and training paths teach the exam, not the technology. */
export const CERTIFICATION = /\bcertification\b|\bcertified\b|\bcertify\b|\bproficien\w*|\bexam\b/i;
/** What a title says when the session is about building or designing the thing, not applying it. */
export const BUILD_CUE = /\b(?:build(?:ing)?|architect\w*|patterns?|best practices|design(?:ing)?|getting started|introduction|fundamentals|basics|101|how to|what is)\b/i;
/** A title that reads as an introduction ranks ahead of one that does not. */
export const INTRO_CUE = /\b(?:getting started|introduction|intro to|fundamentals|basics|101|beginners?|from scratch|your first)\b/i;

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

/** How a session words a pattern of the profile, or `undefined` for a pattern with no defined wording. */
export function patternPhrase(name: string): RegExp | undefined {
  return PATTERN_PHRASES.get(name.toLowerCase())?.phrase;
}

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
  note?: string;
}

/** The profile's concepts, most central first, and the patterns that cannot be matched at all. A
 * platform service, a gap pattern and dead code are not something the code is built from. */
export function buildConcepts(profile: ResolvedProfile, catalogServices: readonly string[] = []): { concepts: ProfileConcept[]; uncovered: UncoveredConcept[] } {
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
        ...(service.usage === undefined ? {} : { note: service.usage }),
      });
    } else {
      draft.supporting = draft.supporting && supporting;
      if (draft.note === undefined && service.usage !== undefined) draft.note = service.usage;
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
      if (twin.note === undefined && pattern.note !== undefined) twin.note = pattern.note;
      twin.matchers.push(entry.phrase);
      twin.tags = [...twin.tags, ...entry.tags];
      continue;
    }
    const key = `pattern:${pattern.name.toLowerCase()}`;
    const draft = drafts.get(key);
    if (draft === undefined) {
      drafts.set(key, { name: pattern.name, kind: "pattern", supporting: false, citations: [...pattern.evidence], matchers: [entry.phrase], catalogName: null, tags: entry.tags, titleOnly: entry.broad === true, ...(pattern.note === undefined ? {} : { note: pattern.note }) });
    } else {
      draft.citations.push(...pattern.evidence);
      if (draft.note === undefined && pattern.note !== undefined) draft.note = pattern.note;
    }
  }
  const concepts = [...drafts.values()].map((draft): ProfileConcept => {
    const weight = draft.supporting ? SUPPORTING_WEIGHT : 1;
    return {
      name: draft.name, kind: draft.kind, weight,
      centrality: new Set(draft.citations.map(fileKey)).size * weight,
      citations: draft.citations, matchers: draft.matchers, catalogName: draft.catalogName, tags: draft.tags, titleOnly: draft.titleOnly,
      ...(draft.note === undefined ? {} : { note: draft.note }),
    };
  });
  concepts.sort((a, b) => b.centrality - a.centrality || b.weight - a.weight
    || Number(b.kind === "pattern") - Number(a.kind === "pattern") || b.citations.length - a.citations.length || a.name.localeCompare(b.name));
  return { concepts, uncovered };
}

/** `mentionsOf` reads " & " as " and " (two characters longer); this maps a match offset in that
 * reading back to the original text, so a quote is cut from what the session actually says. */
function originalIndex(text: string, spokenIndex: number): number {
  let shift = 0;
  for (const ampersand of text.matchAll(/ & /g)) {
    if (ampersand.index + shift + " and ".length > spokenIndex) break;
    shift += 2;
  }
  return spokenIndex - shift;
}

/** Where any of `matchers` names something in `text` outside an enumeration (or, with `inEnumeration`,
 * only inside one), each place once even
 * when two of its spellings overlap ("Amazon DynamoDB" and "DynamoDB"), at offsets in `text` itself. */
export function mentionsOf(matchers: readonly RegExp[], text: string, inEnumeration = false): RegExpExecArray[] {
  // "Lambda, DynamoDB & SQS" is an enumeration like the "and" form.
  const spoken = text.replace(/ & /g, " and ");
  const find = inEnumeration ? listedMatches : unlistedMatches;
  const all = matchers.flatMap(matcher => find(matcher, spoken, PATTERN_VOCABULARY));
  all.sort((a, b) => a.index - b.index || b[0].length - a[0].length);
  const distinct: RegExpExecArray[] = [];
  let end = 0;
  for (const match of all) {
    if (match.index < end) continue;
    distinct.push(match);
    end = match.index + match[0].length;
  }
  return distinct.map(match => Object.assign(match, { index: originalIndex(text, match.index) }));
}

function mentions(concept: ProfileConcept, text: string): RegExpExecArray[] {
  return mentionsOf(concept.matchers, text);
}

function isBoosted(concept: ProfileConcept, record: IndexRecord): boolean {
  if (concept.catalogName !== null && record.services.includes(concept.catalogName)) return true;
  const wanted = new Set(concept.tags.map(tag => tag.toLowerCase()));
  return [...record.topics, ...record.areasOfInterest].some(value => wanted.has(value.toLowerCase()));
}

/** What the session says about the concept: the abstract sentence naming it when there is one, else the title. */
function quotedSite(inTitle: RegExpExecArray | undefined, inAbstract: RegExpExecArray | undefined): MatchSite {
  const quoted = inAbstract ?? inTitle!;
  return { inTitle: inAbstract === undefined, index: quoted.index, length: quoted[0].length };
}

/** What a lens accepts as a session being about a concept. */
export interface Admission {
  /** An abstract that names the concept once is enough when a listed service or matching tag says the
   * same; otherwise it must name it at least twice (and, unless this is set, be corroborated too). */
  singleCorroborated: boolean;
  /** A broad term is admitted only by a title that also says how to build or design it; otherwise a
   * title naming it is enough. */
  broadNeedsBuildCue: boolean;
}

/** Explain: an abstract must name the concept twice and be corroborated. */
export const EXPLAIN_ADMISSION: Admission = { singleCorroborated: false, broadNeedsBuildCue: true };

/** The concepts a session is about: it names the concept in its title, or in its abstract outside a
 * listing often enough for `admission` (twice, or once when a listed service or matching tag says the
 * same). A listed service or a matching tag never makes a match on its own. */
export function admitConcepts(concepts: readonly ProfileConcept[], record: IndexRecord, abstract: string, admission: Admission): ConceptMatch[] {
  const matches: ConceptMatch[] = [];
  for (const concept of concepts) {
    const inTitle = mentions(concept, record.title)[0];
    const inAbstract = mentions(concept, abstract);
    const boosted = isBoosted(concept, record);
    const repeated = inAbstract.length >= ABSTRACT_MENTIONS;
    const abstractAdmits = admission.singleCorroborated ? repeated || (boosted && inAbstract.length > 0) : boosted && repeated;
    const admitted = concept.titleOnly
      ? (!admission.broadNeedsBuildCue || BUILD_CUE.test(record.title) ? inTitle : undefined)
      : inTitle ?? (abstractAdmits ? inAbstract[0] : undefined);
    if (admitted === undefined) continue;
    matches.push({
      concept, strength: inTitle !== undefined ? TITLE_STRENGTH : repeated ? ABSTRACT_STRENGTH : SINGLE_STRENGTH,
      phrase: admitted[0], boosted,
      site: quotedSite(inTitle, inAbstract[0]),
    });
  }
  return matches;
}
