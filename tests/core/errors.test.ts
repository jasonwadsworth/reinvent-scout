import { describe, expect, it } from "vitest";
import {
  AuthRequiredError,
  CatalogMissingError,
  CatalogUnusableError,
  NotFoundError,
  NotRegisteredError,
  OperationUnavailableError,
  ServiceError,
  ThrottledError,
  ValidationError,
} from "../../src/core/errors.js";

describe("AuthRequiredError", () => {
  it("is an Error with a distinct name and a default message telling the user how to sign in", () => {
    const err = new AuthRequiredError();

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AuthRequiredError");
    expect(err.message).toMatch(/auth login/);
  });

  it("accepts a custom message", () => {
    const err = new AuthRequiredError("custom reason");

    expect(err.message).toBe("custom reason");
  });
});

describe("NotRegisteredError", () => {
  it("states that signing in again will not help", () => {
    const err = new NotRegisteredError();

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("NotRegisteredError");
    expect(err.message).toMatch(/will not help/i);
  });
});

describe("CatalogMissingError", () => {
  it("is an Error with a distinct name and a default message naming the sync command", () => {
    const err = new CatalogMissingError();

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CatalogMissingError");
    // Mirrors AuthRequiredError's pattern -- these are the pair of "you need to do something
    // first" errors a new user will hit, and both name the exact command that fixes it.
    expect(err.message).toMatch(/catalog sync/);
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
    // CatalogMissingError means "never synced" -- needs network and a signed-in session.
    // CatalogUnusableError means "synced, but the local index can't be trusted" -- a local
    // rebuild fixes it, no network or session required. A caller (part 3's MCP tools especially)
    // needs to branch on which one it got rather than treating both as "go run catalog sync".
    const err = new CatalogUnusableError("outdated", "rebuild it");

    expect(err).not.toBeInstanceOf(CatalogMissingError);
  });
});

describe("ThrottledError", () => {
  it("is an Error with a distinct name", () => {
    const err = new ThrottledError();

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ThrottledError");
  });
});

describe("ValidationError, NotFoundError, OperationUnavailableError, ServiceError", () => {
  it("each carry the message given to them and a distinct name", () => {
    expect(new ValidationError("bad field").message).toBe("bad field");
    expect(new ValidationError("bad field").name).toBe("ValidationError");
    expect(new NotFoundError("no such session").name).toBe("NotFoundError");
    expect(new OperationUnavailableError("disabled").name).toBe("OperationUnavailableError");
    expect(new ServiceError("internal error").name).toBe("ServiceError");
  });
});
