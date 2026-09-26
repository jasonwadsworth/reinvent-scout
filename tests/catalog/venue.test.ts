import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveVenue } from "../../src/catalog/venue.js";

const here = dirname(fileURLToPath(import.meta.url));
interface FixtureSession {
  sessionId: string;
  venue?: string;
  room?: string;
}
const fixture: FixtureSession[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"),
);

describe("deriveVenue", () => {
  it("uses the venue field when the API provides one", () => {
    expect(deriveVenue({ venue: "MGM Grand", room: "Level 3 | Chairman's 363" })).toBe(
      "MGM Grand",
    );
  });

  it("derives Wynn/Encore from the room prefix when venue is absent", () => {
    expect(deriveVenue({ room: "Wynn/Encore | Level 1 | Chopin 4" })).toBe("Wynn/Encore");
  });

  it("derives Caesars Palace from the room prefix when venue is absent", () => {
    expect(deriveVenue({ room: "Caesars Palace | Forum Ballroom" })).toBe("Caesars Palace");
  });

  it("returns null when there is no venue and no room", () => {
    expect(deriveVenue({})).toBeNull();
  });

  it("returns null rather than accepting an unrecognized venue field value", () => {
    // A closed union means a venue the API adds later must not be silently cast through --
    // this is the case that must fall to "unrecognized" rather than being trusted blindly.
    expect(deriveVenue({ venue: "Some New Venue Nobody Has Heard Of" })).toBeNull();
  });

  it("returns null when the room prefix is not a known venue", () => {
    expect(deriveVenue({ room: "Some Unknown Hotel | Room 1" })).toBeNull();
  });

  it("does not mistake a Level 3 room prefix for a venue", () => {
    // This is the shape rooms take when `venue` IS present -- if venue were (incorrectly)
    // omitted from the input here, "Level 3" must never be treated as a venue name.
    expect(deriveVenue({ room: "Level 3 | Chairman's 363 | Content Hub | White Theater" })).toBeNull();
  });

  it("assigns a venue to every fixture session that has a room", () => {
    const withRoom = fixture.filter((s) => s.room !== undefined);
    expect(withRoom.length).toBeGreaterThan(0);
    for (const session of withRoom) {
      const venue = deriveVenue(session);
      expect(venue, `session ${session.sessionId} (room: ${session.room})`).not.toBeNull();
    }
  });
});
