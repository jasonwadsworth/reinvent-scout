import type { IndexRecord } from "../catalog/index-record.js";
import type { Evidence, ResolvedProfile } from "../profile/profile.js";
import type { Reason, ScoredSession } from "./score.js";

type SignalLens = "fix" | "next-level";
interface SignalRule {
  source: string;
  lens: SignalLens;
  detail: string;
  phrase: RegExp;
  services?: readonly string[];
  topics?: readonly string[];
  areas?: readonly string[];
}

// Our curated mappings, not an automated Well-Architected assessment. Pillar vocabulary:
// https://docs.aws.amazon.com/wellarchitected/latest/framework/the-pillars-of-the-framework.html
const RULES: readonly SignalRule[] = [
  { source: "gap-no-dlq", lens: "fix", detail: "Reliability: dead-letter handling is not evident in the cited scope.", phrase: /\b(?:dead[- ]letter queues?|DLQs?|redrive)\b/i },
  { source: "gap-no-alarms", lens: "fix", detail: "Operational Excellence: alarms are not evident in the cited scope.", phrase: /\b(?:alarms?|observability)\b/i, areas: ["Observability"] },
  { source: "gap-no-tests", lens: "fix", detail: "Operational Excellence: automated tests are not evident in the cited scope.", phrase: /\b(?:unit|integration|automated|end[- ]to[- ]end) test(?:s|ing)?\b/i },
  { source: "gap-broad-iam", lens: "fix", detail: "Security: broad IAM permissions are an evidenced scope concern; explore tighter policies.", phrase: /\b(?:least[- ]privilege|IAM polic(?:y|ies)|policy scoping)\b/i },
  { source: "gap-no-load-tests", lens: "fix", detail: "Performance Efficiency: load tests are not evident in the cited scope.", phrase: /\b(?:load|performance|stress) test(?:s|ing)?\b/i },
  { source: "gap-no-cost-monitoring", lens: "fix", detail: "Cost Optimization: cost monitoring is not evident in the cited scope.", phrase: /\b(?:cost (?:monitoring|allocation|anomal(?:y|ies)|visibility)|AWS Budgets)\b/i },
  { source: "gap-no-resource-rightsizing", lens: "fix", detail: "Sustainability: resource rightsizing is not evident in the cited scope.", phrase: /\b(?:right[- ]?sizing|right[- ]?size)\b/i },
  {
    source: "serverless", lens: "next-level",
    detail: "serverless → containers is an exploration option: gain runtime control; take on operational ownership.",
    phrase: /\b(?:containers?|containerization|ECS|EKS)\b/i,
    topics: ["Containers"],
    services: ["Amazon Elastic Container Service (Amazon ECS)", "Amazon Elastic Kubernetes Service (Amazon EKS)"],
  },
  {
    source: "ecs", lens: "next-level",
    detail: "ecs → EKS is an exploration option: gain Kubernetes portability and ecosystem; take on cluster/platform complexity.",
    phrase: /\b(?:Kubernetes|EKS)\b/i,
    areas: ["Kubernetes"],
    services: ["Amazon Elastic Kubernetes Service (Amazon EKS)"],
  },
  {
    source: "genai-single-call", lens: "next-level",
    detail: "genai-single-call → agentic is an exploration option: gain multi-step tool use; take on latency, cost, evaluation, and control requirements.",
    phrase: /\b(?:agentic|tool[- ](?:use|calling)|multi[- ]agent)\b/i,
    areas: ["Agentic AI"],
  },
];

function catalogSignal(rule: SignalRule, record: IndexRecord, abstract: string): string | undefined {
  for (const [values, allowed] of [
    [record.services, rule.services], [record.topics, rule.topics], [record.areasOfInterest, rule.areas],
  ] as const) {
    const match = values.find(value => allowed?.some(expected => value.toLowerCase() === expected.toLowerCase()));
    if (match !== undefined) return match;
  }
  // Match original text separately: a phrase cannot bridge title/abstract or unrelated fields.
  for (const text of [record.title, abstract]) {
    const match = rule.phrase.exec(text);
    if (match !== null) return match[0];
  }
  return undefined;
}

/** Evidence-bearing exact pattern names activate rules. Intent and ordinary source-service
 * overlap never activate or admit candidates. Each rule contributes once, even across repos. */
export function scoreLensSignals(
  record: IndexRecord,
  profile: ResolvedProfile,
  lens: SignalLens,
  abstract = "",
): ScoredSession {
  const reasons: Reason[] = [];
  for (const rule of RULES) {
    if (rule.lens !== lens) continue;
    const citations = profile.patterns
      .filter(pattern => pattern.name.toLowerCase() === rule.source)
      .flatMap(pattern => pattern.evidence);
    if (citations.length === 0) continue;
    const evidence = catalogSignal(rule, record, abstract);
    if (evidence === undefined) continue;
    const unique = new Map<string, Evidence>();
    for (const citation of citations) {
      const key = JSON.stringify([citation.repo, citation.file, citation.line, citation.snippet, citation.note]);
      if (!unique.has(key)) unique.set(key, { ...citation });
    }
    reasons.push({
      kind: lens === "fix" ? "pillarGap" : "migrationPath",
      detail: `${rule.source}: ${rule.detail} Session signal: "${evidence}".`,
      evidence, profileEvidence: [...unique.values()], weight: 30,
    });
  }
  return { score: reasons.reduce((sum, reason) => sum + reason.weight, 0), reasons };
}
