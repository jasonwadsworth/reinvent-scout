import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

export interface PkceDeps {
  /** Defaults to `node:crypto`'s `randomBytes`. Inject a stub for deterministic tests. */
  randomBytes?: (size: number) => Buffer;
}

/**
 * Generates a PKCE code verifier: a high-entropy, base64url-encoded (no padding) random
 * string. 32 random bytes encode to 43 characters, the RFC 7636 minimum.
 */
export function generateCodeVerifier(deps: PkceDeps = {}): string {
  const randomBytes = deps.randomBytes ?? nodeRandomBytes;
  return randomBytes(32).toString("base64url");
}

/** Derives the S256 code challenge for a given verifier, per RFC 7636. */
export function deriveCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest().toString("base64url");
}

/** Generates an opaque, unguessable `state` value for CSRF protection on the auth redirect. */
export function generateState(deps: PkceDeps = {}): string {
  const randomBytes = deps.randomBytes ?? nodeRandomBytes;
  return randomBytes(16).toString("base64url");
}
