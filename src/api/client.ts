import type { GetAccessTokenOptions } from "../auth/token-provider.js";
import {
  AuthRequiredError,
  NotFoundError,
  NotRegisteredError,
  OperationUnavailableError,
  ServiceError,
  ThrottledError,
  ValidationError,
} from "../core/errors.js";
import type { ListSessionsResponseContent, Schedule, Session } from "./types.js";

export type { GetAccessTokenOptions };

const DEFAULT_BASE_URL = "https://api.awsevents.com";

/** A response is retried at most this many times before giving up on a 429. */
const MAX_ATTEMPTS_429 = 3;
/** A response is retried at most this many times before giving up on a 503. */
const MAX_ATTEMPTS_503 = 3;
const BASE_BACKOFF_MS = 250;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export interface ListSessionsOptions {
  /** Omit each session's `abstract` when `false`. Server defaults to `true` when omitted. */
  includeAbstracts?: boolean;
  /** The `nextToken` from a previous page's response. */
  nextToken?: string;
}

export interface ListAllSessionsOptions {
  includeAbstracts?: boolean;
}

export interface ApiClient {
  getSchedule(eventId: string): Promise<Schedule>;
  /** Fetches a single page of the event's session catalog. */
  listSessions(eventId: string, options?: ListSessionsOptions): Promise<ListSessionsResponseContent>;
  /** Walks every page of the event's session catalog and returns the full list. */
  listAllSessions(eventId: string, options?: ListAllSessionsOptions): Promise<Session[]>;
}

interface GetScheduleResponseContent {
  schedule: Schedule;
}

/** Safety cap on ListSessions pagination: real catalogs run to a handful of pages (2,043
 * sessions across 9 pages of 250 in the 2026 pull), so this is a generous ceiling against a
 * server bug that never sets `nextToken` to absent, not a limit expected to be reached. */
const MAX_LIST_SESSIONS_PAGES = 50;

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
  async function listSessions(
    eventId: string,
    options: ListSessionsOptions = {},
  ): Promise<ListSessionsResponseContent> {
    const params = new URLSearchParams();
    if (options.includeAbstracts !== undefined) {
      params.set("includeAbstracts", String(options.includeAbstracts));
    }
    if (options.nextToken !== undefined) {
      params.set("nextToken", options.nextToken);
    }
    const query = params.toString();
    const path = `/v1/events/${encodeURIComponent(eventId)}/sessions${query ? `?${query}` : ""}`;
    return requestJson<ListSessionsResponseContent>("GET", path, deps);
  }

  return {
    async getSchedule(eventId: string): Promise<Schedule> {
      const body = await requestJson<GetScheduleResponseContent>(
        "GET",
        `/v1/events/${encodeURIComponent(eventId)}/schedule`,
        deps,
      );
      return body.schedule;
    },

    listSessions,

    async listAllSessions(
      eventId: string,
      options: ListAllSessionsOptions = {},
    ): Promise<Session[]> {
      const sessions: Session[] = [];
      const seenTokens = new Set<string>();
      let nextToken: string | undefined;
      let pageCount = 0;

      for (;;) {
        const page = await listSessions(eventId, {
          ...(options.includeAbstracts === undefined ? {} : { includeAbstracts: options.includeAbstracts }),
          ...(nextToken === undefined ? {} : { nextToken }),
        });
        pageCount++;
        sessions.push(...page.items);

        if (page.nextToken === undefined) {
          return sessions;
        }
        if (seenTokens.has(page.nextToken)) {
          // Both guards below are the server failing to behave, not a caller mistake -- an
          // infinite loop or an unbounded page count is exactly the "the server did something it
          // should not have" shape every other mapped failure in this client uses ServiceError
          // for, so a bare Error here would be the one inconsistent exception in the taxonomy.
          throw new ServiceError(
            "ListSessions returned the same nextToken twice in a row; refusing to loop forever.",
          );
        }
        if (pageCount >= MAX_LIST_SESSIONS_PAGES) {
          throw new ServiceError(
            `ListSessions did not terminate within the ${MAX_LIST_SESSIONS_PAGES}-page safety cap.`,
          );
        }
        seenTokens.add(page.nextToken);
        nextToken = page.nextToken;
      }
    },
  };
}
