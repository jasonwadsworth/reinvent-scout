import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CatalogImportRejectedError } from "../../src/catalog/import.js";
import { CatalogMissingError, ValidationError } from "../../src/core/errors.js";
import { toCommandError } from "../../src/commands/errors.js";

describe("toCommandError", () => {
  it("maps an Error to its message", () => {
    expect(toCommandError(new ValidationError("bad input"))).toEqual({ error: "bad input" });
    expect(toCommandError("plain string")).toEqual({ error: "plain string" });
  });
  it("keeps the reason of an import rejection", () => {
    expect(toCommandError(new CatalogImportRejectedError("shrunk", "85 of 100"))).toEqual({ error: "shrunk: 85 of 100", reason: "shrunk" });
  });
  it("formats a zod error with its field paths", () => {
    const schema = z.object({ a: z.object({ b: z.number() }) });
    const parsed = schema.safeParse({ a: { b: "x" } });
    if (parsed.success) throw new Error("expected a failure");
    expect(toCommandError(parsed.error).error).toMatch(/^a\.b: /);
  });
  it("names the catalog sync when nothing is imported", () => {
    expect(toCommandError(new CatalogMissingError()).error).toMatch(/sync/i);
  });
  it("cuts any message, including a reason-carrying one and a zod error, to 512 characters", () => {
    const long = "x".repeat(5000);
    expect(toCommandError(new Error(long)).error.length).toBeLessThanOrEqual(512);
    expect(toCommandError(new CatalogImportRejectedError("partial", long))).toMatchObject({ reason: "partial" });
    expect(toCommandError(new CatalogImportRejectedError("partial", long)).error.length).toBeLessThanOrEqual(512);
    const many = z.array(z.strictObject({ field: z.string() })).safeParse(Array.from({ length: 200 }, () => ({})));
    if (many.success) throw new Error("expected a failure");
    expect(toCommandError(many.error).error.length).toBeLessThanOrEqual(512);
  });
  it("leaves a short message untouched", () => {
    expect(toCommandError(new Error("short")).error).toBe("short");
  });
});
