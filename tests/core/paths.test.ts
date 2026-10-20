import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDirWithMode, resolveStoreRoot, STORE_DIR_MODE } from "../../src/core/paths.js";
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

describe("ensureDirWithMode", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("creates the store directory with mode 0700", () => {
    // createTempHome's own directory already exists (mkdtempSync creates it), so point the
    // directory at a not-yet-existing child of it -- otherwise this test would pass even if
    // ensureDirWithMode never created anything at all.
    const root = join(home.path, ".reinvent-scout");
    expect(existsSync(root)).toBe(false);

    ensureDirWithMode(root, STORE_DIR_MODE);

    expect(existsSync(root)).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it("refuses a regular file sitting where the store directory should be, naming the path", () => {
    const rootPath = join(home.path, ".reinvent-scout");
    writeFileSync(rootPath, "not a directory", "utf8");

    expect(() => ensureDirWithMode(rootPath, STORE_DIR_MODE)).toThrow(rootPath);
    // The file must be left exactly as it was: never replaced, never removed.
    expect(statSync(rootPath).isFile()).toBe(true);
  });

  it("does not widen the mode of an existing directory", () => {
    const preexisting = join(tmpdir(), `reinvent-scout-existing-${process.pid}-${Date.now()}`);
    mkdirSync(preexisting);
    // Force the mode explicitly rather than trusting mkdirSync's `mode` option, which is
    // filtered by the process umask -- under a restrictive umask (e.g. 077) a requested 0755
    // would silently come out as 0700, making this test pass for the wrong reason (an
    // implementation that always widens to 0700 would look identical to one that correctly
    // leaves an existing directory untouched).
    chmodSync(preexisting, 0o755);
    try {
      ensureDirWithMode(preexisting, STORE_DIR_MODE);

      expect(statSync(preexisting).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(preexisting, { recursive: true, force: true });
    }
  });

  it("creates missing parent directories at mode 0700 too", () => {
    const nestedRoot = join(home.path, "does-not-exist-yet", "also-missing", ".reinvent-scout");
    expect(existsSync(nestedRoot)).toBe(false);

    ensureDirWithMode(nestedRoot, STORE_DIR_MODE);

    expect(statSync(nestedRoot).mode & 0o777).toBe(0o700);
    expect(statSync(join(home.path, "does-not-exist-yet")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home.path, "does-not-exist-yet", "also-missing")).mode & 0o777).toBe(
      0o700,
    );
  });
});
