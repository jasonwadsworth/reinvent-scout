import type { IndexRecord } from "../catalog/index-record.js";
import type { Evidence, ResolvedProfile } from "../profile/profile.js";
import type { Reason, ScoredSession } from "./score.js";
import type { StackFit } from "./stack-fit.js";
import { unlistedMatches } from "./listing.js";

type SignalLens = "fix" | "next-level";
interface SignalRule {
  source: string;
  lens: SignalLens;
  detail: string;
  /** Matched against the session's own title and abstract; this is what admits a session. */
  phrase: RegExp;
  /** Text strength needed to admit. Defaults to 2 (a title hit, or two abstract mentions, or one
   * mention plus a booster tag). A rule whose phrase is specific enough that one abstract mention
   * is a real signal lowers it to 1. */
  minStrength?: number;
  /** Strength the text alone must reach, before a gap cue or a tag adds to it. Defaults to 1. */
  minTextStrength?: number;
  /** Next-level only: a title or abstract match means the session runs the migration the other
   * way, so it is excluded for this rule. */
  reverse?: RegExp;
  /** Next-level only: a profile that already has this pattern has already made the move. */
  destination?: string;
  /** Next-level only: the session must also mention the source side in its title or abstract,
   * outside an enumeration, or it is about the destination alone. */
  sourceText?: RegExp;
  /** Next-level only: the catalog service that is this rule's source itself. Naming it says nothing
   * about the move, so a session with no starting-point text still satisfies the source side when
   * it is about at least `SOURCE_STACK_SERVICES` of the profile's other core services. */
  sourceService?: string;
  /** Fix only: the services that close this rule's gap. When the phrase is in the title or twice in
   * the abstract, a session listing one of them fits the stack gate in place of the profile's own
   * services: a session about the fix is not about the stack the gap sits in. */
  remedyServices?: readonly string[];
  /** Tags, topics and services that add one strength to a text hit but never admit on their own. */
  services?: readonly string[];
  topics?: readonly string[];
  areas?: readonly string[];
}

const TITLE_STRENGTH = 3;
const SOURCE_STACK_SERVICES = 2;
/** A Fix rule's phrase described as absent ("missing dead-letter queues") is the gap itself, not a
 * passing mention, so it earns one more strength than the same phrase without the cue. Looks only
 * at the few words before the first abstract match. */
const GAP_CUE = /\b(?:missing|without|lack(?:s|ing)?|absent|forgotten)\b(?: [\w-]+){0,2} $/i;
const GAP_CUE_WINDOW = 30;
const BASE_WEIGHT = 20;
const STRENGTH_WEIGHT = 10;

