import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildIndexRecord, tokenize } from "../../src/catalog/index-record.js";
import type { Session } from "../../src/api/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture: Session[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"),
);

const NO_LEVEL_SESSION_ID = "1790358246094001i5t9";

describe("buildIndexRecord", () => {
  it("parses the numeric band out of a level like 300 - Advanced", () => {
    const session: Session = { sessionId: "s1", title: "T", level: "300 - Advanced" };
    expect(buildIndexRecord(session).levelBand).toBe(300);
  });

  it("leaves the level band null for the one session with no level", () => {
    const session = fixture.find((s) => s.sessionId === NO_LEVEL_SESSION_ID);
    expect(session).toBeDefined();
    expect(session!.level).toBeUndefined();

    const record = buildIndexRecord(session!);
    expect(record.level).toBeNull();
    expect(record.levelBand).toBeNull();
  });

  it("parses the length string into minutes", () => {
    const session: Session = {
      sessionId: "s1",
      title: "T",
      sessionTime: { date: "2026-11-30", time: "10:00", length: "60" },
    };
    expect(buildIndexRecord(session).lengthMinutes).toBe(60);
  });

  it("leaves startDate, startTime and lengthMinutes null when sessionTime is absent", () => {
    const session: Session = { sessionId: "s1", title: "T" };
    const record = buildIndexRecord(session);
    expect(record.startDate).toBeNull();
    expect(record.startTime).toBeNull();
    expect(record.lengthMinutes).toBeNull();
  });

  it("defaults every taxonomy array to empty when the field is absent", () => {
    const session: Session = { sessionId: "s1", title: "T" };
    const record = buildIndexRecord(session);
    expect(record.services).toEqual([]);
    expect(record.topics).toEqual([]);
    expect(record.areasOfInterest).toEqual([]);
    expect(record.roles).toEqual([]);
    expect(record.features).toEqual([]);
    expect(record.industries).toEqual([]);
  });

  it("keeps the raw abstract out of the index record", () => {
    const session: Session = {
      sessionId: "s1",
      title: "T",
      abstract: "A distinctive multi word phrase nobody else uses anywhere",
    };
    const record = buildIndexRecord(session);
    expect(record).not.toHaveProperty("abstract");
    expect(JSON.stringify(record)).not.toContain(session.abstract);
  });

  it("tokenises title, abstract and taxonomy into a term-frequency map with stopwords removed", () => {
    const session: Session = {
      sessionId: "s1",
      title: "The Amazon DynamoDB Guide",
      abstract: "This is a guide to the Amazon DynamoDB service and how to use it.",
      topics: ["Databases"],
    };
    const record = buildIndexRecord(session);

    expect(record.titleTerms).toEqual({ amazon: 1, dynamodb: 1, guide: 1 });
    expect(record.bodyTerms.the).toBeUndefined();
    expect(record.bodyTerms.is).toBeUndefined();
    expect(record.bodyTerms.a).toBeUndefined();
    expect(record.bodyTerms.and).toBeUndefined();
    expect(record.bodyTerms.amazon).toBe(1);
    expect(record.bodyTerms.dynamodb).toBe(1);
    expect(record.bodyTerms.databases).toBe(1);
  });

  it("tokenises a term that collides with Object.prototype (constructor) as a real count", () => {
    // A plain object literal's `counts[word] ?? 0` resolves "constructor" to the inherited
    // Object constructor function rather than undefined, so `+ 1` becomes string concatenation
    // instead of arithmetic -- verified against the pre-fix code to produce
    // "function Object() { [native code] }11" rather than the number 1.
    const counts = tokenize("the constructor pattern");

    expect(counts.constructor).toBe(1);
    expect(typeof counts.constructor).toBe("number");
    expect(Object.hasOwn(counts, "constructor")).toBe(true);
  });

  it("strips a possessive 's before tokenizing, so \"agent's\" becomes \"agent\" alone, not a stray \"s\" fragment", () => {
    const counts = tokenize("the agent's plan");

    expect(counts.agent).toBe(1);
    expect(Object.hasOwn(counts, "s")).toBe(false);
  });

  it("also strips a curly-quote possessive suffix", () => {
    const counts = tokenize("the agent’s plan");

    expect(counts.agent).toBe(1);
    expect(Object.hasOwn(counts, "s")).toBe(false);
  });

  it("drops a short, non-acronym fragment like \"no\"", () => {
    const counts = tokenize("no thanks for the fish");

    expect(Object.hasOwn(counts, "no")).toBe(false);
  });

  it("keeps an all-caps acronym as short as two characters, such as S3 or ML", () => {
    const counts = tokenize("Learn about Amazon S3 and ML pipelines");

    expect(counts.s3).toBe(1);
    expect(counts.ml).toBe(1);
  });

  it("drops a short token that shares an acronym's letters but was never written in caps", () => {
    const counts = tokenize("some ml pipelines are simple");

    expect(Object.hasOwn(counts, "ml")).toBe(false);
  });

  it("does not report Object.prototype members as present when the text never contains them", () => {
    const counts = tokenize("hello world");

    expect(Object.hasOwn(counts, "constructor")).toBe(false);
    expect(Object.hasOwn(counts, "hasownproperty")).toBe(false);
    expect(Object.hasOwn(counts, "tostring")).toBe(false);
  });

  it("builds a record for every fixture session without throwing", () => {
    expect(fixture.length).toBeGreaterThan(0);
    for (const session of fixture) {
      const record = buildIndexRecord(session);
      expect(record.sessionId).toBe(session.sessionId);
    }
  });
});
