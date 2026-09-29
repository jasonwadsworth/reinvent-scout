import { describe, expect, it } from "vitest";
import { createApiClient } from "../../src/api/client.js";
import {
  AuthRequiredError,
  isRequestNotSent,
  NotFoundError,
  NotRegisteredError,
  OperationUnavailableError,
  ServiceError,
  ThrottledError,
  ValidationError,
} from "../../src/core/errors.js";
import { createFakeFetch, type FakeResponseInit } from "../helpers/fake-fetch.js";

const EVENT_ID = "reinvent2026";
const EMPTY_SCHEDULE_BODY = { schedule: { reserved: [], favorites: [], personalTime: [] } };

interface GetAccessTokenCall {
  forceRefresh?: boolean;
}

function fakeAuth(tokens: string[]): {
  getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string>;
  calls: GetAccessTokenCall[];
} {
  const calls: GetAccessTokenCall[] = [];
  let index = 0;
  return {
    getAccessToken: async (options) => {
      calls.push(options ?? {});
      const token = tokens[Math.min(index, tokens.length - 1)]!;
      index++;
      return token;
    },
    calls,
  };
}

function fakeSleep(): { sleep: (ms: number) => Promise<void>; durations: number[] } {
  const durations: number[] = [];
  return {
    sleep: async (ms: number) => {
      durations.push(ms);
    },
    durations,
  };
}

