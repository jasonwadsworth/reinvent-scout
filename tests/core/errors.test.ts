import { describe, expect, it } from "vitest";
import { AuthRequiredError } from "../../src/core/errors.js";

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
