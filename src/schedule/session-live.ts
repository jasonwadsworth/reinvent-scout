import type { ApiClient } from "../api/client.js";
import type { SeatAvailability } from "../api/types.js";
import { buildIndexRecord } from "../catalog/index-record.js";
import { readTimezoneAvailability } from "../catalog/store.js";
import { DEFAULT_EVENT_ID } from "../catalog/sync.js";
import type { Venue } from "../catalog/venue.js";
import { sessionInterval } from "./plan.js";

const MAX_TITLE_LENGTH = 300;

/** One session as the API reports it right now: the seat band and the fields an agent needs to
 * recognise the session. No abstract, no taxonomy, so the result stays small. */
export interface LiveSession {
  sessionId: string;
  abbreviation: string | null;
  title: string;
  date: string | null;
  time: string | null;
  lengthMinutes: number | null;
  /** UTC instants; `null` when the event timezone isn't known locally (sync the catalog) or the time is unusable. */
  startsAt: string | null;
  endsAt: string | null;
  venue: Venue | null;
  room: string | null;
  isReservable: boolean | null;
  seatAvailability: SeatAvailability | null;
  fetchedAt: string;
}

export interface LiveSessionDeps {
  storeRoot: string;
  apiClient: Pick<ApiClient, "getSession">;
  eventId?: string;
  now?: () => number;
}

/** Reads one session live (never from the local index, which can be stale) and shapes it into a
 * bounded record. Propagates the API client's errors unchanged: a 404 is a `NotFoundError`, which
 * the caller must not take as proof the session is gone. */
export async function getLiveSession(sessionId: string, deps: LiveSessionDeps): Promise<LiveSession> {
  const session = await deps.apiClient.getSession(deps.eventId ?? DEFAULT_EVENT_ID, sessionId);
  const record = buildIndexRecord(session);
  const timezone = readTimezoneAvailability({ storeRoot: deps.storeRoot });
  const interval = timezone?.status === "known" ? sessionInterval(record, timezone.timezone) : null;
  return {
    sessionId: session.sessionId,
    abbreviation: session.abbreviation ?? null,
    title: session.title.length > MAX_TITLE_LENGTH ? `${session.title.slice(0, MAX_TITLE_LENGTH)}…` : session.title,
    date: record.startDate,
    time: record.startTime,
    lengthMinutes: record.lengthMinutes,
    startsAt: interval?.startsAt ?? null,
    endsAt: interval?.endsAt ?? null,
    venue: record.venue,
    room: record.room,
    isReservable: session.isReservable ?? null,
    seatAvailability: session.seatAvailability ?? null,
    fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
  };
}
