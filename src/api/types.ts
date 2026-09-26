/**
 * Hand-written mirrors of the OpenAPI schemas this client actually uses (see
 * docs/api/openapi.json), not a generated client -- see the plan's decision on why. These are
 * plain type declarations with no runtime behavior, so there is nothing here for a test to
 * exercise directly; they're proven correct by the client and catalog code that uses them
 * against the real and fixture data.
 */

/** How full a reservable session is, as a band rather than a count. */
export type SeatAvailability = "available" | "limited" | "veryLimited" | "unavailable" | "walkUp";

export interface SessionTime {
  date?: string;
  time?: string;
  /** Length in minutes, as a string (e.g. "60") -- the API's own representation. */
  length?: string;
  /** Present only when the source event supplies one; this event does not, in practice. */
  timezone?: string;
}

export interface Speaker {
  name?: string;
}

export interface Session {
  sessionId: string;
  title: string;
  abbreviation?: string;
  abstract?: string;
  type?: string;
  level?: string;
  venue?: string;
  room?: string;
  isAllDaySession?: boolean;
  isReservable?: boolean;
  seatAvailability?: SeatAvailability;
  sessionTime?: SessionTime;
  speakers?: Speaker[];
  tracks?: string[];
  topics?: string[];
  industries?: string[];
  areasOfInterest?: string[];
  roles?: string[];
  services?: string[];
  segments?: string[];
  features?: string[];
  customerPersonas?: string[];
  experiences?: string[];
  additionalActivities?: string[];
  focusAreas?: string[];
}

export interface PersonalTime {
  personalTimeId: string;
  /** `YYYY-MM-DDTHH:MM:SS` in UTC. */
  startDateTime: string;
  endDateTime: string;
  title: string;
  description: string;
  location?: string;
}

export interface Schedule {
  reserved: string[];
  favorites: string[];
  personalTime: PersonalTime[];
}

export interface ListSessionsResponseContent {
  /** This page of sessions, ordered by `sessionId`. Empty when the event has no sessions. */
  items: Session[];
  /** The number of sessions in the event's whole catalog, not just this page. */
  totalCount: number;
  /** Pass as `nextToken` to fetch the following page. Absent on the last page. */
  nextToken?: string;
}

/**
 * Why one session in a bulk request (favorite/unfavorite/reserve) was refused. The API
 * document is explicit that unrecognized values will be added as the platform grows, so this
 * is the known union plus `string` -- a caller that switches exhaustively on today's set alone
 * would break on the next one instead of falling back to a generic refusal.
 */
export type BulkFailureCode =
  | "sessionNotReservable"
  | "scheduleConflict"
  | "alreadyScheduled"
  | "sessionFull"
  | "insufficientAccess"
  | "timePassed"
  | "alreadyFavorited"
  | "notFavorited"
  | "other"
  // Widens the literal union above to accept values the API adds later, without losing
  // autocomplete for today's known set.
  | (string & {});

export interface BulkFailure {
  sessionId: string;
  code: BulkFailureCode;
  /** Only present when `code` is `scheduleConflict`; never empty when present. */
  conflictsWith?: string[];
}

/** The outcome of a bulk request. A 200 status does not mean every session succeeded -- always
 * check `failed`. */
export interface BulkResult {
  successful: string[];
  failed: BulkFailure[];
}
