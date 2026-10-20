import { basename } from "node:path";
import { z } from "zod";
import { ValidationError } from "../core/errors.js";
import { readSafeJsonFile } from "../core/safe-read.js";
import { formatZodError } from "../core/zod-errors.js";
import type { Session } from "../aws/types.js";

export const MAX_PAGE_FILE_BYTES = 16 * 1024 * 1024;

/** One item of an AWS `ListSessions` page. Loose on purpose: every field the API sends is kept verbatim. */
export const SessionItemSchema = z.looseObject({
  sessionId: z.string().min(1).max(128),
  title: z.string(),
});

/** The shape of the AWS `ListSessions` response. It deliberately rejects a `GetSession`
 * (`{session}`), a `GetSchedule` (`{schedule}`), error text and anything that is not JSON. */
export const ListSessionsPageSchema = z.object({
  items: z.array(SessionItemSchema).max(1000).superRefine((items, ctx) => {
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (seen.has(item.sessionId)) ctx.addIssue({ code: "custom", path: [index, "sessionId"], message: "sessionId is repeated within the page" });
      seen.add(item.sessionId);
    }
  }),
  totalCount: z.number().int().nonnegative(),
  nextToken: z.string().min(1).max(512).optional(),
});

export interface ListSessionsPage {
  items: Session[];
  totalCount: number;
  nextToken?: string;
}

export interface PageInput {
  path?: string;
  page?: unknown;
}
export interface PageReadOptions {
  /** Defaults to `MAX_PAGE_FILE_BYTES`. */
  maxBytes?: number;
}

/** Validates an already-parsed page (the inline form). Names the failing checks, never the values. */
export function parseListSessionsPage(value: unknown): ListSessionsPage {
  const parsed = ListSessionsPageSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(`Not a ListSessions page: ${formatZodError(parsed.error)}`);
  }
  return parsed.data as ListSessionsPage;
}

/** Reads a saved ListSessions result. Error messages name the check that failed and the file's
 * basename; they never include file content. The file is never modified. */
export function readListSessionsPageFile(path: string, options: PageReadOptions = {}): ListSessionsPage {
  const value = readSafeJsonFile(path, { noun: "page", maxBytes: options.maxBytes ?? MAX_PAGE_FILE_BYTES });
  const parsed = ListSessionsPageSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(`Page file ${basename(path)} is not a ListSessions page: ${formatZodError(parsed.error)}`);
  }
  return parsed.data as ListSessionsPage;
}

/** Exactly one of `path` (a saved file) and `page` (the parsed object) is allowed. */
export function resolveListSessionsPage(input: PageInput, options: PageReadOptions = {}): ListSessionsPage {
  const hasPath = input.path !== undefined;
  const hasPage = input.page !== undefined;
  if (hasPath === hasPage) throw new ValidationError("Pass exactly one of `path` and `page`.");
  return hasPath ? readListSessionsPageFile(input.path!, options) : parseListSessionsPage(input.page);
}
