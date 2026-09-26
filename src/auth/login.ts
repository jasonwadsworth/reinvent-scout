import { launchBrowser as defaultLaunchBrowser } from "./browser.js";
import { startCallbackServer, type StartCallbackServerOptions } from "./callback-server.js";
import { buildAuthorizeUrl, exchangeCodeForTokens, OAuthError } from "./oauth.js";
import { deriveCodeChallenge, generateCodeVerifier, generateState, type PkceDeps } from "./pkce.js";
import { saveTokens, type TokenStoreDeps } from "./token-store.js";

export interface LoginDeps extends TokenStoreDeps {
  /** Injected PKCE randomness source. Defaults to `node:crypto`. */
  pkce?: PkceDeps;
  /** Forwarded to `exchangeCodeForTokens`. Defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  /**
   * Opens the authorize URL in a browser. Defaults to `src/auth/browser.ts`'s `launchBrowser`.
   * A failure here (the launcher throws, or simply never opens anything) is never fatal: the
   * URL is always printed first as a fallback the user can open by hand.
   */
  launchBrowser?: (url: string) => void;
  /** Where the authorize URL (and its printed fallback) goes. Defaults to stdout. */
  print?: (message: string) => void;
  /** Stamped as `obtainedAt`. Defaults to `Date.now`. */
  now?: () => number;
  /** Forwarded to `startCallbackServer` alongside the generated `expectedState`. */
  callbackServerOptions?: Omit<StartCallbackServerOptions, "expectedState">;
}

/**
 * Runs one full PKCE authorization-code login: generates the PKCE verifier/challenge and an
 * anti-CSRF state, starts the one-shot local callback server, prints (and best-effort opens)
 * the authorize URL, waits for the callback, exchanges the code for tokens, and persists them.
 *
 * Rejects -- without ever calling `saveTokens` -- if the callback carries a provider error, the
 * state doesn't match, the wait times out, or the token exchange fails. The callback server
 * closes itself as part of settling in every one of those cases; `handle.close()` is called
 * again here only as a defensive no-op for any future failure path added between the callback
 * settling and the token exchange completing.
 */
export async function login(deps: LoginDeps): Promise<void> {
  const print = deps.print ?? ((message: string) => process.stdout.write(`${message}\n`));
  const now = deps.now ?? Date.now;
  const launch = deps.launchBrowser ?? defaultLaunchBrowser;

  const verifier = generateCodeVerifier(deps.pkce);
  const challenge = deriveCodeChallenge(verifier);
  const state = generateState(deps.pkce);

  const handle = await startCallbackServer({
    ...deps.callbackServerOptions,
    expectedState: state,
  });

  try {
    const redirectUri = `http://localhost:${handle.port}/callback`;
    const authorizeUrl = buildAuthorizeUrl({ redirectUri, codeChallenge: challenge, state });

    print(`Open this URL to sign in with AWS Builder ID:\n${authorizeUrl}`);

    try {
      launch(authorizeUrl);
    } catch {
      // Non-fatal: the URL above is the fallback the user can open by hand.
    }

    const { code } = await handle.result;

    const tokens = await exchangeCodeForTokens({
      code,
      redirectUri,
      codeVerifier: verifier,
      ...(deps.fetchFn === undefined ? {} : { fetchFn: deps.fetchFn }),
    });

    if (tokens.refreshToken === undefined || tokens.idToken === undefined) {
      throw new OAuthError(
        "The token endpoint's response to the sign-in request was missing a refresh token or ID token.",
      );
    }

    saveTokens(
      {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        idToken: tokens.idToken,
        tokenType: tokens.tokenType,
        expiresIn: tokens.expiresIn,
        obtainedAt: now(),
      },
      { storeRoot: deps.storeRoot },
    );
  } catch (err) {
    handle.close();
    throw err;
  }
}
