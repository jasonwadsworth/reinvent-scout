import { AuthRequiredError } from "../core/errors.js";
import { OAuthError, refreshTokens as refreshTokensOnProvider } from "./oauth.js";
import {
  clearTokens,
  isAccessTokenExpired,
  readTokenStore,
  saveTokens,
  type ClockDeps,
  type StoredTokens,
  type TokenStoreDeps,
} from "./token-store.js";

export interface TokenProviderDeps extends TokenStoreDeps, ClockDeps {
  /** Defaults to the global `fetch`. Inject a fake so no test touches the network. */
  fetchFn?: typeof fetch;
  /** Bypasses the "is the stored token still valid" check and forces a genuine refresh, even
   * when the stored token is nowhere near its expiry. Used for the one-shot retry after the
   * server rejects a token the caller believed was still valid (revoked server-side, rotated
   * signing key, clock skew). Still single-flight: a forced caller joins a refresh already in
   * flight for the same store root rather than starting a second one. */
  forceRefresh?: boolean;
}

/**
 * The subset of `TokenProviderDeps` a caller supplies per call, once the provider's fixed
 * dependencies (store root, fetch, clock) are already bound -- see `src/auth/provider-adapter.ts`.
 * The API client imports this type directly for its `getAccessToken` dependency, so if the
 * provider ever changes what a caller can request, every adapter that feeds the client fails to
 * typecheck instead of silently dropping the flag.
 */
export type GetAccessTokenOptions = Pick<TokenProviderDeps, "forceRefresh">;

/**
 * One in-flight refresh promise per store root, shared by every concurrent caller within this
 * process. Cross-process races (two separate CLI invocations refreshing at once) are not
 * coordinated by this map -- both would still hit the token endpoint and both would still end
 * up with a valid token, just with the last write to tokens.json winning, which is an
 * acceptable outcome per the plan's task 9 note.
 */
const inFlightRefreshes = new Map<string, Promise<string>>();

async function performRefresh(
  current: StoredTokens,
  deps: TokenProviderDeps,
): Promise<string> {
  const now = deps.now ?? Date.now;

  let response;
  try {
    response = await refreshTokensOnProvider({
      refreshToken: current.refreshToken,
      ...(deps.fetchFn === undefined ? {} : { fetchFn: deps.fetchFn }),
    });
  } catch (err) {
    if (err instanceof OAuthError && err.code === "invalid_grant") {
      clearTokens(deps);
      throw new AuthRequiredError(
        "Your session was revoked or expired. Run `reinvent-scout auth login` to sign in again.",
      );
    }
    // A transient failure (network error, 5xx, throttling) does not invalidate the stored
    // refresh token -- propagate as-is so the caller can retry later, and leave the store
    // untouched.
    throw err;
  }

  const updated: StoredTokens = {
    accessToken: response.accessToken,
    // This provider's refresh grant omits both on success; the existing ones stay valid and
    // must not be discarded just because this particular response didn't repeat them.
    refreshToken: response.refreshToken ?? current.refreshToken,
    idToken: response.idToken ?? current.idToken,
    tokenType: response.tokenType,
    expiresIn: response.expiresIn,
    obtainedAt: now(),
  };
  saveTokens(updated, deps);
  return updated.accessToken;
}

/**
 * Returns a currently-valid access token, refreshing silently (and persisting the result) if
 * the stored one is within the expiry skew window. Throws `AuthRequiredError` in three cases,
 * each with a message tailored to what the user should understand: no stored session at all
 * ("not signed in"); a stored file that failed to parse or validate (left in place as evidence,
 * message says the session "could not be read"); or a refresh rejected with `invalid_grant`,
 * which does clear the store first so a subsequent call doesn't retry the same dead refresh
 * token.
 */
export async function getAccessToken(deps: TokenProviderDeps): Promise<string> {
  const state = readTokenStore(deps);
  if (state.status === "corrupt") {
    // Deliberately not cleared: the file is evidence of whatever wrote it, and the next
    // `auth login` overwrites it regardless, so deleting it here would only destroy that
    // evidence for no benefit to the user's next action.
    throw new AuthRequiredError(
      "Your stored session could not be read. Run `reinvent-scout auth login` to sign in again.",
    );
  }
  if (state.status === "absent") {
    throw new AuthRequiredError();
  }

  if (!deps.forceRefresh && !isAccessTokenExpired(state.tokens, deps)) {
    return state.tokens.accessToken;
  }

  // Single-flight correctness depends on there being no `await` anywhere between
  // `readTokenStore(deps)` above and the `inFlightRefreshes.set` below. `readTokenStore` is
  // synchronous (a plain `readFileSync`), and nothing else on this path yields to the event
  // loop, so this whole function body runs to this point in one synchronous stretch for each
  // caller -- which is what makes the check-then-set below race-free without a lock: two
  // concurrent callers cannot interleave between one call's `.get` and its `.set`, because
  // nothing here ever hands control back to the scheduler in between. No test exercises this
  // directly (a test that made the store read async would still pass under most interleavings,
  // since the two concurrent calls in the test above usually still land in the same microtask
  // batch), so this comment is the only guard: if `readTokenStore` -- or anything before the
  // `.set` -- ever becomes asynchronous, this map needs a real lock instead, not just the
  // get/set pair below.
  const existing = inFlightRefreshes.get(deps.storeRoot);
  if (existing) {
    return existing;
  }

  const refreshPromise = performRefresh(state.tokens, deps).finally(() => {
    inFlightRefreshes.delete(deps.storeRoot);
  });
  inFlightRefreshes.set(deps.storeRoot, refreshPromise);
  return refreshPromise;
}
