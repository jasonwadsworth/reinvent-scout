import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureStoreRoot, resolveStoreRoot } from "../../src/core/paths.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

describe("resolveStoreRoot", () => {
  it("defaults the store root to ~/.reinvent-scout", () => {
    const root = resolveStoreRoot({
      env: {},
      homedir: () => "/home/attendee",
    });
    expect(root).toBe(join("/home/attendee", ".reinvent-scout"));
  });

  it("honours REINVENT_SCOUT_HOME over the home directory", () => {
    const root = resolveStoreRoot({
      env: { REINVENT_SCOUT_HOME: "/custom/store" },
      homedir: () => "/home/attendee",
    });
    expect(root).toBe("/custom/store");
  });
});

describe("ensureStoreRoot", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("creates the store directory with mode 0700", () => {
    const root = ensureStoreRoot({ env: home.env });

    expect(existsSync(root)).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it("does not widen the mode of an existing directory", () => {
    const preexisting = join(tmpdir(), `reinvent-scout-existing-${process.pid}-${Date.now()}`);
    mkdirSync(preexisting, { mode: 0o755 });
    try {
      const root = ensureStoreRoot({ env: { REINVENT_SCOUT_HOME: preexisting } });

      expect(root).toBe(preexisting);
      expect(statSync(root).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(preexisting, { recursive: true, force: true });
    }
  });
});
