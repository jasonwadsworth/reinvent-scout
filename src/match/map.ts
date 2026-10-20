import type { CatalogStoreDeps } from "../catalog/store.js";
import type { ResolvedProfile } from "../profile/profile.js";
import { platformServicesOf } from "./stack-fit.js";
import { createFocusEngine } from "./focus.js";
import { type SessionPreferences } from "./preferences.js";
import type { Goal, Topic } from "./topics.js";
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
  /** The platform services the profile uses and the map leaves out, by short name ("S3", "KMS"): nearly every workload uses them, so they do not narrow sessions. */
  omittedPlatformServices: string[];
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
  return { services: group("services"), patterns: group("patterns"), gaps: group("gaps"), nextSteps: group("nextSteps"), omittedPlatformServices: platformServicesOf(profile), ...(preferences === undefined ? {} : { preferences }) };
}
