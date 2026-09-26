import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../core/atomic-write.js";
import { ensureDirWithMode, STORE_DIR_MODE } from "../core/paths.js";

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

/**
 * Persists the tokens atomically at mode 0600, creating the store root (and any missing
 * parent directories) at 0700 if needed -- via the same hardened, umask-independent directory
 * creation `ensureStoreRoot` uses, rather than a bare `mkdirSync` that would leave the
 * directory at whatever mode-minus-umask the OS default gives it.
 */
export function saveTokens(tokens: StoredTokens, deps: TokenStoreDeps): void {
  ensureDirWithMode(deps.storeRoot, STORE_DIR_MODE);
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
    // `typeof === "number"` alone accepts NaN and +/-Infinity -- both valid JS numbers, and
    // Infinity is even reachable from JSON.parse (`1e400` is valid JSON syntax that overflows to
    // it) -- neither of which can ever produce a sane expiry calculation.
    typeof v.expiresIn === "number" &&
    Number.isFinite(v.expiresIn) &&
    typeof v.obtainedAt === "number" &&
    Number.isFinite(v.obtainedAt)
  );
}

/**
 * Reads the token store. Never throws: a missing file is "absent", and anything else that
 * keeps this from producing a valid session -- invalid JSON, a malformed or non-finite-timestamp
 * shape, the path being a directory instead of a file, a permissions error, or any other read
 * failure -- is "corrupt" with a fixed, generic reason string, never the raw file content or a
 * native error's message, either of which could echo real token material back out in an error.
 *
 * Deliberately reads the file directly rather than checking `existsSync` first: that check-then-
 * read pattern has a race (the file can vanish or change between the check and the read) and,
 * more importantly, does nothing for a path that exists but isn't a readable file -- a directory
 * left at `tokens.json`'s path throws `EISDIR` on read regardless of whether it "exists".
 */
export function readTokenStore(deps: TokenStoreDeps): TokenStoreState {
  const path = tokenFilePath(deps.storeRoot);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "absent" };
    }
    return { status: "corrupt", reason: "The stored session file could not be read." };
  }

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
