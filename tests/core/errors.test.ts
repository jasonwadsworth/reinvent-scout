import { describe, expect, it } from "vitest";
import { CatalogMissingError, CatalogUnusableError, ValidationError } from "../../src/core/errors.js";

describe("CatalogMissingError", () => {
  it("is an Error with a distinct name and a default message naming the sync command", () => {
    const err = new CatalogMissingError();

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CatalogMissingError");
    // The message names the agent that fixes it.
    expect(err.message).toMatch(/reinvent-scout:catalog-sync/);
  });

  it("accepts a custom message", () => {
    const err = new CatalogMissingError("custom reason");

    expect(err.message).toBe("custom reason");
  });
});

describe("CatalogUnusableError", () => {
  it("carries a reason distinguishing an outdated format from an unreadable one, plus a message", () => {
    const outdated = new CatalogUnusableError("outdated", "rebuild it");
    const corrupt = new CatalogUnusableError("corrupt", "rebuild it too");

    expect(outdated).toBeInstanceOf(Error);
    expect(outdated.name).toBe("CatalogUnusableError");
    expect(outdated.reason).toBe("outdated");
    expect(outdated.message).toBe("rebuild it");
    expect(corrupt.reason).toBe("corrupt");
  });

  it("is distinguishable from CatalogMissingError, since the remedies genuinely differ", () => {
    // CatalogMissingError means "never imported" -- needs the catalog-sync agent.
    // CatalogUnusableError means "imported, but the local index can't be trusted" -- a local
    // rebuild fixes it, no import required. A caller needs to branch on which one it got.
    const err = new CatalogUnusableError("outdated", "rebuild it");

    expect(err).not.toBeInstanceOf(CatalogMissingError);
  });
});

describe("ValidationError", () => {
  it("carries the message given to it and a distinct name", () => {
    expect(new ValidationError("bad field").message).toBe("bad field");
    expect(new ValidationError("bad field").name).toBe("ValidationError");
  });
});

describe("the errors module", () => {
  it("exports only the errors the plugin raises", async () => {
    expect(Object.keys(await import("../../src/core/errors.js")).sort()).toEqual(["CatalogMissingError", "CatalogUnusableError", "ValidationError"]);
  });
});
