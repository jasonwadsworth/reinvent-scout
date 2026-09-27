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

  it("tokenizes a possessive like \"agent's\" to \"agent\" alone, not a stray \"s\" fragment -- a regression guard on the short-token filter, not a dedicated possessive step", () => {
    // The apostrophe isn't a word character, so word-splitting alone already breaks "agent's" into
    // "agent" and "s"; the short-token filter (MIN_TERM_LENGTH, see there) is what drops that
    // orphaned one-character "s". There is no separate possessive-stripping mechanism -- an earlier
    // version had one, but sabotage testing proved it fully redundant with this filter, so it was
    // removed as dead code.
    const counts = tokenize("the agent's plan");

    expect(counts.agent).toBe(1);
    expect(Object.hasOwn(counts, "s")).toBe(false);
  });

  it("handles a curly-quote possessive the same way, via the same short-token filter", () => {
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

  it("recognizes an all-caps acronym even though the stored term is lowercased -- the exception must be checked before lowercasing, not after", () => {
    // The trap: by the time a token is lowercased, "AI" and "ai" are indistinguishable, so
    // checking the acronym exception against the already-lowercased word can never fire. "AI" in
    // particular is the highest-stakes case in this catalog -- 2,779 occurrences across 1,151 of
    // 2,043 real sessions (measured against the real snapshot) -- so silently losing it would blind
    // the matcher to more than half the catalog.
    const counts = tokenize("Generative AI on Amazon S3");

    expect(counts.ai).toBe(1);
    expect(counts.s3).toBe(1);
  });

  it("keeps a lowercase short token under keepShortTokens, for parsing a query rather than building the index", () => {
    // The short-token/acronym-exception filter is a corpus-noise defense that belongs to index
    // building, not to query parsing -- a user typing "s3" or an agent writing "we use ai" means
    // it, and a deliberate query term that isn't actually in the index just matches nothing, at no
    // precision cost. Without keepShortTokens (the index-building default), both are dropped.
    const withoutOption = tokenize("we use ai and s3 heavily");
    expect(Object.hasOwn(withoutOption, "ai")).toBe(false);
    expect(Object.hasOwn(withoutOption, "s3")).toBe(false);

    const withOption = tokenize("we use ai and s3 heavily", { keepShortTokens: true });
    expect(withOption.ai).toBe(1);
    expect(withOption.s3).toBe(1);
  });

  it("leaves no stray contraction or possessive fragments from common apostrophe forms", () => {
    const counts = tokenize("we'll use the agent's tools, don't wait");

    expect(Object.hasOwn(counts, "ll")).toBe(false);
    expect(Object.hasOwn(counts, "s")).toBe(false);
    expect(Object.hasOwn(counts, "t")).toBe(false);
    // "don't" without stripping the whole "n't" unit leaves "don" (3 characters -- long enough to
    // survive the short-token filter on its own). Measured against the real 2,043-session catalog,
    // "don" has document frequency 68, giving it an idf of 3.396 -- almost identical to
    // "dynamodb"'s 3.411 -- so left unstripped it would score in a "text overlap" reason as though
    // it were a precise, meaningful service term.
    expect(Object.hasOwn(counts, "don")).toBe(false);
  });

  it("strips the whole n't contraction unit -- not just 't -- for every English negative contraction", () => {
    // "don't" without stripping the "n" too would leave "don"; stripping just "'t" from
    // "wouldn't" would leave "wouldn", not the real word "would". The suffix removed is "n't" as a
    // unit, so the remainder is exactly the stem word ("would", "does", ...) or a fragment short
    // enough for the length filter to drop on its own ("do", "wo", "ca") -- never the stem with a
    // stray "n" still attached.
    const wrongStems = [
      "wouldn", "weren", "hasn", "wasn", "couldn", "haven",
      "didn", "won", "aren", "shouldn", "doesn", "isn", "don",
    ];
    const text = wrongStems.map((stem) => `${stem}'t`).join(" ");

    const counts = tokenize(text);

    for (const wrongStem of wrongStems) {
      expect(Object.hasOwn(counts, wrongStem)).toBe(false);
    }
  });

  it("leaves the real word behind when a negative contraction's stem is one -- doesn't -> does, wouldn't -> would", () => {
    const counts = tokenize("this session doesn't skip steps and wouldn't rush the agenda");

    expect(counts.does).toBe(1);
    expect(counts.would).toBe(1);
    expect(Object.hasOwn(counts, "doesn")).toBe(false);
    expect(Object.hasOwn(counts, "wouldn")).toBe(false);
  });

  it("preserves standalone \"can\", which the n't strip must not be confused for", () => {
    // The reviewer's specific trap: "can" has real document frequency in the catalog and must
    // survive on its own, even though "can't" (stem "ca", two characters) is stripped down to a
    // droppable fragment by the exact same mechanism. A rule that stripped a trailing "n" instead
    // of the whole "n't" unit, or that treated fragments as a stopword list, would risk this.
    const counts = tokenize("we can do this, but we can't do that");

    expect(counts.can).toBe(1);
    expect(Object.hasOwn(counts, "ca")).toBe(false);
  });

  it("strips 'll, 're, 've, 'd and 'm suffixes, leaving a real word behind when there is one", () => {
    const counts = tokenize("you'll see, they're here, we've done, I'd go, I'm here");

    expect(Object.hasOwn(counts, "ll")).toBe(false);
    expect(Object.hasOwn(counts, "re")).toBe(false);
    expect(Object.hasOwn(counts, "ve")).toBe(false);
    expect(counts.they).toBe(1);
    expect(counts.see).toBe(1);
    expect(counts.done).toBe(1);
  });

  it("also strips a curly-quote n't", () => {
    const counts = tokenize("this session doesn’t skip steps");

    expect(counts.does).toBe(1);
    expect(Object.hasOwn(counts, "doesn")).toBe(false);
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

  it("keeps the AI acronym across the real fixture -- an explicit, hard-coded count so a regression that silently drops short acronyms fails loudly", () => {
    // Counted once against this fixture and hard-coded here deliberately, rather than computed and
    // re-asserted against itself: a self-computed count would still pass even if the acronym
    // exception silently stopped firing for every session, since "unchanged from itself" is true of
    // zero just as much as it is of the real number.
    const sessionsWithAi = fixture.filter((session) => {
      const record = buildIndexRecord(session);
      return Object.hasOwn(record.titleTerms, "ai") || Object.hasOwn(record.bodyTerms, "ai");
    });

    expect(sessionsWithAi.length).toBeGreaterThan(0);
    expect(sessionsWithAi.length).toBe(40);
  });
});
