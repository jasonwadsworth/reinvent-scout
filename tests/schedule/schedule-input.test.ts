import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../../src/core/errors.js";
import { readScheduleInput, scheduleInputSchema } from "../../src/schedule/schedule-input.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const personal = { personalTimeId: "p1", startDateTime: "2026-12-02T19:00:00", endDateTime: "2026-12-02T20:00:00", title: "Lunch", description: "With a friend", location: "Venetian" };
const aws = { reserved: ["a", "b"], favorites: ["c"], personalTime: [personal] };

describe("schedule input", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); }); afterEach(() => home.cleanup());
  const file = (name: string, content: unknown) => { const path = join(home.path, name); writeFileSync(path, JSON.stringify(content)); return path; };

  it("accepts a verbatim AWS Schedule, favorites included", () => {
    expect(scheduleInputSchema.parse(aws)).toEqual(aws);
    expect(readScheduleInput({ schedule: aws })).toEqual(aws);
  });
  it("defaults favorites to empty", () => {
    expect(readScheduleInput({ schedule: { reserved: [], personalTime: [] } })).toEqual({ reserved: [], favorites: [], personalTime: [] });
  });
  it("strips unknown personalTime keys", () => {
    const parsed = scheduleInputSchema.parse({ ...aws, personalTime: [{ ...personal, surprise: "x" }] });
    expect(parsed.personalTime[0]).not.toHaveProperty("surprise");
  });
  it("shortens long personal-time text instead of rejecting the whole schedule", () => {
    const long = { ...personal, title: "t".repeat(5000), description: "d".repeat(5000), location: "l".repeat(5000) };
    const parsed = readScheduleInput({ schedule: { ...aws, personalTime: [long] } });
    expect(parsed.personalTime[0]!.title).toHaveLength(300);
    expect(parsed.personalTime[0]!.description).toHaveLength(2000);
    expect(parsed.personalTime[0]!.location).toHaveLength(300);
  });
  it("reads a bare schedule or a {schedule} wrapper from a file", () => {
    expect(readScheduleInput({ scheduleFile: file("bare.json", aws) })).toEqual(aws);
    expect(readScheduleInput({ scheduleFile: file("wrapped.json", { schedule: aws }) })).toEqual(aws);
  });
  it.each([
    ["a Z suffix", { ...aws, personalTime: [{ ...personal, startDateTime: "2026-12-02T19:00:00Z" }] }],
    ["milliseconds", { ...aws, personalTime: [{ ...personal, endDateTime: "2026-12-02T20:00:00.000" }] }],
    ["more than 1000 reserved ids", { ...aws, reserved: Array.from({ length: 1001 }, (_, i) => `s${i}`) }],
    ["an unknown top-level key", { ...aws, extra: true }],
    ["an empty id", { ...aws, reserved: [""] }],
  ])("rejects %s", (_name, schedule) => {
    expect(() => scheduleInputSchema.parse(schedule)).toThrow();
    expect(() => readScheduleInput({ schedule })).toThrow(ValidationError);
  });
  it("rejects both schedule and scheduleFile, or neither", () => {
    expect(() => readScheduleInput({ schedule: aws, scheduleFile: file("x.json", aws) })).toThrow(/exactly one/);
    expect(() => readScheduleInput({})).toThrow(/exactly one/);
  });
  it("lets the caller treat the schedule as optional", () => {
    expect(readScheduleInput({}, { optional: true })).toBeUndefined();
    expect(() => readScheduleInput({ schedule: aws, scheduleFile: file("y.json", aws) }, { optional: true })).toThrow(/exactly one/);
  });
  it("applies the safe-file rules to scheduleFile", () => {
    expect(() => readScheduleInput({ scheduleFile: "relative.json" })).toThrow(/absolute/);
    expect(() => readScheduleInput({ scheduleFile: join(home.path, "missing.json") })).toThrow(ValidationError);
  });
  it("never echoes a bad file's content", () => {
    const path = join(home.path, "leak.json"); writeFileSync(path, "SECRET-MARKER not json");
    let message = ""; try { readScheduleInput({ scheduleFile: path }); } catch (err) { message = (err as Error).message; }
    expect(message).toContain("leak.json");
    expect(message).not.toContain("SECRET-MARKER");
    const shaped = file("shaped.json", { reserved: [{ SECRET: "SECRET-MARKER" }], personalTime: [] });
    try { readScheduleInput({ scheduleFile: shaped }); } catch (err) { message = (err as Error).message; }
    expect(message).not.toContain("SECRET-MARKER");
  });
});