describe("createApiClient", () => {
  it("reads one fresh session using escaped IDs and unwraps its record", async () => {
    const fake = createFakeFetch([{ status: 200, json: { session: { sessionId: "s/x", title: "Fresh" } } }]);
    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: async () => "token" });
    expect(await client.getSession("e/x", "s/x")).toEqual({ sessionId: "s/x", title: "Fresh" });
    expect(fake.calls[0]!.url).toContain("/v1/events/e%2Fx/sessions/s%2Fx");
    expect(fake.calls[0]!.init?.method).toBe("GET");
  });

  it("sends the bearer token and Accept application/json", async () => {
    const fake = createFakeFetch([{ status: 200, json: EMPTY_SCHEDULE_BODY }]);
    const auth = fakeAuth(["token-abc"]);

    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: auth.getAccessToken });
    await client.getSchedule(EVENT_ID);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toContain(`/v1/events/${EVENT_ID}/schedule`);
    const headers = new Headers(fake.calls[0]!.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer token-abc");
    expect(headers.get("Accept")).toBe("application/json");
  });

  it("fetches the event and returns it unwrapped from the envelope", async () => {
    const fake = createFakeFetch([
      { status: 200, json: { event: { eventId: EVENT_ID, timezone: "America/Los_Angeles" } } },
    ]);
    const auth = fakeAuth(["token-abc"]);

    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: auth.getAccessToken });
    const event = await client.getEvent(EVENT_ID);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toContain(`/v1/events/${EVENT_ID}`);
    expect(fake.calls[0]!.url).not.toContain("/schedule");
    expect(fake.calls[0]!.url).not.toContain("/sessions");
    expect(event).toEqual({ eventId: EVENT_ID, timezone: "America/Los_Angeles" });
  });

  it("returns the event with timezone left genuinely absent when the API response omits it, never synthesizing one", async () => {
    const fake = createFakeFetch([{ status: 200, json: { event: { eventId: EVENT_ID } } }]);
    const auth = fakeAuth(["token-abc"]);

    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: auth.getAccessToken });
    const event = await client.getEvent(EVENT_ID);

    expect(Object.hasOwn(event, "timezone")).toBe(false);
    expect(event.timezone).toBeUndefined();
  });

  it("maps 401 to AuthRequiredError telling the user to run auth login", async () => {
    const fake = createFakeFetch([{ status: 401, json: { message: "Unauthorized" } }]);
    const auth = fakeAuth(["token-1", "token-2"]);
    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: auth.getAccessToken });

    let caught: unknown;
    try {
      await client.getSchedule(EVENT_ID);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AuthRequiredError);
    expect((caught as Error).message).toMatch(/auth login/);
  });

  it("maps 403 to NotRegisteredError stating that signing in again will not help", async () => {
    const fake = createFakeFetch([{ status: 403, json: { message: "Not registered for this event." } }]);
    const auth = fakeAuth(["token-abc"]);
    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: auth.getAccessToken });

    let caught: unknown;
    try {
      await client.getSchedule(EVENT_ID);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NotRegisteredError);
    expect((caught as Error).message).toMatch(/will not help/i);
  });

  it("retries once after forcing a token refresh when a request returns 401 with a token the provider believed valid, then fails", async () => {
    const fake = createFakeFetch([
      { status: 401, json: { message: "Unauthorized" } },
      { status: 401, json: { message: "Unauthorized" } },
    ]);
    const auth = fakeAuth(["stale-token", "fresh-token"]);
    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: auth.getAccessToken });

    await expect(client.getSchedule(EVENT_ID)).rejects.toBeInstanceOf(AuthRequiredError);

    expect(fake.calls).toHaveLength(2);
    expect(new Headers(fake.calls[0]!.init?.headers).get("Authorization")).toBe("Bearer stale-token");
    expect(new Headers(fake.calls[1]!.init?.headers).get("Authorization")).toBe("Bearer fresh-token");
    expect(auth.calls).toEqual([{}, { forceRefresh: true }]);
  });

  it("does not force a second refresh when a fresh 401 is followed by another 401 only once", async () => {
    // A third 401 after the forced refresh must not trigger yet another refresh attempt --
    // exactly one retry, ever, per request.
    const fake = createFakeFetch([
      { status: 401, json: { message: "Unauthorized" } },
      { status: 401, json: { message: "Unauthorized" } },
      { status: 401, json: { message: "Unauthorized" } },
    ]);
    const auth = fakeAuth(["t1", "t2", "t3"]);
    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: auth.getAccessToken });

    await expect(client.getSchedule(EVENT_ID)).rejects.toBeInstanceOf(AuthRequiredError);

    // fake-fetch repeats its last queued response, so a broken implementation that kept
    // retrying forever would hang this test rather than pass it -- the call-count assertion is
    // still the thing actually proving "exactly once".
    expect(fake.calls).toHaveLength(2);
    expect(auth.calls).toHaveLength(2);
  });

  it("waits the Retry-After seconds and retries on 429", async () => {
    const responses: FakeResponseInit[] = [
      { status: 429, headers: { "Retry-After": "2" }, json: { message: "Slow down" } },
      { status: 200, json: EMPTY_SCHEDULE_BODY },
    ];
    const fake = createFakeFetch(responses);
    const auth = fakeAuth(["token-abc"]);
    const sleeper = fakeSleep();
    const client = createApiClient({
      fetchFn: fake.fetch,
      getAccessToken: auth.getAccessToken,
      sleep: sleeper.sleep,
    });

    const schedule = await client.getSchedule(EVENT_ID);

    expect(schedule).toEqual(EMPTY_SCHEDULE_BODY.schedule);
    expect(fake.calls).toHaveLength(2);
    expect(sleeper.durations).toEqual([2000]);
  });

  it("gives up after three 429 responses and throws ThrottledError", async () => {
    const fake = createFakeFetch([
      { status: 429, headers: { "Retry-After": "1" }, json: { message: "Slow down" } },
    ]);
    const auth = fakeAuth(["token-abc"]);
    const sleeper = fakeSleep();
    const client = createApiClient({
      fetchFn: fake.fetch,
      getAccessToken: auth.getAccessToken,
      sleep: sleeper.sleep,
    });

    await expect(client.getSchedule(EVENT_ID)).rejects.toBeInstanceOf(ThrottledError);

    expect(fake.calls).toHaveLength(3);
    expect(sleeper.durations).toHaveLength(2);
  });

  it("falls back to a one-second wait when Retry-After is an HTTP-date rather than seconds", async () => {
    const fake = createFakeFetch([
      { status: 429, headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }, json: { message: "Slow down" } },
      { status: 200, json: EMPTY_SCHEDULE_BODY },
    ]);
    const auth = fakeAuth(["token-abc"]);
    const sleeper = fakeSleep();
    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: auth.getAccessToken, sleep: sleeper.sleep });

    await client.getSchedule(EVENT_ID);

    expect(fake.calls).toHaveLength(2);
    // Number("Wed, ...") is NaN; a naive implementation would sleep NaN ms, i.e. retry immediately.
    expect(sleeper.durations).toEqual([1000]);
  });

  it("falls back to a one-second wait when Retry-After is missing or not a positive number", async () => {
    for (const headers of [{}, { "Retry-After": "" }, { "Retry-After": "-5" }, { "Retry-After": "soon" }]) {
      const fake = createFakeFetch([
        { status: 429, headers, json: { message: "Slow down" } },
        { status: 200, json: EMPTY_SCHEDULE_BODY },
      ]);
      const auth = fakeAuth(["token-abc"]);
      const sleeper = fakeSleep();
      const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: auth.getAccessToken, sleep: sleeper.sleep });

      await client.getSchedule(EVENT_ID);

      expect(sleeper.durations, JSON.stringify(headers)).toEqual([1000]);
    }
  });

  it("caps the Retry-After wait at sixty seconds", async () => {
    const fake = createFakeFetch([
      { status: 429, headers: { "Retry-After": "3600" }, json: { message: "Slow down" } },
      { status: 200, json: EMPTY_SCHEDULE_BODY },
    ]);
    const auth = fakeAuth(["token-abc"]);
    const sleeper = fakeSleep();
    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: auth.getAccessToken, sleep: sleeper.sleep });

    await client.getSchedule(EVENT_ID);

    // The API's quota resets each minute, so no honest Retry-After exceeds 60; anything larger is
    // treated as a bounded wait rather than parking the process for an hour.
    expect(sleeper.durations).toEqual([60_000]);
  });

  it("retries 503 with exponential backoff", async () => {
    const fake = createFakeFetch([
      { status: 503, json: { message: "Unavailable" } },
      { status: 503, json: { message: "Unavailable" } },
      { status: 200, json: EMPTY_SCHEDULE_BODY },
    ]);
    const auth = fakeAuth(["token-abc"]);
    const sleeper = fakeSleep();
    const client = createApiClient({
      fetchFn: fake.fetch,
      getAccessToken: auth.getAccessToken,
      sleep: sleeper.sleep,
    });

    const schedule = await client.getSchedule(EVENT_ID);

    expect(schedule).toEqual(EMPTY_SCHEDULE_BODY.schedule);
    expect(fake.calls).toHaveLength(3);
    expect(sleeper.durations).toHaveLength(2);
    expect(sleeper.durations[1]).toBeGreaterThan(sleeper.durations[0]!);
  });

  it("gives up after exhausting 503 retries and throws ServiceError", async () => {
    const fake = createFakeFetch([{ status: 503, json: { message: "Unavailable" } }]);
    const auth = fakeAuth(["token-abc"]);
    const sleeper = fakeSleep();
    const client = createApiClient({
      fetchFn: fake.fetch,
      getAccessToken: auth.getAccessToken,
      sleep: sleeper.sleep,
    });

    await expect(client.getSchedule(EVENT_ID)).rejects.toBeInstanceOf(ServiceError);
  });

  it("does not retry 400, 404 or 409", async () => {
    const cases: Array<{ status: number; errorClass: new (message: string) => Error }> = [
      { status: 400, errorClass: ValidationError },
      { status: 404, errorClass: NotFoundError },
      { status: 409, errorClass: OperationUnavailableError },
    ];

    for (const { status, errorClass } of cases) {
      const fake = createFakeFetch([{ status, json: { message: `status ${status}` } }]);
      const auth = fakeAuth(["token-abc"]);
      const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: auth.getAccessToken });

      await expect(client.getSchedule(EVENT_ID)).rejects.toBeInstanceOf(errorClass);
      expect(fake.calls).toHaveLength(1);
    }
  });

  it("maps 409 to OperationUnavailableError", async () => {
    const fake = createFakeFetch([{ status: 409, json: { message: "Reservations are not open yet." } }]);
    const auth = fakeAuth(["token-abc"]);
    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: auth.getAccessToken });

    await expect(client.getSchedule(EVENT_ID)).rejects.toBeInstanceOf(OperationUnavailableError);
  });

  it("sends session ids as a JSON body when associating favorites, and returns the BulkResult unchanged", async () => {
    const bulkResult = { successful: ["s1"], failed: [{ sessionId: "s2", code: "alreadyFavorited" }] };
    const fake = createFakeFetch([{ status: 200, json: { result: bulkResult } }]);
    const auth = fakeAuth(["token-abc"]);
    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: auth.getAccessToken });

    const result = await client.associateFavorites(EVENT_ID, ["s1", "s2"]);

    expect(result).toEqual(bulkResult);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toContain(`/v1/events/${EVENT_ID}/favorites`);
    expect(fake.calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(fake.calls[0]!.init?.body as string)).toEqual({ sessionIds: ["s1", "s2"] });
    const headers = new Headers(fake.calls[0]!.init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("resolves disassociateFavorite on a 204 with no body, without attempting to parse one", async () => {
    // fake-fetch's 204 has neither `json` nor `text` set, so `.json()` on it throws exactly like
    // a real empty-bodied 204 would -- proving requestJson doesn't call it for a 204.
    const fake = createFakeFetch([{ status: 204 }]);
    const auth = fakeAuth(["token-abc"]);
    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: auth.getAccessToken });

    await expect(client.disassociateFavorite(EVENT_ID, "s1")).resolves.toBeUndefined();

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toContain(`/v1/events/${EVENT_ID}/favorites/s1`);
    expect(fake.calls[0]!.init?.method).toBe("DELETE");
  });

  it("maps disassociateFavorite's 404 to NotFoundError", async () => {
    const fake = createFakeFetch([{ status: 404, json: { message: "Not favorited." } }]);
    const auth = fakeAuth(["token-abc"]);
    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: auth.getAccessToken });

    await expect(client.disassociateFavorite(EVENT_ID, "s1")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("includes the server message in the error but never the bearer token", async () => {
    const secretToken = "SECRET_BEARER_TOKEN_DO_NOT_LEAK";
    const fake = createFakeFetch([
      { status: 404, json: { message: "No session with that id in this event." } },
    ]);
    const auth = fakeAuth([secretToken]);
    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: auth.getAccessToken });

    let caught: unknown;
    try {
      await client.getSchedule(EVENT_ID);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NotFoundError);
    expect((caught as Error).message).toContain("No session with that id in this event.");
    expect((caught as Error).message).not.toContain(secretToken);
    expect(String(caught)).not.toContain(secretToken);
  });
});