// Our curated mappings, not an automated Well-Architected assessment. Pillar vocabulary:
// https://docs.aws.amazon.com/wellarchitected/latest/framework/the-pillars-of-the-framework.html
const RULES: readonly SignalRule[] = [
  // Two mentions, a title hit or a "missing" cue: a DLQ named once is usually one scenario among many.
  { source: "gap-no-dlq", lens: "fix", detail: "Reliability: dead-letter handling is not evident in the cited scope.", phrase: /\b(?:dead[- ]letter queues?|DLQs?|redrive)\b/i },
  // Operational alarm or alerting language only: bare "alerts" or "alarms" is telecom NOCs, dashboards and agent talks.
  { source: "gap-no-alarms", lens: "fix", detail: "Operational Excellence: alarms are not evident in the cited scope.", phrase: /\b(?:CloudWatch alarms?|alarms? (?:on|for) (?:the |your |each |every |a )?[\w-]+|alerting strateg(?:y|ies)|on-call|paging|(?:SLO|SLI)s?(?: (?:and|or))? alerting|(?:SLO|SLI)[- ]based alert(?:s|ing)|alerting on (?:SLO|SLI)s?)\b/i },
  { source: "gap-no-tests", lens: "fix", detail: "Operational Excellence: automated tests are not evident in the cited scope.", phrase: /\b(?:(?:unit|integration|automated|end[- ]to[- ]end) test(?:s|ing)?|test[- ]driven|test coverage|testing infrastructure)\b/i },
  { source: "gap-broad-iam", lens: "fix", detail: "Security: broad IAM permissions are an evidenced scope concern; explore tighter policies.", phrase: /\b(?:least[- ]privilege|IAM polic(?:y|ies)|policy scoping)\b/i, remedyServices: ["AWS Identity and Access Management (IAM)", "AWS IAM Access Analyzer"] },
  { source: "gap-no-load-tests", lens: "fix", detail: "Performance Efficiency: load tests are not evident in the cited scope.", phrase: /\b(?:load|performance|stress) test(?:s|ing)?\b/i },
  { source: "gap-no-cost-monitoring", lens: "fix", detail: "Cost Optimization: cost monitoring is not evident in the cited scope.", phrase: /\b(?:cost (?:monitoring|allocation|anomal(?:y|ies)|visibility)|AWS Budgets)\b/i, remedyServices: ["AWS Billing and Cost Management"] },
  { source: "gap-no-resource-rightsizing", lens: "fix", detail: "Sustainability: resource rightsizing is not evident in the cited scope.", phrase: /\b(?:right[- ]?sizing|right[- ]?size)\b/i },
  {
    source: "serverless", lens: "next-level", destination: "containers",
    sourceText: /\b(?:Lambda|serverless|functions?)\b/i,
    detail: "serverless → containers is an exploration option: gain runtime control; take on operational ownership.",
    phrase: /\b(?:containers?|containerization|ECS|EKS)\b/i,
    // Tuned on the real catalog: the first branch catches "replacing always-on containers with
    // MicroVMs" (COM340); the second any move onto serverless or AgentCore, such as a Kubernetes
    // workload migrated to it; the MicroVMs branch catches the 19 Lambda MicroVM and AgentCore
    // sandbox talks, none of which is a move onto containers.
    reverse: /\b(?:from|replac\w*|migrat\w*|mov\w*) (?:[\w-]+ ){0,3}containers? (?:[\w-]+ ){0,4}(?:to|with|into) (?:[\w-]+ ){0,2}(?:Lambda|serverless|functions?|MicroVMs?)\b|\b(?:migrat\w*|mov\w*|refactor\w*|port\w*) (?:[\w'’-]+ ){0,8}(?:to|onto|into) (?:[\w'’-]+ ){0,3}(?:serverless|AgentCore|Lambda)\b|\bMicroVMs?\b/i,
    topics: ["Containers"],
    services: ["Amazon Elastic Container Service (Amazon ECS)", "Amazon Elastic Kubernetes Service (Amazon EKS)"],
  },
  {
    source: "ecs", lens: "next-level", destination: "eks",
    sourceText: /\bECS\b/i,
    detail: "ecs → EKS is an exploration option: gain Kubernetes portability and ecosystem; take on cluster/platform complexity.",
    phrase: /\b(?:Kubernetes|EKS)\b/i,
    reverse: /\bfrom (?:Amazon )?EKS (?:\w+ ){0,3}to (?:Amazon )?ECS\b/i,
    areas: ["Kubernetes"],
    services: ["Amazon Elastic Kubernetes Service (Amazon EKS)"],
  },
  {
    source: "genai-single-call", lens: "next-level", destination: "agentic",
    // The starting point, not the platform: Bedrock and prompts alone appear in every GenAI talk.
    sourceText: /\b(?:single[- ](?:shot|turn|(?:model |LLM )?(?:call|invocation|prompt)s?)|(?:basic|simple) prompt(?:ing|s)?|first (?:GenAI|generative AI|AI) (?:app|application)|(?:basic|simple|existing|standalone|first|starter) (?:(?:RAG|GenAI|LLM|AI) )?(?:chatbots?|RAG(?: (?:app|application|pipeline|system)s?)?|assistants?|copilots?)|(?:chatbot|RAG) baselines?|InvokeModel|Converse(?: API| call|Stream))\b|\bfrom (?:\S+ ){0,4}(?:chatbots?|assistants?|copilots?|prompts?|prompting|RAG|LLM|GenAI|generative AI|single[- ]\w+)(?: \S+){0,4} to (?:\S+ ){0,3}agent/i,
    sourceService: "Amazon Bedrock",
    detail: "genai-single-call → agentic is an exploration option: gain multi-step tool use; take on latency, cost, evaluation, and control requirements.",
    phrase: /\b(?:agentic|agents? with tools|tool[- ](?:use|calling)|multi[- ]agent|agent orchestration)\b/i,
    areas: ["Agentic AI"],
    // A tag never lifts a single passing mention to admission; two mentions or a title hit do.
    minTextStrength: 2,
  },
];

/** Every catalog tag, topic and service a rule names, so a test can check them against the real
 * catalog vocabulary: a booster naming a tag that does not exist silently never fires. */
export const LENS_RULE_SELECTORS = RULES.map(rule => ({
  source: rule.source,
  services: rule.services ?? [],
  topics: rule.topics ?? [],
  areas: rule.areas ?? [],
}));

export interface LensHit {
  rule: string;
  strength: number;
}

export interface LensScored extends ScoredSession {
  /** One entry per admitting rule, in rule order. */
  hits: LensHit[];
}

export interface SkippedRule {
  rule: string;
  reason: string;
}

function hasPattern(profile: ResolvedProfile, name: string): boolean {
  return profile.patterns.some(pattern => pattern.name.toLowerCase() === name);
}

function activeCitations(rule: SignalRule, profile: ResolvedProfile): Evidence[] {
  if (rule.destination !== undefined && hasPattern(profile, rule.destination)) return [];
  return profile.patterns
    .filter(pattern => pattern.name.toLowerCase() === rule.source)
    .flatMap(pattern => pattern.evidence);
}

/** Migration paths the profile evidences but already completed: reported so the agent can say why
 * a path produced nothing. */
