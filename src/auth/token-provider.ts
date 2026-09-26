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
 * the stored one is within the expiry skew window. Throws `AuthRequiredError` when there is no
 * stored session, the store is corrupt, or the refresh was rejected with `invalid_grant` -- in
 * the last case, the store is cleared first so a subsequent call doesn't retry the same dead
 * refresh token.
 */
export async function getAccessToken(deps: TokenProviderDeps): Promise<string> {
  const state = readTokenStore(deps);
  if (state.status !== "present") {
    throw new AuthRequiredError();
  }

  if (!deps.forceRefresh && !isAccessTokenExpired(state.tokens, deps)) {
    return state.tokens.accessToken;
  }

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
