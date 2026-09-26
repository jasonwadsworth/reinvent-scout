import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  IDENTITY_PROVIDER,
  OAUTH_CLIENT_ID,
  OAUTH_SCOPE,
  OAuthError,
  refreshTokens,
} from "../../src/auth/oauth.js";
import { createFakeFetch } from "../helpers/fake-fetch.js";

describe("buildAuthorizeUrl", () => {
  it("builds an authorize URL with response_type, client id, redirect uri, scope, identity_provider, challenge, S256 method and state", () => {
    const url = new URL(
      buildAuthorizeUrl({
        redirectUri: "http://localhost:8486/callback",
        codeChallenge: "challenge-value",
        state: "state-value",
      }),
    );

    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(OAUTH_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8486/callback");
    expect(url.searchParams.get("scope")).toBe(OAUTH_SCOPE);
    expect(url.searchParams.get("identity_provider")).toBe(IDENTITY_PROVIDER);
    expect(url.searchParams.get("code_challenge")).toBe("challenge-value");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-value");
  });
});

describe("exchangeCodeForTokens", () => {
  it("exchanges the code with grant_type authorization_code and the matching redirect uri and verifier", async () => {
    const fake = createFakeFetch([
      {
        status: 200,
        json: {
          access_token: "access-abc",
          refresh_token: "refresh-def",
          id_token: "id-ghi",
          token_type: "Bearer",
          expires_in: 3600,
        },
      },
    ]);

    const tokens = await exchangeCodeForTokens({
      code: "auth-code",
      redirectUri: "http://localhost:8486/callback",
      codeVerifier: "verifier-value",
      fetchFn: fake.fetch,
    });

    expect(tokens).toEqual({
      accessToken: "access-abc",
      refreshToken: "refresh-def",
      idToken: "id-ghi",
      tokenType: "Bearer",
      expiresIn: 3600,
    });

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    const body = new URLSearchParams(call.init?.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_id")).toBe(OAUTH_CLIENT_ID);
    expect(body.get("redirect_uri")).toBe("http://localhost:8486/callback");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")).toBe("verifier-value");
  });

  it("surfaces the provider error_description when the token endpoint returns 400", async () => {
    const fake = createFakeFetch([
      {
        status: 400,
        json: { error: "invalid_grant", error_description: "The authorization code is invalid or expired." },
      },
    ]);

    await expect(
      exchangeCodeForTokens({
        code: "auth-code",
        redirectUri: "http://localhost:8486/callback",
        codeVerifier: "verifier-value",
        fetchFn: fake.fetch,
      }),
    ).rejects.toThrow(/authorization code is invalid or expired/i);
  });

  it("surfaces the provider's error code alongside its description", async () => {
    const fake = createFakeFetch([
      {
        status: 400,
        json: { error: "invalid_grant", error_description: "The authorization code is invalid or expired." },
      },
    ]);

    let caught: unknown;
    try {
      await exchangeCodeForTokens({
        code: "auth-code",
        redirectUri: "http://localhost:8486/callback",
        codeVerifier: "verifier-value",
        fetchFn: fake.fetch,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(OAuthError);
    expect((caught as OAuthError).code).toBe("invalid_grant");
  });

  it("surfaces a clear error when the token endpoint returns a non-JSON body", async () => {
    const fake = createFakeFetch([
      {
        status: 502,
        text: "<html>Bad Gateway</html>",
      },
    ]);

    await expect(
      exchangeCodeForTokens({
        code: "auth-code",
        redirectUri: "http://localhost:8486/callback",
        codeVerifier: "verifier-value",
        fetchFn: fake.fetch,
      }),
    ).rejects.toThrow(OAuthError);
  });

  it("treats refresh_token and id_token as optional in the token response", async () => {
    // A refresh_token grant against this provider is expected to omit refresh_token (the
    // existing one stays valid) and may omit id_token too; the parser must not require either.
    const fake = createFakeFetch([
      {
        status: 200,
        json: {
          access_token: "access-abc",
          token_type: "Bearer",
          expires_in: 3600,
        },
      },
    ]);

    const tokens = await exchangeCodeForTokens({
      code: "auth-code",
      redirectUri: "http://localhost:8486/callback",
      codeVerifier: "verifier-value",
      fetchFn: fake.fetch,
    });

    expect(tokens).toEqual({
      accessToken: "access-abc",
      tokenType: "Bearer",
      expiresIn: 3600,
    });
  });

  it("sends Accept: application/json on the token request", async () => {
    const fake = createFakeFetch([
      {
        status: 200,
        json: { access_token: "a", token_type: "Bearer", expires_in: 3600 },
      },
    ]);

    await exchangeCodeForTokens({
      code: "auth-code",
      redirectUri: "http://localhost:8486/callback",
      codeVerifier: "verifier-value",
      fetchFn: fake.fetch,
    });

    const headers = new Headers(fake.calls[0]!.init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
  });

  it("never includes the authorization code or verifier in the string form of its errors", async () => {
    const secretCode = "SECRET_AUTH_CODE_DO_NOT_LEAK";
    const secretVerifier = "SECRET_VERIFIER_DO_NOT_LEAK";
    const fake = createFakeFetch([{ status: 502, text: "<html>Bad Gateway</html>" }]);

    try {
      await exchangeCodeForTokens({
        code: secretCode,
        redirectUri: "http://localhost:8486/callback",
        codeVerifier: secretVerifier,
        fetchFn: fake.fetch,
      });
      expect.unreachable("expected exchangeCodeForTokens to throw");
    } catch (err) {
      expect(String(err)).not.toContain(secretCode);
      expect(String(err)).not.toContain(secretVerifier);
    }
  });
});

describe("refreshTokens", () => {
  it("sends grant_type refresh_token with the client id and refresh token", async () => {
    const fake = createFakeFetch([
      { status: 200, json: { access_token: "new-access", token_type: "Bearer", expires_in: 3600 } },
    ]);

    const tokens = await refreshTokens({ refreshToken: "refresh-def", fetchFn: fake.fetch });

    expect(tokens).toEqual({ accessToken: "new-access", tokenType: "Bearer", expiresIn: 3600 });
    expect(fake.calls).toHaveLength(1);
    const body = new URLSearchParams(fake.calls[0]!.init?.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe(OAUTH_CLIENT_ID);
    expect(body.get("refresh_token")).toBe("refresh-def");
    // A refresh request has no authorization code or PKCE verifier at all -- confirm none leaks
    // in should never apply here, but also confirm the request body doesn't carry a `code` key
    // left over from copy-pasting the authorization_code grant.
    expect(body.has("code")).toBe(false);
    expect(body.has("code_verifier")).toBe(false);
  });

  it("surfaces invalid_grant when the refresh token was revoked or expired", async () => {
    const fake = createFakeFetch([
      {
        status: 400,
        json: { error: "invalid_grant", error_description: "Refresh Token has been revoked" },
      },
    ]);

    let caught: unknown;
    try {
      await refreshTokens({ refreshToken: "refresh-def", fetchFn: fake.fetch });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(OAuthError);
    expect((caught as OAuthError).code).toBe("invalid_grant");
  });
});
