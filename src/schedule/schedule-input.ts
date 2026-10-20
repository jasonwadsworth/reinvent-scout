import { z } from "zod";
import type { Schedule } from "../aws/types.js";
import { ValidationError } from "../core/errors.js";
import { readSafeJsonFile } from "../core/safe-read.js";
import { formatZodError } from "../core/zod-errors.js";

const MAX_SCHEDULE_FILE_BYTES = 4 * 1024 * 1024;
const id = z.string().min(1).max(128);
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, "expected YYYY-MM-DDTHH:MM:SS (UTC, no offset, no milliseconds)");

/** One personal-time block, as AWS `GetSchedule` returns it. Unknown keys are stripped. */
/** Free text is shortened, not rejected: one long note must not make the whole schedule unusable. */
const shortened = (max: number) => z.string().transform(text => text.slice(0, max));

export const personalTimeSchema = z.object({
  personalTimeId: id,
  startDateTime: localDateTime,
  endDateTime: localDateTime,
  title: shortened(300).default(""),
  description: shortened(2000).default(""),
  location: shortened(300).optional(),
});

/** The AWS `GetSchedule` `schedule` object, verbatim: the agent passes it through unchanged. */
export const scheduleInputSchema = z.strictObject({
  reserved: z.array(id).max(1000),
  favorites: z.array(id).max(1000).default([]),
  personalTime: z.array(personalTimeSchema).max(1000),
});
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

export interface ScheduleSource {
  schedule?: unknown;
  scheduleFile?: string | undefined;
}

/**
 * Resolves the schedule a command works from: `schedule` inline, or `scheduleFile` holding either
 * `{schedule}` (a saved `GetSchedule` result) or the bare object. Exactly one is required unless
 * `optional`, which allows neither and returns undefined.
 */
export function readScheduleInput(source: ScheduleSource, options: { optional: true }): Schedule | undefined;
export function readScheduleInput(source: ScheduleSource, options?: { optional?: false }): Schedule;
export function readScheduleInput(source: ScheduleSource, options: { optional?: boolean } = {}): Schedule | undefined {
  const hasInline = source.schedule !== undefined;
  const hasFile = source.scheduleFile !== undefined;
  if (hasInline && hasFile) throw new ValidationError("Pass exactly one of `schedule` and `scheduleFile`.");
  if (!hasInline && !hasFile) {
    if (options.optional) return undefined;
    throw new ValidationError("Pass exactly one of `schedule` and `scheduleFile`: call GetSchedule and pass its result.");
  }
  let value: unknown = source.schedule;
  if (hasFile) {
    value = readSafeJsonFile(source.scheduleFile!, { noun: "schedule", maxBytes: MAX_SCHEDULE_FILE_BYTES });
    if (typeof value === "object" && value !== null && !Array.isArray(value) && "schedule" in value && Object.keys(value).length === 1) {
      value = (value as { schedule: unknown }).schedule;
    }
  }
  const parsed = scheduleInputSchema.safeParse(value);
  if (!parsed.success) throw new ValidationError(`Not a GetSchedule schedule: ${formatZodError(parsed.error)}`);
  return parsed.data as Schedule;
}
