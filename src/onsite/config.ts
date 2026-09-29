import { closeSync, lstatSync, openSync, readFileSync, readlinkSync, unlinkSync } from "node:fs";
import { join, parse, resolve } from "node:path";
import { z } from "zod";
import { VENUES } from "../catalog/venue.js";
import { writeFileAtomic } from "../core/atomic-write.js";
import { ensureDirWithMode } from "../core/paths.js";

const minutes = z.number().finite().min(0).max(240);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const timeWindowSchema = z.strictObject({ start: clock, end: clock }).refine(w => w.start !== w.end, "Window must have positive duration");
const id = z.string().min(1).max(128);
export const routeSchema = z.strictObject({ from: z.enum(VENUES), to: z.enum(VENUES), mode: z.enum(["walk", "shuttle"]), minutes, waitMinutes: minutes.optional(), windows: z.array(timeWindowSchema).max(20).optional(), peakBufferMinutes: minutes.optional() });
const sessionPreference = z.strictObject({ sessionId: id, allowWalkUp: z.boolean() });
const eventShape = {
  sessionWalkUp: z.array(sessionPreference).max(500), checkInMinutes: minutes,
  freshnessMinutes: z.number().finite().min(1).max(60), shuttleEnabled: z.boolean(),
  shuttleWindows: z.array(timeWindowSchema).max(20), peakWindows: z.array(timeWindowSchema).max(20),
  peakBufferMinutes: minutes, routes: z.array(routeSchema).max(50),
};
const eventSchema = z.strictObject({ eventId: id, ...eventShape });
const configSchema = z.strictObject({ schemaVersion: z.literal(1), allowWalkUp: z.boolean(), events: z.array(eventSchema).max(100) });
export const onsitePatchSchema = z.strictObject({
  allowWalkUp: z.boolean().optional(),
  sessionWalkUp: z.array(z.strictObject({ sessionId: id, allowWalkUp: z.boolean().nullable() })).max(500).optional(),
  checkInMinutes: minutes.optional(), freshnessMinutes: z.number().finite().min(1).max(60).optional(),
  shuttleEnabled: z.boolean().optional(), shuttleWindows: z.array(timeWindowSchema).max(20).optional(),
  peakWindows: z.array(timeWindowSchema).max(20).optional(), peakBufferMinutes: minutes.optional(), routes: z.array(routeSchema).max(50).optional(),
});
export type OnsiteConfig = z.infer<typeof configSchema>;
export type OnsitePatch = z.infer<typeof onsitePatchSchema>;
export type OnsitePreferences = z.infer<typeof eventSchema> & { allowWalkUp: boolean };
export interface OnsiteConfigDeps { storeRoot: string; write?: typeof writeFileAtomic }
function defaults(eventId: string): z.infer<typeof eventSchema> {
  return { eventId, sessionWalkUp: [], checkInMinutes: 10, freshnessMinutes: 5, shuttleEnabled: false, shuttleWindows: [], peakWindows: [{ start: "08:00", end: "10:00" }, { start: "16:00", end: "18:00" }], peakBufferMinutes: 5, routes: [] };
}
function assertSafePath(path: string): void {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split("/")) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        const target = resolve(parse(current).dir, readlinkSync(current));
        if (!((current === "/tmp" && target === "/private/tmp") || (current === "/var" && target === "/private/var"))) throw new Error("On-site config refuses a symlink path");
      }
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  }
}
function paths(root: string) {
  const file = join(root, "onsite.json"), lock = join(root, ".onsite.lock");
  assertSafePath(file); assertSafePath(lock); return { file, lock };
}
export function readOnsiteConfig(deps: OnsiteConfigDeps): OnsiteConfig {
  const { file } = paths(deps.storeRoot);
  try { return configSchema.parse(JSON.parse(readFileSync(file, "utf8"))); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, allowWalkUp: false, events: [] };
    throw new Error("Invalid on-site configuration", { cause: err });
  }
}
export function effectiveOnsitePreferences(config: OnsiteConfig, eventId: string): OnsitePreferences {
  return { ...(config.events.find(event => event.eventId === eventId) ?? defaults(eventId)), allowWalkUp: config.allowWalkUp };
}
export function walkUpAllowed(prefs: OnsitePreferences, sessionId: string): boolean {
  return prefs.sessionWalkUp.find(item => item.sessionId === sessionId)?.allowWalkUp ?? prefs.allowWalkUp;
}
export function updateOnsiteConfig(eventId: string, input: OnsitePatch, deps: OnsiteConfigDeps): OnsiteConfig {
  id.parse(eventId); const patch = onsitePatchSchema.parse(input);
  const { file, lock } = paths(deps.storeRoot);
  ensureDirWithMode(deps.storeRoot, 0o700);
  let fd: number;
  try { fd = openSync(lock, "wx", 0o600); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error("On-site configuration is busy"); throw err; }
  try {
    const config = readOnsiteConfig(deps);
    const previous = config.events.find(event => event.eventId === eventId) ?? defaults(eventId);
    const overrides = new Map(previous.sessionWalkUp.map(item => [item.sessionId, item.allowWalkUp]));
    for (const item of patch.sessionWalkUp ?? []) { if (item.allowWalkUp === null) overrides.delete(item.sessionId); else overrides.set(item.sessionId, item.allowWalkUp); }
    const { allowWalkUp, sessionWalkUp: ignored, ...eventPatch } = patch;
    void ignored;
    const event = eventSchema.parse({ ...previous, ...eventPatch, sessionWalkUp: Array.from(overrides, ([sessionId, allowWalkUp]) => ({ sessionId, allowWalkUp })) });
    const next = configSchema.parse({ ...config, allowWalkUp: allowWalkUp ?? config.allowWalkUp, events: [...config.events.filter(item => item.eventId !== eventId), event] });
    (deps.write ?? writeFileAtomic)(file, () => JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    return next;
  } finally { closeSync(fd); unlinkSync(lock); }
}
