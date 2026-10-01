/** When a sitting ends, as the same local wall-clock time its start is in. */
export interface SittingEnd {
  endTime: string;
  /** Only when the sitting runs past midnight. */
  endDate?: string;
}

const TIME = /^(\d{2}):(\d{2})$/;
const MINUTES_PER_DAY = 24 * 60;

/**
 * The end of a sitting from its start and catalog length: `startTime` plus `lengthMinutes` (rounded to whole minutes), local to the event like the
 * start is, with the date only when it passes midnight. `undefined` when there is no start time or no usable length, so an end is never guessed.
 */
export function endOf(startDate: string | null, startTime: string | null, lengthMinutes: number | null): SittingEnd | undefined {
  const match = startTime === null ? null : TIME.exec(startTime);
  const length = lengthMinutes === null || !Number.isFinite(lengthMinutes) ? 0 : Math.round(lengthMinutes);
  if (match === null || length <= 0) return undefined;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = start + length;
  const wall = `${String(Math.floor((end % MINUTES_PER_DAY) / 60)).padStart(2, "0")}:${String(end % MINUTES_PER_DAY % 60).padStart(2, "0")}`;
  if (end < MINUTES_PER_DAY || startDate === null) return { endTime: wall };
  const next = new Date(`${startDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + Math.floor(end / MINUTES_PER_DAY));
  return { endTime: wall, endDate: next.toISOString().slice(0, 10) };
}
