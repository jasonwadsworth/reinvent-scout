/**
 * Endpoints and client id for the AWS Events OAuth provider. The client id is a public OAuth
 * client identifier (there is no client secret in a PKCE flow) and belongs in source, not
 * configuration.
 */
export const OAUTH_CLIENT_ID = "7vmom55m1qstvq8i71ph127bfq";
export const AUTHORIZE_URL = "https://oauth.awsevents.com/oauth2/authorize";
export const TOKEN_URL = "https://oauth.awsevents.com/oauth2/token";
export const OAUTH_SCOPE = "openid email events/access";
export const IDENTITY_PROVIDER = "AWSBuilderID";

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

export interface BuildAuthorizeUrlOptions {
  redirectUri: string;
  codeChallenge: string;
  state: string;
}

/** Builds the `/authorize` URL for a PKCE authorization-code request. */
export function buildAuthorizeUrl(options: BuildAuthorizeUrlOptions): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", OAUTH_SCOPE);
  url.searchParams.set("identity_provider", IDENTITY_PROVIDER);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", options.state);
  return url.toString();
}

export interface TokenResponse {
  accessToken: string;
  /** Absent on a refresh_token grant response: the existing refresh token stays valid. */
  refreshToken?: string;
  /** Present on an authorization_code grant; a refresh response may omit it too. */
  idToken?: string;
  tokenType: string;
  expiresIn: number;
}

export interface ExchangeCodeOptions {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  /** Defaults to the global `fetch`. Inject a fake so no test touches the network. */
  fetchFn?: typeof fetch;
}

function extractErrorDescription(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.error_description === "string") {
    return p.error_description;
  }
  if (typeof p.error === "string") {
    return p.error;
  }
  return undefined;
}

function parseTokenResponse(payload: unknown): TokenResponse {
  if (typeof payload !== "object" || payload === null) {
    throw new OAuthError("The token endpoint returned an unexpected response.");
  }
  const p = payload as Record<string, unknown>;
  // refresh_token and id_token are deliberately not required here: a refresh_token grant
  // against this provider omits refresh_token (the existing one stays valid) and may omit
  // id_token too. Only the fields every grant type actually returns are required.
  if (
    typeof p.access_token !== "string" ||
    typeof p.token_type !== "string" ||
    typeof p.expires_in !== "number"
  ) {
    throw new OAuthError("The token endpoint returned an unexpected response.");
  }

  const tokens: TokenResponse = {
    accessToken: p.access_token,
    tokenType: p.token_type,
    expiresIn: p.expires_in,
  };
  if (typeof p.refresh_token === "string") {
    tokens.refreshToken = p.refresh_token;
  }
  if (typeof p.id_token === "string") {
    tokens.idToken = p.id_token;
  }
  return tokens;
}

async function postToken(body: URLSearchParams, fetchFn: typeof fetch): Promise<TokenResponse> {
  const response = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new OAuthError(
      `The token endpoint returned a response that was not valid JSON (status ${response.status}).`,
    );
  }

  if (!response.ok) {
    const description = extractErrorDescription(payload);
    throw new OAuthError(description ?? `The token endpoint returned status ${response.status}.`);
  }

  return parseTokenResponse(payload);
}

/** Exchanges an authorization code for tokens, per RFC 7636. */
export async function exchangeCodeForTokens(options: ExchangeCodeOptions): Promise<TokenResponse> {
  const fetchFn = options.fetchFn ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: options.redirectUri,
    code: options.code,
    code_verifier: options.codeVerifier,
  });
  return postToken(body, fetchFn);
}
