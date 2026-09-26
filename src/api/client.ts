import {
  AuthRequiredError,
  NotFoundError,
  NotRegisteredError,
  OperationUnavailableError,
  ServiceError,
  ThrottledError,
  ValidationError,
} from "../core/errors.js";
import type { Schedule } from "./types.js";

const DEFAULT_BASE_URL = "https://api.awsevents.com";

/** A response is retried at most this many times before giving up on a 429. */
const MAX_ATTEMPTS_429 = 3;
/** A response is retried at most this many times before giving up on a 503. */
const MAX_ATTEMPTS_503 = 3;
const BASE_BACKOFF_MS = 250;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GetAccessTokenOptions {
  /** Bypass any cached "still valid" check and get a genuinely fresh token. Used for the
   * one-shot retry after a server rejects a token the caller believed was still valid. */
  forceRefresh?: boolean;
}

export interface ApiClientDeps {
  /** Defaults to the global `fetch`. Inject a fake so no test touches the network. */
  fetchFn?: typeof fetch;
  /** Defaults to a real timer-based sleep. Inject a fake so tests never actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Defaults to `https://api.awsevents.com`. */
  baseUrl?: string;
  getAccessToken: (options?: GetAccessTokenOptions) => Promise<string>;
}

export interface ApiClient {
  getSchedule(eventId: string): Promise<Schedule>;
}

interface GetScheduleResponseContent {
  schedule: Schedule;
}

async function extractMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      const message = (body as Record<string, unknown>).message;
      if (typeof message === "string") {
        return message;
      }
    }
  } catch {
    // Fall through to the generic message below -- the body wasn't JSON, or wasn't shaped like
    // the API's documented error responses.
  }
  return `The server returned status ${response.status}.`;
}

/**
 * Maps a non-2xx response to the error taxonomy. The response body's `message` is trusted and
 * included verbatim (these error responses never echo request content back, so there is
 * nothing of the caller's to leak) -- this is deliberately not runtime-validated against the
 * OpenAPI schema the way a user-editable file would be: it's AWS's own documented API over TLS,
 * not attacker-controlled input.
 */
async function mapErrorResponse(response: Response): Promise<Error> {
  const message = await extractMessage(response);
  switch (response.status) {
    case 400:
      return new ValidationError(message);
    case 401:
      return new AuthRequiredError();
    case 403:
      return new NotRegisteredError();
    case 404:
      return new NotFoundError(message);
    case 409:
      return new OperationUnavailableError(message);
    case 429:
      return new ThrottledError();
    default:
      return new ServiceError(message);
  }
}

async function requestJson<T>(
  method: string,
  path: string,
  deps: ApiClientDeps,
): Promise<T> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;

  let token = await deps.getAccessToken();
  let usedForcedRefresh = false;
  let attempts429 = 0;
  let attempts503 = 0;

  for (;;) {
    const response = await fetchFn(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (response.status === 401 && !usedForcedRefresh) {
      usedForcedRefresh = true;
      token = await deps.getAccessToken({ forceRefresh: true });
      continue;
    }

    if (response.status === 429) {
      attempts429++;
      if (attempts429 < MAX_ATTEMPTS_429) {
        const retryAfterSeconds = Number(response.headers.get("Retry-After") ?? "1");
        await sleep(retryAfterSeconds * 1000);
        continue;
      }
    }

    if (response.status === 503) {
      attempts503++;
      if (attempts503 < MAX_ATTEMPTS_503) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempts503 - 1));
        continue;
      }
    }

    if (response.ok) {
      return (await response.json()) as T;
    }

    throw await mapErrorResponse(response);
  }
}

export function createApiClient(deps: ApiClientDeps): ApiClient {
  return {
    async getSchedule(eventId: string): Promise<Schedule> {
      const body = await requestJson<GetScheduleResponseContent>(
        "GET",
        `/v1/events/${encodeURIComponent(eventId)}/schedule`,
        deps,
      );
      return body.schedule;
    },
  };
}
