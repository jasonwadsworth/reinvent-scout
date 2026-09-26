import { describe, expect, it } from "vitest";
import { deriveCodeChallenge, generateCodeVerifier, generateState } from "../../src/auth/pkce.js";

describe("generateCodeVerifier", () => {
  it("generates a base64url verifier of 43 to 128 characters with no padding", () => {
    const verifier = generateCodeVerifier();

    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier).not.toContain("=");
  });

  it("uses the injected randomness source rather than node:crypto's own", () => {
    const sizesRequested: number[] = [];
    const fakeRandomBytes = (size: number): Buffer => {
      sizesRequested.push(size);
      return Buffer.alloc(size, 0x01);
    };

    const verifier = generateCodeVerifier({ randomBytes: fakeRandomBytes });

    expect(sizesRequested).toEqual([32]);
    // A verifier derived from real entropy would not equal this fixed value with any
    // meaningful probability, so this is proof the injected function's output -- not
    // node:crypto's -- flowed through to the result, not just that it was called.
    expect(verifier).toBe(Buffer.alloc(32, 0x01).toString("base64url"));
  });
});

describe("deriveCodeChallenge", () => {
  it("derives the challenge as the base64url S256 hash of the verifier", () => {
    // RFC 7636 Appendix B worked example.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expectedChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    expect(deriveCodeChallenge(verifier)).toBe(expectedChallenge);
  });
});

describe("generateState", () => {
  it("generates a distinct state on every call", () => {
    const first = generateState();
    const second = generateState();

    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThan(0);
    expect(second).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("uses the injected randomness source rather than node:crypto's own", () => {
    const sizesRequested: number[] = [];
    const fakeRandomBytes = (size: number): Buffer => {
      sizesRequested.push(size);
      return Buffer.alloc(size, 0x02);
    };

    const state = generateState({ randomBytes: fakeRandomBytes });

    expect(sizesRequested).toEqual([16]);
    expect(state).toBe(Buffer.alloc(16, 0x02).toString("base64url"));
  });
});
