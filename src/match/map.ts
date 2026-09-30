import { ValidationError } from "../core/errors.js";
import type { CatalogStoreDeps } from "../catalog/store.js";
import type { ResolvedProfile } from "../profile/profile.js";
import { createFocusEngine } from "./focus.js";
import type { Goal, Topic } from "./topics.js";
import type { Citation } from "./why.js";

/** How many sessions a goal would list for a topic, counted by the same matcher `matchFocus` uses. */
export interface GoalCount {
  goal: Goal;
  sessions: number;
}

export interface MapTopic {
  id: string;
  label: string;
  note?: string;
  evidence: Citation[];
  more?: number;
  pillar?: string;
  skipped?: string;
  goals: GoalCount[];
}

/** What the profile found in the code, grouped, for the user to choose from. */
export interface ProfileMap {
  services: MapTopic[];
  patterns: MapTopic[];
  gaps: MapTopic[];
  nextSteps: MapTopic[];
}

/** The profile's topics with, for each goal that applies, the number of sessions it would return. A goal with none is kept at 0,
 * so a dead end is visible before it is picked. */
export function mapProfile(profile: ResolvedProfile, deps: CatalogStoreDeps): ProfileMap {
  const engine = createFocusEngine(profile, deps);
  const describe = (topic: Topic): MapTopic => ({
    id: topic.id, label: topic.label,
    ...(topic.note === undefined ? {} : { note: topic.note }),
    evidence: topic.evidence,
    ...(topic.more === undefined ? {} : { more: topic.more }),
    ...(topic.pillar === undefined ? {} : { pillar: topic.pillar }),
    ...(topic.skipped === undefined ? {} : { skipped: topic.skipped }),
    goals: topic.goals.map(goal => ({ goal, sessions: engine.list(topic, goal).candidates.length })),
  });
  const group = (name: Topic["group"]): MapTopic[] => engine.topics.filter(topic => topic.group === name).map(describe);
  return { services: group("services"), patterns: group("patterns"), gaps: group("gaps"), nextSteps: group("nextSteps") };
}

const bare = (text: string): string => text.replace(/\s*\([^()]*\)\s*$/, "").replace(/^(?:Amazon|AWS)\s+/i, "").trim().toLowerCase();

/** A topic id from what a person typed: the id itself, or its bare label ("DynamoDB", "gap-no-dlq") when exactly one topic has it. */
export function resolveTopic(all: readonly { id: string; label: string }[], text: string): string {
  const exact = all.find(topic => topic.id === text);
  if (exact !== undefined) return exact.id;
  const wanted = bare(text);
  const found = all.filter(topic => bare(topic.label) === wanted || bare(topic.id.slice(topic.id.indexOf(":") + 1)) === wanted);
  if (found.length === 1) return found[0]!.id;
  const valid = all.map(topic => topic.id).join(", ");
  throw new ValidationError(found.length === 0
    ? `Unknown topic "${text}". Valid topics: ${valid}.`
    : `Topic "${text}" is ambiguous: ${found.map(topic => topic.id).join(", ")}. Use the full id.`);
}
