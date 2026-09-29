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
import type { BulkResult, Event, ListSessionsResponseContent, Schedule, Session } from "./types.js";

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
  reserveSessions(eventId: string, sessionIds: string[]): Promise<BulkResult>;
  cancelReservation(eventId: string, sessionId: string): Promise<void>;
  /** Fetches the event itself (name, dates, timezone, ...), not its sessions. The endpoint does
   * not require attendee sign-in per its OpenAPI description, unlike `getSchedule`, but this
   * client sends the bearer token unconditionally like every other call -- `catalog sync`, the
   * only caller today, already requires a signed-in session for `listAllSessions`, so there is no
   * scenario where this call runs without one anyway. */
  getEvent(eventId: string): Promise<Event>;
  /** Fetches a single page of the event's session catalog. */
  listSessions(eventId: string, options?: ListSessionsOptions): Promise<ListSessionsResponseContent>;
  /** Walks every page of the event's session catalog and returns the full list. */
  listAllSessions(eventId: string, options?: ListAllSessionsOptions): Promise<ListAllSessionsResult>;
  /** Marks up to ten sessions as favorites in one request (the API's own per-request cap). A 200
   * does not mean every session succeeded -- always check `BulkResult.failed`. */
  associateFavorites(eventId: string, sessionIds: string[]): Promise<BulkResult>;
  /** Removes one session from favorites. Resolves on the API's 204; rejects with `NotFoundError`
   * when the session was not favorited (the API reports that as a 404, indistinguishable here from
   * the session not existing at all). */
  disassociateFavorite(eventId: string, sessionId: string): Promise<void>;
}

export interface ListAllSessionsResult {
  sessions: Session[];
  /** The `totalCount` the API reported for the whole catalog (from the last page received),
   * for the caller to compare against `sessions.length` and warn on a mismatch. */
  totalCount: number;
}

interface GetScheduleResponseContent {
  schedule: Schedule;
}

interface GetEventResponseContent {
  event: Event;
}

interface AssociateFavoritesResponseContent {
  result: BulkResult;
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
  body?: unknown,
  retry503 = method === "GET",
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
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (response.status === 401 && !usedForcedRefresh) {
      usedForcedRefresh = true;
      token = await deps.getAccessToken({ forceRefresh: true });
      continue;
    }

    if (response.status === 429) {
      attempts429++;
      if (attempts429 < MAX_ATTEMPTS_429) {
        await sleep(parseRetryAfterSeconds(response.headers.get("Retry-After")) * 1000);
        continue;
      }
    }

    if (response.status === 503 && retry503) {
      attempts503++;
      if (attempts503 < MAX_ATTEMPTS_503) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempts503 - 1));
        continue;
      }
    }

    if (response.ok) {
      // A 204 has no body at all -- calling `.json()` on it would throw trying to parse an empty
      // string, exactly like a real empty-bodied response does. `T` is `undefined` at every 204
      // call site in this client, so this is a real, typed "no content" outcome, not a cast
      // papering over a missing value.
      if (response.status === 204) {
        return undefined as T;
      }
      return (await response.json()) as T;
    }

    throw await mapErrorResponse(response);
  }
}

/** Seconds to wait after a 429, from the `Retry-After` header. The API sends the seconds left in
 * the current quota minute, so an honest value is 1..60. Anything else -- the header missing, the
 * HTTP-date form (`Number()` of which is NaN, i.e. an immediate retry), a non-positive or
 * non-numeric value -- falls back to one second, and larger values are capped at sixty so a
 * misbehaving server cannot park the process for an hour. */
function parseRetryAfterSeconds(header: string | null): number {
  const seconds = Number(header);
  if (header === null || header.trim() === "" || !Number.isFinite(seconds) || seconds <= 0) {
    return DEFAULT_RETRY_AFTER_SECONDS;
  }
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

const DEFAULT_RETRY_AFTER_SECONDS = 1;
const MAX_RETRY_AFTER_SECONDS = 60;

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
    async reserveSessions(eventId: string, sessionIds: string[]): Promise<BulkResult> {
      if (sessionIds.length < 1 || sessionIds.length > 10 || new Set(sessionIds).size !== sessionIds.length) {
        throw new ValidationError("Reservations require 1–10 unique session IDs per request.");
      }
      const body = await requestJson<AssociateFavoritesResponseContent>(
        "POST", `/v1/events/${encodeURIComponent(eventId)}/reservations`, deps, { sessionIds },
      );
      return body.result;
    },
    async cancelReservation(eventId: string, sessionId: string): Promise<void> {
      await requestJson<undefined>("DELETE", `/v1/events/${encodeURIComponent(eventId)}/reservations/${encodeURIComponent(sessionId)}`, deps);
    },
    async getSchedule(eventId: string): Promise<Schedule> {
      const body = await requestJson<GetScheduleResponseContent>(
        "GET",
        `/v1/events/${encodeURIComponent(eventId)}/schedule`,
        deps,
      );
      return body.schedule;
    },

    async getEvent(eventId: string): Promise<Event> {
      const body = await requestJson<GetEventResponseContent>(
        "GET",
        `/v1/events/${encodeURIComponent(eventId)}`,
        deps,
      );
      return body.event;
    },

    listSessions,

    async associateFavorites(eventId: string, sessionIds: string[]): Promise<BulkResult> {
      const body = await requestJson<AssociateFavoritesResponseContent>(
        "POST",
        `/v1/events/${encodeURIComponent(eventId)}/favorites`,
        deps,
        { sessionIds },
      );
      return body.result;
    },

    async disassociateFavorite(eventId: string, sessionId: string): Promise<void> {
      await requestJson<undefined>(
        "DELETE",
        `/v1/events/${encodeURIComponent(eventId)}/favorites/${encodeURIComponent(sessionId)}`,
        deps, undefined, true,
      );
    },

    async listAllSessions(
      eventId: string,
      options: ListAllSessionsOptions = {},
    ): Promise<ListAllSessionsResult> {
      const sessions: Session[] = [];
      const seenTokens = new Set<string>();
      let nextToken: string | undefined;
      let pageCount = 0;
      // Every page is expected to report the same totalCount (the size of the whole catalog, not
      // the page); the last page received is as good a source for it as any, and this way
      // there's always a value even if the very first page is also the last. If pages ever
      // disagreed, the last one deliberately wins rather than the first or the max -- consistent
      // with trusting the server's own success response (see mapErrorResponse's doc comment) --
      // and if the response omits totalCount entirely, `page.totalCount` is `undefined` here
      // despite the type declaring it required, since success responses are deliberately not
      // runtime-validated. That is caught and handled by this call's caller, not here: see
      // catalog/sync.ts, which is where a missing or non-finite totalCount actually gets acted on.
      let totalCount = 0;

      for (;;) {
        const page = await listSessions(eventId, {
          ...(options.includeAbstracts === undefined ? {} : { includeAbstracts: options.includeAbstracts }),
          ...(nextToken === undefined ? {} : { nextToken }),
        });
        pageCount++;
        sessions.push(...page.items);
        totalCount = page.totalCount;

        if (page.nextToken === undefined) {
          return { sessions, totalCount };
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
