import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/core/errors.js";
import { validateSessionIds } from "../../src/schedule/session-ids.js";

const MESSAGE = "Expected 0–50 session IDs, each 1–128 characters.";

describe("validateSessionIds", () => {
  it("trims each id and removes duplicates in order", () => {
    expect(validateSessionIds([" a ", "b", "a"])).toEqual(["a", "b"]);
  });

  it("accepts an empty list", () => {
    expect(validateSessionIds([])).toEqual([]);
  });

  it("accepts 50 ids and rejects 51", () => {
    expect(validateSessionIds(Array.from({ length: 50 }, (_, i) => `s${i}`))).toHaveLength(50);
    expect(() => validateSessionIds(Array.from({ length: 51 }, (_, i) => `s${i}`))).toThrow(new ValidationError(MESSAGE));
  });

  it("rejects an empty id, also once trimmed", () => {
    expect(() => validateSessionIds([""])).toThrow(new ValidationError(MESSAGE));
    expect(() => validateSessionIds(["   "])).toThrow(new ValidationError(MESSAGE));
  });

  it("rejects an id that is not a string", () => {
    expect(() => validateSessionIds([42 as unknown as string])).toThrow(new ValidationError(MESSAGE));
  });

  it("counts code points: 128 are accepted, 129 are not", () => {
    expect(validateSessionIds(["界".repeat(128)])).toEqual(["界".repeat(128)]);
    expect(() => validateSessionIds(["界".repeat(129)])).toThrow(new ValidationError(MESSAGE));
  });
});
