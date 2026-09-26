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
});
