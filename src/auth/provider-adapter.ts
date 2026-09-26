import { getAccessToken, type GetAccessTokenOptions, type TokenProviderDeps } from "./token-provider.js";

export type { GetAccessTokenOptions };

/**
 * Binds a token provider's fixed dependencies (store root, fetch, clock) into the shape the API
 * client expects: a function taking only the per-call options. This is the one place production
 * code -- and the cross-module integration test -- wires the real provider to the real client, so
 * there is exactly one implementation to keep in sync with `GetAccessTokenOptions`.
 */
export function createTokenProviderAdapter(
  deps: TokenProviderDeps,
): (options?: GetAccessTokenOptions) => Promise<string> {
  return (options) => getAccessToken({ ...deps, ...options });
}
