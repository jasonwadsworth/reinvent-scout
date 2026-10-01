import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { listFilters } from "../../src/catalog/filters.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { CatalogMissingError, ValidationError } from "../../src/core/errors.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const s = (code: string, extra: Partial<Session> = {}): Session =>
  ({ sessionId: code, abbreviation: code, title: code, level: "300 - Advanced", type: "Breakout session", ...extra });
const on = (date: string) => ({ sessionTime: { date, time: "10:00", length: "60" } });
const CATALOG: Session[] = [
  s("A1", { venue: "MGM Grand", ...on("2026-12-01"), topics: ["Serverless", "Databases"], roles: ["Developer"] }),
  // A repeat of A1 on another day at another venue: the talk counts once per value.
  s("A1-R", { venue: "Venetian", ...on("2026-12-02"), topics: ["Serverless", "Databases"], roles: ["Developer"] }),
  s("B1", { venue: "MGM Grand", ...on("2026-12-01"), type: "Chalk talk", level: "400 - Expert", topics: ["Serverless"], industries: ["Retail"] }),
  s("C1", { venue: "Wynn/Encore", ...on("2026-12-03"), type: "Chalk talk", level: "100 - Foundational", areasOfInterest: ["Security"] }),
  s("D1", { type: "Workshop" }),
];

describe("listFilters", () => {
  let home: TempHome;
  beforeEach(() => {
    home = createTempHome();
    writeCatalog({ raw: CATALOG, index: CATALOG.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: CATALOG.length, count: CATALOG.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
  });
  afterEach(() => { home.cleanup(); });
  const deps = () => ({ storeRoot: home.path });

  it("lists each field's values with the number of distinct talks, most first", () => {
    const { fields } = listFilters(deps());
    expect(fields.venue!.values).toEqual([{ value: "MGM Grand", count: 2 }, { value: "Venetian", count: 1 }, { value: "Wynn/Encore", count: 1 }]);
    expect(fields.format!.values).toEqual([{ value: "Breakout session", count: 1 }, { value: "Chalk talk", count: 2 }, { value: "Workshop", count: 1 }].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)));
    expect(fields.topic!.values).toEqual([{ value: "Serverless", count: 2 }, { value: "Databases", count: 1 }]);
    expect(fields.day!.values).toEqual([{ value: "2026-12-01", count: 2 }, { value: "2026-12-02", count: 1 }, { value: "2026-12-03", count: 1 }]);
    expect(fields.area!.values).toEqual([{ value: "Security", count: 1 }]);
    expect(fields.industry!.values).toEqual([{ value: "Retail", count: 1 }]);
    expect(fields.role!.values).toEqual([{ value: "Developer", count: 1 }]);
  });

  it("counts a repeat's talk once, even when its sittings are at different venues and days", () => {
    const { fields } = listFilters(deps());
    expect(fields.venue!.values.find(entry => entry.value === "Venetian")!.count).toBe(1);
    expect(fields.role!.values[0]!.count).toBe(1);
  });

  it("lists the level bands, in order, with what each field has in total", () => {
    const { fields } = listFilters(deps());
    expect(fields.level!.values).toEqual([{ value: "100", count: 1 }, { value: "300", count: 2 }, { value: "400", count: 1 }]);
    expect(fields.venue!.total).toBe(3);
  });

  it("returns one field, or refuses an unknown one naming the fields", () => {
    expect(Object.keys(listFilters(deps(), { field: "venue" }).fields)).toEqual(["venue"]);
    expect(() => listFilters(deps(), { field: "colour" })).toThrow(new ValidationError("Unknown field \"colour\". Fields: level, format, venue, day, topic, area, industry, role."));
  });

  it("caps the values per field and says how many more there are", () => {
    const { fields } = listFilters(deps(), { limit: 1 });
    expect(fields.venue!.values).toEqual([{ value: "MGM Grand", count: 2 }]);
    expect(fields.venue).toMatchObject({ total: 3, more: 2 });
    expect(fields.level!.more).toBe(2);
    expect(listFilters(deps()).fields.venue!.more).toBeUndefined();
  });

  it("reads only the local catalog", () => {
    const empty = createTempHome();
    expect(() => listFilters({ storeRoot: empty.path })).toThrow(CatalogMissingError);
    empty.cleanup();
  });
});
