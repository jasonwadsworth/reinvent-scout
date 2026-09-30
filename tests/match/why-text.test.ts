import { describe, expect, it } from "vitest";
import { quoteAround, trimNote } from "../../src/match/why.js";

describe("trimNote", () => {
  it("strips the profiling-guide boilerplate prefix", () => {
    expect(trimNote("Not evident in the cited scope: the three rules set no deadLetterQueue."))
      .toBe("the three rules set no deadLetterQueue");
    expect(trimNote("not evident in the cited scope:   no alarms")).toBe("no alarms");
  });

  it("keeps only the first sentence", () => {
    expect(trimNote("Rules set no DLQ. Retries are also absent. See the ADR."))
      .toBe("Rules set no DLQ");
  });

  it("does not split on a file name or an abbreviation", () => {
    expect(trimNote("Defined in cdk-construct.ts, e.g. the tenant rules, and nothing else. Second."))
      .toBe("Defined in cdk-construct.ts, e.g. the tenant rules, and nothing else");
  });

  it("caps a long note near 200 characters at a word boundary with an ellipsis", () => {
    const long = `${"word ".repeat(80)}end`;
    const trimmed = trimNote(long)!;
    expect(trimmed.length).toBeLessThanOrEqual(201);
    expect(trimmed.endsWith("…")).toBe(true);
    expect(trimmed.slice(0, -1).trimEnd().endsWith("word")).toBe(true);
  });

  it("prefers ending a long note on a clause break past its midpoint", () => {
    const long = `${"word ".repeat(30)}end of clause, ${"other ".repeat(20)}tail`;
    const trimmed = trimNote(long)!;
    expect(trimmed.endsWith("end of clause…")).toBe(true);
  });

  it("never ends inside an open parenthesis", () => {
    const long = `${"word ".repeat(30)}(presigned PUT URLs for audit ${"tail ".repeat(20)}) end`;
    const trimmed = trimNote(long)!;
    expect(trimmed.endsWith("word…")).toBe(true);
    expect(trimmed).not.toContain("(");
  });

  it("removes parenthetical asides, innermost first, when asked, before trimming", () => {
    expect(trimNote("Bedrock is one call (one prompt (no tools), no loop) and validated.", true)).toBe("Bedrock is one call and validated");
    expect(trimNote("Bedrock is one call (one prompt).", false)).toBe("Bedrock is one call (one prompt)");
  });

  it("returns undefined for a missing or empty note", () => {
    expect(trimNote(undefined)).toBeUndefined();
    expect(trimNote("   ")).toBeUndefined();
    expect(trimNote("Not evident in the cited scope:")).toBeUndefined();
  });

  it("collapses whitespace and newlines", () => {
    expect(trimNote("first line\n  second   line.")).toBe("first line second line");
  });
});

describe("quoteAround", () => {
  const text = "Intro sentence here. Learn to use dead-letter queues and redrive for failed deliveries. Closing thought.";
  const at = (needle: string) => text.indexOf(needle);

  it("returns the whole sentence that contains the match", () => {
    expect(quoteAround(text, at("dead-letter"), "dead-letter queues".length))
      .toBe("Learn to use dead-letter queues and redrive for failed deliveries.");
  });

  it("does not end a sentence at a lowercase abbreviation", () => {
    const abbreviated = "Use e.g. dead-letter queues for safety. Next.";
    expect(quoteAround(abbreviated, abbreviated.indexOf("dead"), 4)).toBe("Use e.g. dead-letter queues for safety.");
  });

  it("treats a newline as a boundary", () => {
    const lines = "Overview of things\nWe cover DLQs in depth\nAgenda";
    expect(quoteAround(lines, lines.indexOf("DLQs"), 4)).toBe("We cover DLQs in depth");
  });

  it("trims a long sentence to about 160 characters around the match, with ellipses", () => {
    const long = `${"alpha ".repeat(40)}dead-letter queues${" omega".repeat(40)}.`;
    const quote = quoteAround(long, long.indexOf("dead-letter"), "dead-letter queues".length);
    expect(quote).toContain("dead-letter queues");
    expect(quote.length).toBeLessThanOrEqual(164);
    expect(quote.startsWith("…")).toBe(true);
    expect(quote.endsWith("…")).toBe(true);
    const inner = quote.replace(/^…/, "").replace(/…$/, "");
    expect(long).toContain(inner);
  });

  it("adds no leading ellipsis when the window starts at the sentence start", () => {
    const long = `Dead-letter queues ${"omega ".repeat(60)}end.`;
    const quote = quoteAround(long, 0, "Dead-letter queues".length);
    expect(quote.startsWith("Dead-letter")).toBe(true);
    expect(quote.endsWith("…")).toBe(true);
  });
});
