import { describe, expect, it } from "vitest";
import {
  AuthRequiredError,
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
