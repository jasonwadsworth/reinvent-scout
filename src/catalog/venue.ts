/**
 * The event's five venues, confirmed against the real 2026-09-25 catalog pull: `venue` is
 * present for these three, absent (and derived from the room prefix) for the other two.
 * Deliberately a closed union -- the phase-2 travel-time matrix keys off this set, and a new
 * venue showing up as an unrecognized string is exactly the "return null" case below, not a
 * silent type-widening.
 */
export const VENUES = ["MGM Grand", "Caesars Forum", "Venetian", "Wynn/Encore", "Caesars Palace"] as const;
export type Venue = typeof VENUES[number];
const KNOWN_VENUES: ReadonlySet<string> = new Set(VENUES);

/** Exported so callers taking a venue as a raw string (the `catalog search --venue` CLI flag)
 * can validate it against the same closed set this module treats as authoritative. */
export function isKnownVenue(value: string): value is Venue {
  return KNOWN_VENUES.has(value);
}

export interface DeriveVenueInput {
  venue?: string;
  room?: string;
}

/**
 * Resolves a session's venue. When the API provides `venue`, that's authoritative (as long as
 * it's one of the five known venues; an unrecognized value is treated as absent rather than
 * accepted blindly). Otherwise, when `venue` is absent, the room string is prefixed with the
 * venue name itself for these events (`"Wynn/Encore | Level 1 | ..."`), whereas a session
 * whose `venue` the API did provide instead has a room starting with `"Level N"` -- so the room
 * prefix is only ever consulted as a fallback, never alongside a present `venue`. Returns null
 * when neither source names a known venue.
 */
export function deriveVenue(input: DeriveVenueInput): Venue | null {
  if (input.venue !== undefined) {
    return isKnownVenue(input.venue) ? input.venue : null;
  }

  if (input.room === undefined) {
    return null;
  }

  const firstSegment = input.room.split("|")[0]?.trim();
  return firstSegment !== undefined && isKnownVenue(firstSegment) ? firstSegment : null;
}