export function skippedLensRules(profile: ResolvedProfile, lens: SignalLens): SkippedRule[] {
  return RULES
    .filter(rule => rule.lens === lens && rule.destination !== undefined
      && hasPattern(profile, rule.source) && hasPattern(profile, rule.destination))
    .map(rule => ({ rule: rule.source, reason: `profile already has ${rule.destination}` }));
}

/** Rules the profile activates under this lens: source pattern cited, destination not yet reached. */
export function activeLensRules(profile: ResolvedProfile, lens: SignalLens): string[] {
  return RULES
    .filter(rule => rule.lens === lens && activeCitations(rule, profile).length > 0)
    .map(rule => rule.source);
}

function boosted(rule: SignalRule, record: IndexRecord): boolean {
  return ([
    [record.services, rule.services], [record.topics, rule.topics], [record.areasOfInterest, rule.areas],
  ] as const).some(([values, allowed]) =>
    values.some(value => allowed?.some(expected => value.toLowerCase() === expected.toLowerCase())));
}

function mentionsSource(rule: SignalRule, record: IndexRecord, abstract: string, fitsStack: StackFit): boolean {
  if (rule.sourceText === undefined) return true;
  return unlistedMatches(rule.sourceText, record.title).length > 0 || unlistedMatches(rule.sourceText, abstract).length > 0
    || (rule.sourceService !== undefined && fitsStack(record, abstract, { without: [rule.sourceService], minDistinct: SOURCE_STACK_SERVICES }));
}

interface Signal {
  evidence: string;
  strength: number;
}

/** Strength comes from the session's own text: phrase in the title = 3, at least twice in the
 * abstract = 2, once = 1; a gap cue before the phrase and a matching tag, topic or service each add
 * 1, but a text hit is required. Title
 * and abstract are matched separately so a phrase cannot bridge them. */
function catalogSignal(rule: SignalRule, record: IndexRecord, abstract: string, fitsStack: StackFit, onStack: boolean): Signal | undefined {
  if (rule.reverse?.test(record.title) === true || rule.reverse?.test(abstract) === true) return undefined;
  if (!mentionsSource(rule, record, abstract, fitsStack)) return undefined;
  const titleMatch = unlistedMatches(rule.phrase, record.title)[0];
  const abstractMatches = unlistedMatches(rule.phrase, abstract);
  const abstractMatch = abstractMatches[0];
  const text = titleMatch !== undefined
    ? TITLE_STRENGTH
    : Math.min(abstractMatches.length, 2);
  if (text === 0 || text < (rule.minTextStrength ?? 1)) return undefined;
  if (!onStack && !(rule.remedyServices !== undefined && text >= 2
    && fitsStack(record, abstract, { remedy: rule.remedyServices }))) return undefined;
  const cued = rule.lens === "fix" && titleMatch === undefined && abstractMatch !== undefined
    && GAP_CUE.test(abstract.slice(Math.max(0, abstractMatch.index - GAP_CUE_WINDOW), abstractMatch.index));
  const strength = text + (cued ? 1 : 0) + (boosted(rule, record) ? 1 : 0);
  if (strength < (rule.minStrength ?? 2)) return undefined;
  return { evidence: (titleMatch ?? abstractMatch)![0], strength };
}

/** Evidence-bearing exact pattern names activate rules; `fitsStack` (see `buildStackFit`) rejects
 * sessions that are not about the profile's stack at all. Intent and ordinary source-service
 * overlap never activate or admit candidates. Each rule contributes once, even across repos. */
export function scoreLensSignals(
  record: IndexRecord,
  profile: ResolvedProfile,
  lens: SignalLens,
  abstract = "",
  fitsStack: StackFit = (_record, _abstract, query) => query === undefined,
): LensScored {
  const onStack = fitsStack(record, abstract);
  const reasons: Reason[] = [];
  const hits: LensHit[] = [];
  for (const rule of RULES) {
    if (rule.lens !== lens) continue;
    const citations = activeCitations(rule, profile);
    if (citations.length === 0) continue;
    const signal = catalogSignal(rule, record, abstract, fitsStack, onStack);
    if (signal === undefined) continue;
    const unique = new Map<string, Evidence>();
    for (const citation of citations) {
      const key = JSON.stringify([citation.repo, citation.file, citation.line, citation.snippet, citation.note]);
      if (!unique.has(key)) unique.set(key, { ...citation });
    }
    hits.push({ rule: rule.source, strength: signal.strength });
    reasons.push({
      kind: lens === "fix" ? "pillarGap" : "migrationPath",
      detail: `${rule.source}: ${rule.detail} Session signal: "${signal.evidence}" (strength ${signal.strength}).`,
      evidence: signal.evidence, profileEvidence: [...unique.values()],
      weight: BASE_WEIGHT + STRENGTH_WEIGHT * signal.strength,
    });
  }
  return { score: reasons.reduce((sum, reason) => sum + reason.weight, 0), reasons, hits };
}
