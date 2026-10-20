/**
 * Hand-written mirrors of the OpenAPI schemas the catalog import reads (see
 * docs/api/openapi.json): the shapes the AWS Events MCP returns. These are plain type
 * declarations with no runtime behavior, so there is nothing here for a test to exercise
 * directly; they're proven correct by the import and catalog code that uses them against the
 * real and fixture data.
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