describe("reservation endpoints and write retry safety", () => {
  it("encodes paths, sends unique reservation ids and unwraps BulkResult", async () => {
    const result = { successful: ["a"], failed: [] };
    const fake = createFakeFetch([{ json: { result } }, { status: 204 }]);
    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: async () => "token" });
    expect(await client.reserveSessions("event/a", ["a"])).toEqual(result);
    expect(fake.calls[0]!.url).toContain("/event%2Fa/reservations");
    expect(fake.calls[0]!.init).toMatchObject({ method: "POST", body: '{"sessionIds":["a"]}' });
    await client.cancelReservation("event/a", "session/a");
    expect(fake.calls[1]!.url).toContain("/event%2Fa/reservations/session%2Fa");
    expect(fake.calls[1]!.init!.method).toBe("DELETE");
  });
  it.each([[], ["a", "a"], Array.from({ length: 11 }, (_, i) => String(i))].map(ids => ({ ids })))("rejects invalid reserve request sizes/duplicates before fetch", async ({ ids }) => {
    const fake = createFakeFetch([{ json: {} }]);
    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: async () => "token" });
    await expect(client.reserveSessions(EVENT_ID, ids)).rejects.toThrow(ValidationError);
    expect(fake.calls).toHaveLength(0);
  });
  it.each(["reserveSessions", "associateFavorites"] as const)("%s does not replay ambiguous POST503 or network errors", async method => {
    const fake = createFakeFetch([{ status: 503 }, { json: { result: { successful: ["a"], failed: [] } } }]);
    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: async () => "token", sleep: async () => {} });
    await expect(client[method](EVENT_ID, ["a"])).rejects.toThrow(ServiceError);
    expect(fake.calls).toHaveLength(1);
    let calls = 0;
    const broken = createApiClient({ fetchFn: async () => { calls++; throw new Error("connection lost"); }, getAccessToken: async () => "token" });
    await expect(broken[method](EVENT_ID, ["a"])).rejects.toThrow("connection lost");
    expect(calls).toBe(1);
  });
  it("reserves after one401 refresh and bounded429 retry", async () => {
    const fake = createFakeFetch([{ status: 401 }, { status: 429, headers: { "Retry-After": "2" } }, { json: { result: { successful: ["a"], failed: [] } } }]);
    const auth = fakeAuth(["old", "new"]); const sleep = fakeSleep();
    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: auth.getAccessToken, sleep: sleep.sleep });
    expect((await client.reserveSessions(EVENT_ID, ["a"])).successful).toEqual(["a"]);
    expect(auth.calls).toEqual([{}, { forceRefresh: true }]);
    expect(sleep.durations).toEqual([2000]); expect(fake.calls).toHaveLength(3);
  });
  it.each([[404, NotFoundError], [409, OperationUnavailableError]] as const)("cancel maps %s without repeating", async (status, ErrorClass) => {
    const fake = createFakeFetch([{ status }]);
    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: async () => "token" });
    await expect(client.cancelReservation(EVENT_ID, "a")).rejects.toThrow(ErrorClass);
    expect(fake.calls).toHaveLength(1);
  });
  it("cancel does not blindly retry503", async () => {
    const fake = createFakeFetch([{ status: 503 }, { status: 204 }]);
    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: async () => "token", sleep: async () => {} });
    await expect(client.cancelReservation(EVENT_ID, "a")).rejects.toThrow(ServiceError);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("token failures are marked as never sent", () => {
  it("marks an error thrown by getAccessToken, including on the forced refresh after a 401", async () => {
    const fake = createFakeFetch([{ status: 200, json: EMPTY_SCHEDULE_BODY }]);
    const down = new Error("token endpoint down");
    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: async () => { throw down; } });
    const caught = await client.getSchedule(EVENT_ID).catch((error: unknown) => error);
    expect(caught).toBe(down);
    expect(isRequestNotSent(caught)).toBe(true);
    expect(fake.calls).toHaveLength(0);

    const fake401 = createFakeFetch([{ status: 401, json: {} }]);
    const refreshDown = new Error("refresh down");
    const client401 = createApiClient({ fetchFn: fake401.fetch, getAccessToken: async options => { if (options?.forceRefresh) throw refreshDown; return "token"; } });
    const caught401 = await client401.getSchedule(EVENT_ID).catch((error: unknown) => error);
    expect(isRequestNotSent(caught401)).toBe(true);
  });
  it("does not mark an error the server returned", async () => {
    const fake = createFakeFetch([{ status: 401, json: {} }, { status: 401, json: {} }]);
    const client = createApiClient({ fetchFn: fake.fetch, getAccessToken: async () => "token" });
    const caught = await client.getSchedule(EVENT_ID).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(AuthRequiredError);
    expect(isRequestNotSent(caught)).toBe(false);
  });
});
