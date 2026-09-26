import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApiClient } from "../../src/api/client.js";
import { ServiceError } from "../../src/core/errors.js";
import type { Session } from "../../src/api/types.js";
import { createFakeFetch, type FakeResponseInit } from "../helpers/fake-fetch.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture: Session[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"),
);

const EVENT_ID = "reinvent2026";

function fakeAuth(): { getAccessToken: () => Promise<string> } {
  return { getAccessToken: async () => "token-abc" };
}

/** Slices `sessions` into pages of `pageSize`, in the ListSessions response shape. */
function paginate(sessions: Session[], pageSize: number): FakeResponseInit[] {
  const pages: FakeResponseInit[] = [];
  for (let i = 0; i < sessions.length; i += pageSize) {
    const items = sessions.slice(i, i + pageSize);
    const isLastPage = i + pageSize >= sessions.length;
    pages.push({
      status: 200,
      json: {
        items,
        totalCount: sessions.length,
        ...(isLastPage ? {} : { nextToken: `token-${i / pageSize + 1}` }),
      },
    });
  }
  return pages;
}

describe("listAllSessions", () => {
  it("returns every session across all pages", async () => {
    const pages = paginate(fixture, 25);
    const fake = createFakeFetch(pages);
    const client = createApiClient({ fetchFn: fake.fetch, ...fakeAuth() });

    const sessions = await client.listAllSessions(EVENT_ID);

    expect(sessions.map((s) => s.sessionId).sort()).toEqual(
      fixture.map((s) => s.sessionId).sort(),
    );
    // 60 sessions / 25 per page = 3 pages.
    expect(fake.calls).toHaveLength(3);
  });

  it("stops only when nextToken is absent, not when a page is short", async () => {
    const fake = createFakeFetch([
      { status: 200, json: { items: fixture.slice(0, 25), totalCount: fixture.length, nextToken: "t1" } },
      // A short (here, empty) middle page that still carries a token must not be mistaken for
      // the last page.
      { status: 200, json: { items: [], totalCount: fixture.length, nextToken: "t2" } },
      { status: 200, json: { items: fixture.slice(25), totalCount: fixture.length } },
    ]);
    const client = createApiClient({ fetchFn: fake.fetch, ...fakeAuth() });

    const sessions = await client.listAllSessions(EVENT_ID);

    expect(sessions.map((s) => s.sessionId).sort()).toEqual(
      fixture.map((s) => s.sessionId).sort(),
    );
    expect(fake.calls).toHaveLength(3);
  });

  it("passes includeAbstracts through to every page request", async () => {
    const pages = paginate(fixture, 25);
    const fake = createFakeFetch(pages);
    const client = createApiClient({ fetchFn: fake.fetch, ...fakeAuth() });

    await client.listAllSessions(EVENT_ID, { includeAbstracts: false });

    expect(fake.calls.length).toBeGreaterThan(1);
    for (const call of fake.calls) {
      expect(new URL(call.url).searchParams.get("includeAbstracts")).toBe("false");
    }
  });

  it("throws rather than looping forever when the server returns the same nextToken twice", async () => {
    const fake = createFakeFetch([
      { status: 200, json: { items: [], totalCount: 0, nextToken: "dup" } },
      { status: 200, json: { items: [], totalCount: 0, nextToken: "dup" } },
    ]);
    const client = createApiClient({ fetchFn: fake.fetch, ...fakeAuth() });

    // A bare Error here would be indistinguishable from a programmer error at the call site;
    // ServiceError says plainly that the server is the one that misbehaved, matching every other
    // "the server did something it should not have" outcome this client maps. Both assertions
    // check the same rejection (a promise can be awaited more than once) rather than triggering
    // the guard twice, since a second call would consume more of the fake's queue.
    const rejection = client.listAllSessions(EVENT_ID);
    await expect(rejection).rejects.toThrow(/nextToken/i);
    await expect(rejection).rejects.toBeInstanceOf(ServiceError);
    expect(fake.calls).toHaveLength(2);
  });

  it("throws when the page cap of 50 is exceeded", async () => {
    // Each call must return a *distinct* nextToken -- fake-fetch's queue repeats its last
    // response verbatim, which would trip the duplicate-nextToken guard above long before 50
    // pages, and mask this test entirely. So this uses a purpose-built fetch instead.
    let callCount = 0;
    const fetchFn = (async (): Promise<Response> => {
      callCount++;
      const body = { items: [], totalCount: 0, nextToken: `token-${callCount}` };
      return {
        status: 200,
        ok: true,
        headers: new Headers(),
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const client = createApiClient({ fetchFn, ...fakeAuth() });

    const rejection = client.listAllSessions(EVENT_ID);
    await expect(rejection).rejects.toThrow(/page/i);
    // Same reasoning as the duplicate-nextToken guard above: this is the server failing to
    // terminate pagination, not a caller mistake, so it belongs in the same taxonomy as every
    // other "the server did something it should not have" outcome.
    await expect(rejection).rejects.toBeInstanceOf(ServiceError);
    // The cap must stop it at exactly 50 fetches -- never a 51st page.
    expect(callCount).toBe(50);
  });

  it("returns an empty list when the first page is empty and carries no token", async () => {
    const fake = createFakeFetch([{ status: 200, json: { items: [], totalCount: 0 } }]);
    const client = createApiClient({ fetchFn: fake.fetch, ...fakeAuth() });

    const sessions = await client.listAllSessions(EVENT_ID);

    expect(sessions).toEqual([]);
    expect(fake.calls).toHaveLength(1);
  });
});
