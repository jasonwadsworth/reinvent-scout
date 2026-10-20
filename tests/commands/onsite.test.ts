import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callCommand } from "../helpers/call-command.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

describe("on-site preference commands", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); });
  afterEach(() => home.cleanup());
  const run = (name: "get_onsite_preferences" | "set_onsite_preferences" | "nearby_sessions", input: unknown) => callCommand(name, input, { storeRoot: home.path });

  it("reads and updates event walk-up preferences, per event, and reads the update back", async () => {
    expect(JSON.parse((await run("get_onsite_preferences", { eventId: "constructor" })).text).allowWalkUp).toBe(false);
    const updated = await run("set_onsite_preferences", { eventId: "constructor", patch: { allowWalkUp: true, sessionWalkUp: [{ sessionId: "constructor", allowWalkUp: false }] } });
    expect(updated.isError).toBe(false);
    expect(JSON.parse(updated.text).sessionWalkUp).toEqual([{ sessionId: "constructor", allowWalkUp: false }]);
    const reread = JSON.parse((await run("get_onsite_preferences", { eventId: "constructor" })).text);
    expect(reread).toMatchObject({ allowWalkUp: true, sessionWalkUp: [{ sessionId: "constructor", allowWalkUp: false }] });
    // Another event keeps its own settings: the event id is honored, not replaced by the default.
    expect(JSON.parse((await run("get_onsite_preferences", {})).text).sessionWalkUp ?? []).toEqual([]);
  });

  it("refuses an unknown venue", async () => {
    expect((await run("nearby_sessions", { location: { venue: "alien", source: "user", confirmed: true } })).isError).toBe(true);
  });
});
