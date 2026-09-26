import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../core/atomic-write.js";

const TOKEN_FILE_NAME = "tokens.json";
const TOKEN_FILE_MODE = 0o600;

/** The window before a token's real expiry that it is treated as already expired. */
const EXPIRY_SKEW_MS = 120_000;

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  tokenType: string;
  expiresIn: number;
  obtainedAt: number;
}

export interface TokenStoreDeps {
  /** The resolved store root (see src/core/paths.ts). tokens.json lives directly under it. */
  storeRoot: string;
}

export interface ClockDeps {
  /** Defaults to `Date.now`. Inject a stub for deterministic expiry tests. */
  now?: () => number;
}

export type TokenStoreState =
  | { status: "absent" }
  | { status: "corrupt"; reason: string }
  | { status: "present"; tokens: StoredTokens };

export function tokenFilePath(storeRoot: string): string {
  return join(storeRoot, TOKEN_FILE_NAME);
}

/** Persists the tokens atomically at mode 0600, creating the store root if needed. */
export function saveTokens(tokens: StoredTokens, deps: TokenStoreDeps): void {
  mkdirSync(deps.storeRoot, { recursive: true });
  writeFileAtomic(tokenFilePath(deps.storeRoot), () => JSON.stringify(tokens), {
    mode: TOKEN_FILE_MODE,
  });
}

function isStoredTokens(value: unknown): value is StoredTokens {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.accessToken === "string" &&
    typeof v.refreshToken === "string" &&
    typeof v.idToken === "string" &&
    typeof v.tokenType === "string" &&
    typeof v.expiresIn === "number" &&
    typeof v.obtainedAt === "number"
  );
}

/**
 * Reads the token store. Never throws: a missing file is "absent", and invalid JSON or a
 * malformed shape is "corrupt" with a fixed, generic reason string -- never the raw file
 * content or a native parse error's message, either of which could echo real token material
 * back out in an error.
 */
export function readTokenStore(deps: TokenStoreDeps): TokenStoreState {
  const path = tokenFilePath(deps.storeRoot);
  if (!existsSync(path)) {
    return { status: "absent" };
  }

  const raw = readFileSync(path, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "corrupt", reason: "The stored session file is not valid JSON." };
  }

  if (!isStoredTokens(parsed)) {
    return { status: "corrupt", reason: "The stored session file is missing required fields." };
  }

  return { status: "present", tokens: parsed };
}

/** Removes the token store, if present. Safe to call when nothing was ever written. */
export function clearTokens(deps: TokenStoreDeps): void {
  try {
    unlinkSync(tokenFilePath(deps.storeRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

/** True once the access token is within (or past) the skew window of its real expiry. */
export function isAccessTokenExpired(tokens: StoredTokens, deps: ClockDeps = {}): boolean {
  const now = deps.now ?? Date.now;
  const expiresAt = tokens.obtainedAt + tokens.expiresIn * 1000;
  return now() >= expiresAt - EXPIRY_SKEW_MS;
}
