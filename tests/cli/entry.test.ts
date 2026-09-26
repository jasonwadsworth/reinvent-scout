import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMainModule } from "../../src/cli/entry.js";

describe("isMainModule", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reinvent-scout-entry-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("recognises direct invocation when the module url and argv[1] refer to the same file", () => {
    const file = join(dir, "main.js");
    writeFileSync(file, "");

    expect(isMainModule(pathToFileURL(file).href, file)).toBe(true);
  });

  it("recognises direct invocation when the path contains a space", () => {
    const spacedDir = join(dir, "has space");
    mkdirSync(spacedDir, { recursive: true });
    const file = join(spacedDir, "main.js");
    writeFileSync(file, "");

    expect(isMainModule(pathToFileURL(file).href, file)).toBe(true);
  });

  it("resolves symlinks before comparing", () => {
    const real = join(dir, "real-main.js");
    const link = join(dir, "bin-link.js");
    writeFileSync(real, "");
    symlinkSync(real, link);

    // The module was loaded through the symlink (its URL is the symlink path), but the
    // shell invoked it via the real path in argv[1] (or vice versa) -- both must compare equal.
    expect(isMainModule(pathToFileURL(link).href, real)).toBe(true);
  });

  it("returns false when argv[1] is undefined, such as a REPL or --eval invocation", () => {
    const file = join(dir, "main.js");
    writeFileSync(file, "");

    expect(isMainModule(pathToFileURL(file).href, undefined)).toBe(false);
  });

  it("returns false when the module url points to a different file than argv[1]", () => {
    const a = join(dir, "a.js");
    const b = join(dir, "b.js");
    writeFileSync(a, "");
    writeFileSync(b, "");

    expect(isMainModule(pathToFileURL(a).href, b)).toBe(false);
  });
});
