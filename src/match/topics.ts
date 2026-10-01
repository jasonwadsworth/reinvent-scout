import type { ResolvedProfile } from "../profile/profile.js";
import { buildConcepts, shortNames, type ProfileConcept } from "./concepts.js";
import { activeLensRules, lensRuleDestination, lensRuleDetail, skippedLensRules } from "./lens-signals.js";
import { citationsOf, trimNote, type Citation } from "./why.js";

export const GOALS = ["understand", "deepen", "improve"] as const;
/** What the user wants from a topic: introductions (explain), sessions at any level (all), or to fix a gap or take a next step
 * (fix, next-level). */
export type Goal = (typeof GOALS)[number];

export type TopicGroup = "services" | "patterns" | "gaps" | "nextSteps";

/** One thing the profile found in the code that the user can pick to focus on. */
export interface Topic {
  /** Stable: `service:Amazon DynamoDB`, `pattern:event-driven`, `gap:gap-no-dlq`, `path:genai-single-call`. */
  id: string;
  group: TopicGroup;
  label: string;
  note?: string;
  evidence: Citation[];
  /** How many more places the profile cites than `evidence` lists; absent when none were cut. */
  more?: number;
  /** A gap's Well-Architected pillar. */
  pillar?: string;
  /** A next step the profile already took: why it has nothing to offer. */
  skipped?: string;
  goals: readonly Goal[];
  /** The concept a service or pattern topic stands for, when the catalog can be matched to it. */
  conceptKey?: string;
  /** The Fix or Next-level rule a gap or next step stands for. */
  rule?: string;
}

/** The goals a topic of this group can be given. */
export function goalsOf(group: TopicGroup): readonly Goal[] {
  return group === "gaps" || group === "nextSteps" ? ["improve"] : ["understand", "deepen"];
}

export const conceptKey = (concept: Pick<ProfileConcept, "kind" | "name">): string => `${concept.kind}:${concept.name.toLowerCase()}`;
const displayName = (name: string): string => name.replace(/\s*\([^()]*\)\s*$/, "");
const isGapOrDeadCode = (name: string): boolean => name.toLowerCase().startsWith("gap-") || name.toLowerCase() === "dead-code";

function describe(evidence: Parameters<typeof citationsOf>[0], note: string | undefined): Pick<Topic, "evidence" | "more" | "note"> {
  const cited = citationsOf(evidence);
  const trimmed = trimNote(note, true);
  return { evidence: cited.yourCode, ...(cited.more === undefined ? {} : { more: cited.more }), ...(trimmed === undefined ? {} : { note: trimmed }) };
}

/** The profile's topics in four groups' order: services (core, then supporting), patterns, supported gaps, next steps. Within a
 * group, most central first, as `concepts.ts` orders them. */
export function buildTopics(profile: ResolvedProfile, catalogServices: readonly string[]): Topic[] {
  const { concepts } = buildConcepts(profile, catalogServices);
  const position = new Map(concepts.map((concept, index) => [conceptKey(concept), index]));
  const services = concepts.filter(concept => concept.kind === "service");
  const serviceTopics = [...services.filter(concept => concept.weight === 1), ...services.filter(concept => concept.weight !== 1)]
    .map((concept): Topic => ({
      id: `service:${concept.name}`, group: "services", label: displayName(concept.name), goals: ["understand", "deepen"], conceptKey: conceptKey(concept),
      ...describe(concept.citations, concept.note),
    }));

  const seen = new Set<string>();
  const patternTopics = profile.patterns.filter(pattern => !isGapOrDeadCode(pattern.name)).flatMap((pattern): Topic[] => {
    const name = pattern.name.toLowerCase();
    if (seen.has(name)) return [];
    seen.add(name);
    const same = profile.patterns.filter(other => other.name.toLowerCase() === name);
    const own = concepts.find(concept => concept.kind === "pattern" && concept.name.toLowerCase() === name);
    const twin = own ?? services.find(concept => shortNames(concept.name).includes(name));
    return [{
      id: `pattern:${pattern.name}`, group: "patterns", label: pattern.name, goals: ["understand", "deepen"],
      ...(twin === undefined ? {} : { conceptKey: conceptKey(twin) }),
      ...describe(same.flatMap(entry => entry.evidence), same.map(entry => entry.note).find(note => note !== undefined)),
    }];
  }).sort((a, b) => (position.get(a.conceptKey ?? "") ?? Infinity) - (position.get(b.conceptKey ?? "") ?? Infinity));

  const patternsNamed = (rule: string) => profile.patterns.filter(pattern => pattern.name.toLowerCase() === rule);
  const gapTopics = activeLensRules(profile, "fix").map((rule): Topic => ({
    id: `gap:${rule}`, group: "gaps", label: rule, goals: ["improve"], rule,
    ...(lensRuleDetail(rule) === undefined ? {} : { pillar: lensRuleDetail(rule)!.split(":")[0]! }),
    ...describe(patternsNamed(rule).flatMap(pattern => pattern.evidence), patternsNamed(rule).map(pattern => pattern.note).find(note => note !== undefined)),
  }));

  const step = (rule: string): Pick<Topic, "id" | "group" | "label" | "rule"> =>
    ({ id: `path:${rule}`, group: "nextSteps", label: `${rule} → ${lensRuleDestination(rule) ?? "?"}`, rule });
  const active = activeLensRules(profile, "next-level").map((rule): Topic => ({
    ...step(rule), goals: ["improve"],
    ...describe(patternsNamed(rule).flatMap(pattern => pattern.evidence), patternsNamed(rule).map(pattern => pattern.note).find(note => note !== undefined)),
  }));
  const skipped = skippedLensRules(profile, "next-level").map((entry): Topic => ({
    ...step(entry.rule), goals: [], skipped: entry.reason,
    ...describe(patternsNamed(entry.rule).flatMap(pattern => pattern.evidence), patternsNamed(entry.rule).map(pattern => pattern.note).find(note => note !== undefined)),
  }));
  return [...serviceTopics, ...patternTopics, ...gapTopics, ...active, ...skipped];
}
