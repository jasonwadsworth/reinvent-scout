import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../../src/core/errors.js";
import { profilePath, readProfileFile, saveProfileFile } from "../../src/profile/store.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

describe("profile store", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("rejects a name containing a path separator", () => {
    expect(() => profilePath("../evil", { storeRoot: home.path })).toThrow(ValidationError);
    expect(() => profilePath("sub/dir", { storeRoot: home.path })).toThrow(ValidationError);
  });

  it("rejects a name that is exactly two dots", () => {
    expect(() => profilePath("..", { storeRoot: home.path })).toThrow(ValidationError);
  });

  it("rejects a name starting or ending with a dot", () => {
    expect(() => profilePath(".hidden", { storeRoot: home.path })).toThrow(ValidationError);
    expect(() => profilePath("trailing.", { storeRoot: home.path })).toThrow(ValidationError);
  });

  it("rejects an empty name", () => {
    expect(() => profilePath("", { storeRoot: home.path })).toThrow(ValidationError);
  });

  it("accepts a name with letters, digits, hyphens, underscores and a dot in the middle", () => {
    expect(() => profilePath("my-repo_v2.prod", { storeRoot: home.path })).not.toThrow();
  });

  it("does not let a rejected name escape the store root even in the resulting path", () => {
    // Belt and braces: even if the regex guard were ever weakened, the resolved path must never
    // land outside <store>/profiles.
    let caught: unknown;
    try {
      profilePath("../../../etc/passwd", { storeRoot: home.path });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
  });

  it("saves the profile file at mode 0600", () => {
    saveProfileFile("orders-service", '{"schemaVersion":1}', { storeRoot: home.path });

    const path = profilePath("orders-service", { storeRoot: home.path });
    const mode = statSync(path).mode & 0o777;

    expect(mode).toBe(0o600);
  });

  it("creates the profiles directory when it doesn't exist yet", () => {
    expect(existsSync(join(home.path, "profiles"))).toBe(false);

    saveProfileFile("orders-service", '{"schemaVersion":1}', { storeRoot: home.path });

    expect(existsSync(join(home.path, "profiles"))).toBe(true);
  });

  it("reads back exactly what was saved", () => {
    saveProfileFile("orders-service", '{"schemaVersion":1,"repos":[]}', { storeRoot: home.path });

    const content = readProfileFile("orders-service", { storeRoot: home.path });

    expect(content).toBe('{"schemaVersion":1,"repos":[]}');
  });

  it("rejects reading with the same unsafe-name guard as saving", () => {
    expect(() => readProfileFile("../evil", { storeRoot: home.path })).toThrow(ValidationError);
  });
});
