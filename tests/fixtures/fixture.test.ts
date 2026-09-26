import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface FixtureSpeaker {
  name?: string;
}

interface FixtureSession {
  sessionId: string;
  title: string;
  type?: string;
  level?: string;
  venue?: string;
  room?: string;
  sessionTime?: { date?: string; time?: string; length?: string };
  services?: string[];
  speakers?: FixtureSpeaker[];
  industries?: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const fixture: FixtureSession[] = JSON.parse(
  readFileSync(join(here, "catalog-sample.json"), "utf8"),
);

const ALL_TYPES = [
  "Breakout session",
  "Builders' session",
  "Chalk talk",
  "Code talk",
  "Gamified learning",
  "Lightning talk",
  "Workshop",
  "Bootcamp",
  "Exam prep",
  "Lab",
];

const ALL_DATES = [
  "2026-11-30",
  "2026-12-01",
  "2026-12-02",
  "2026-12-03",
  "2026-12-04",
];

describe("catalog fixture", () => {
  it("has sixty sessions", () => {
    expect(fixture.length).toBe(60);
  });

  it("covers all ten session types", () => {
    const present = new Set(fixture.map((s) => s.type));
    for (const type of ALL_TYPES) {
      expect(present.has(type)).toBe(true);
    }
  });

  it("includes sessions for every venue including the two derived from the room prefix", () => {
    for (const venue of ["MGM Grand", "Caesars Forum", "Venetian"]) {
      const count = fixture.filter((s) => s.venue === venue).length;
      expect(count).toBeGreaterThanOrEqual(4);
    }
    for (const prefix of ["Wynn/Encore", "Caesars Palace"]) {
      const count = fixture.filter(
        (s) => !s.venue && s.room?.startsWith(prefix),
      ).length;
      expect(count).toBeGreaterThanOrEqual(4);
    }
  });

  it("includes sessions with no room and no sessionTime", () => {
    const count = fixture.filter((s) => !s.room && !s.sessionTime).length;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it("includes a session with no level", () => {
    const count = fixture.filter((s) => !s.level).length;
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("includes sessions with empty services, empty speakers, and non-empty industries", () => {
    const match = fixture.some(
      (s) =>
        (!s.services || s.services.length === 0) &&
        (!s.speakers || s.speakers.length === 0) &&
        s.industries &&
        s.industries.length > 0,
    );
    expect(match).toBe(true);
  });

  it("spans all five conference dates", () => {
    const present = new Set(fixture.map((s) => s.sessionTime?.date).filter(Boolean));
    for (const date of ALL_DATES) {
      expect(present.has(date)).toBe(true);
    }
  });

  it("includes a session with the Amazon DynamoDB service", () => {
    const count = fixture.filter((s) => s.services?.includes("Amazon DynamoDB")).length;
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("includes a session with the Elastic Load Balancing (ELB) service", () => {
    const count = fixture.filter((s) =>
      s.services?.includes("Elastic Load Balancing (ELB)"),
    ).length;
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
