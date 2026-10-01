import { ValidationError } from "../core/errors.js";
import type { CatalogStoreDeps } from "../catalog/store.js";
import type { ResolvedProfile } from "../profile/profile.js";
import { createFocusEngine } from "./focus.js";
import { type SessionPreferences } from "./preferences.js";
import { goalsOf, type Goal, type Topic, type TopicGroup } from "./topics.js";
import type { Citation } from "./why.js";

/** How many sessions a goal would list for a topic, counted by the same matcher `matchFocus` uses. */
export interface GoalCount {
  goal: Goal;
  sessions: number;
  /** Why there are none, when there are none: the dead end explained (the closest 300-level session, a path already taken, ...). */
  reason?: string;
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
  /** The preferences the counts were made under, absent when there were none. */
  preferences?: SessionPreferences;
}

/** The profile's topics with, for each goal that applies, the number of sessions it would return. A goal with none is kept at 0,
 * so a dead end is visible before it is picked. */
export function mapProfile(profile: ResolvedProfile, deps: CatalogStoreDeps, options: { preferences?: SessionPreferences } = {}): ProfileMap {
  const engine = createFocusEngine(profile, deps, options.preferences);
  const { preferences } = engine;
  const describe = (topic: Topic): MapTopic => ({
    id: topic.id, label: topic.label,
    ...(topic.note === undefined ? {} : { note: topic.note }),
    evidence: topic.evidence,
    ...(topic.more === undefined ? {} : { more: topic.more }),
    ...(topic.pillar === undefined ? {} : { pillar: topic.pillar }),
    ...(topic.skipped === undefined ? {} : { skipped: topic.skipped }),
    goals: topic.goals.map((goal): GoalCount => {
      const { candidates, reason } = engine.list(topic, goal);
      return { goal, sessions: candidates.length, ...(candidates.length === 0 && reason !== undefined ? { reason } : {}) };
    }),
  });
  const group = (name: Topic["group"]): MapTopic[] => engine.topics.filter(topic => topic.group === name).map(describe);
  return { services: group("services"), patterns: group("patterns"), gaps: group("gaps"), nextSteps: group("nextSteps"), ...(preferences === undefined ? {} : { preferences }) };
}

const bare = (text: string): string => text.replace(/\s*\([^()]*\)\s*$/, "").replace(/^(?:Amazon|AWS)\s+/i, "").trim().toLowerCase();
/** What a person may call a topic: its label, the part of its id after the colon, and a service's parenthesized short name. */
const names = (topic: { id: string; label: string }): Set<string> => {
  const short = /\(([^()]+)\)\s*$/.exec(topic.id)?.[1];
  return new Set([bare(topic.label), bare(topic.id.slice(topic.id.indexOf(":") + 1)), ...(short === undefined ? [] : [bare(short)])]);
};

/** A topic that can be named in a typed choice. */
export interface Nameable {
  id: string;
  label: string;
  group: TopicGroup;
  /** Topics with the same concept (a service and its pattern twin, ecs) are one choice. */
  conceptKey?: string | undefined;
}

/**
 * A topic id from what a person typed: the id itself, or its bare label ("DynamoDB", "ECS", "gap-no-dlq") when exactly one topic
 * that supports the goal has it. A service and its pattern twin count once, the first.
 */
export function resolveTopic(all: readonly Nameable[], text: string, goal: Goal): string {
  const exact = all.find(topic => topic.id === text);
  if (exact !== undefined) return exact.id;
  const wanted = bare(text);
  const found = all.filter(topic => goalsOf(topic.group).includes(goal) && names(topic).has(wanted))
    .filter((topic, position, list) => topic.conceptKey === undefined || list.findIndex(other => other.conceptKey === topic.conceptKey) === position);
  if (found.length === 1) return found[0]!.id;
  const elsewhere = all.find(topic => names(topic).has(wanted));
  if (found.length === 0 && elsewhere !== undefined) {
    throw new ValidationError(`Goal "${goal}" does not apply to "${elsewhere.id}" (applicable: ${goalsOf(elsewhere.group).join(", ")}).`);
  }
  const valid = all.map(topic => topic.id).join(", ");
  throw new ValidationError(found.length === 0
    ? `Unknown topic "${text}" for ${goal}. Valid topics: ${valid}.`
    : `Topic "${text}" is ambiguous for ${goal}: ${found.map(topic => topic.id).join(", ")}. Use the full id.`);
}
