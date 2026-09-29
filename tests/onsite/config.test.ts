import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOnsiteConfig, updateOnsiteConfig, effectiveOnsitePreferences, walkUpAllowed } from "../../src/onsite/config.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

describe("on-site configuration", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); }); afterEach(() => home.cleanup());
  it("reads missing defaults without creating a root/file", () => {
    const root = join(home.path, "missing");
    const config = readOnsiteConfig({ storeRoot: root });
    expect(config.allowWalkUp).toBe(false); expect(existsSync(root)).toBe(false);
  });
  it("preserves explicit false, reset inheritance, event scopes and prototype IDs", () => {
    const deps = { storeRoot: home.path };
    updateOnsiteConfig("constructor", { allowWalkUp: true, sessionWalkUp: [{ sessionId: "constructor", allowWalkUp: false }] }, deps);
    let config = readOnsiteConfig(deps);
    expect(walkUpAllowed(effectiveOnsitePreferences(config, "constructor"), "constructor")).toBe(false);
    expect(walkUpAllowed(effectiveOnsitePreferences(config, "other"), "constructor")).toBe(true);
    updateOnsiteConfig("constructor", { sessionWalkUp: [{ sessionId: "constructor", allowWalkUp: null }] }, deps);
    config = readOnsiteConfig(deps);
    expect(walkUpAllowed(effectiveOnsitePreferences(config, "constructor"), "constructor")).toBe(true);
    expect(statSync(join(home.path, "onsite.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home.path, ".onsite.lock"))).toBe(false);
  });
  it.each(["{bad", '{"schemaVersion":99}', '{"schemaVersion":1,"allowWalkUp":"yes","events":[]}'])("refuses corrupt/unsupported configuration without replacing it", contents => {
    const path = join(home.path, "onsite.json"); writeFileSync(path, contents);
    expect(() => readOnsiteConfig({ storeRoot: home.path })).toThrow(/config/i);
    expect(() => updateOnsiteConfig("event", { allowWalkUp: true }, { storeRoot: home.path })).toThrow();
    expect(readFileSync(path, "utf8")).toBe(contents); expect(existsSync(join(home.path, ".onsite.lock"))).toBe(false);
  });
  it("fails fast on an existing lock and preserves prior settings", () => {
    updateOnsiteConfig("event", { allowWalkUp: false }, { storeRoot: home.path });
    const before = readFileSync(join(home.path, "onsite.json"), "utf8");
    writeFileSync(join(home.path, ".onsite.lock"), "owned by another writer");
    expect(() => updateOnsiteConfig("event", { allowWalkUp: true }, { storeRoot: home.path })).toThrow(/busy/i);
    expect(readFileSync(join(home.path, "onsite.json"), "utf8")).toBe(before);
    expect(readFileSync(join(home.path, ".onsite.lock"), "utf8")).toBe("owned by another writer");
  });
  it("cleans its own lock and preserves prior data when atomic write fails", () => {
    updateOnsiteConfig("event", { allowWalkUp: false }, { storeRoot: home.path });
    const before = readFileSync(join(home.path, "onsite.json"), "utf8");
    expect(() => updateOnsiteConfig("event", { allowWalkUp: true }, { storeRoot: home.path, write: () => { throw new Error("disk full"); } })).toThrow("disk full");
    expect(readFileSync(join(home.path, "onsite.json"), "utf8")).toBe(before);
    expect(readdirSync(home.path)).toEqual(["onsite.json"]);
  });
  it.each(["root", "parent", "config-live", "config-dangling", "lock-live", "lock-dangling"])("refuses a controlled %s symlink before any mutation", shape => {
    const target = join(home.path, "target"); mkdirSync(target);
    let root = join(home.path, "store");
    if (shape === "root") symlinkSync(target, root);
    else if (shape === "parent") { symlinkSync(target, root); root = join(root, "nested"); }
    else {
      mkdirSync(root);
      const destination = join(target, "outside");
      if (shape.endsWith("live")) writeFileSync(destination, "sentinel");
      symlinkSync(destination, join(root, shape.startsWith("config") ? "onsite.json" : ".onsite.lock"));
    }
    const before = readdirSync(target);
    expect(() => updateOnsiteConfig("event", { allowWalkUp: true }, { storeRoot: root })).toThrow(/symlink/i);
    expect(readdirSync(target)).toEqual(before);
    if (shape.endsWith("live")) expect(readFileSync(join(target, "outside"), "utf8")).toBe("sentinel");
  });
  it.each([-1, NaN, Infinity])("rejects invalid travel minutes %s before creating configuration", minutes => {
    expect(() => updateOnsiteConfig("event", { routes: [{ from: "MGM Grand", to: "Venetian", mode: "walk", minutes }] }, { storeRoot: home.path })).toThrow();
    expect(readdirSync(home.path)).toEqual([]);
  });
});
