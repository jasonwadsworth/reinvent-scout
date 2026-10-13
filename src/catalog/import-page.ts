import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import { ValidationError } from "../core/errors.js";
import { formatZodError } from "../core/zod-errors.js";
import type { Session } from "../api/types.js";

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

/** Unwraps a one-element `[{type: "text", text}]` array, as an MCP client may save a tool result. */
function unwrapTextEnvelope(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 1) {
    const only: unknown = value[0];
    if (typeof only === "object" && only !== null && (only as { type?: unknown }).type === "text" && typeof (only as { text?: unknown }).text === "string") {
      return parseJson((only as { text: string }).text);
    }
  }
  return value;
}

/** Returns undefined for text that is not JSON; the error message is never used, because a parse
 * error can quote the content. */
function tryParseJson(text: string): { value: unknown } | undefined {
  try { return { value: JSON.parse(text) as unknown }; } catch { return undefined; }
}
function parseJson(text: string): unknown {
  return tryParseJson(text)?.value;
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
  const name = basename(path);
  if (!isAbsolute(path)) throw new ValidationError("The page path must be absolute.");
  // One open, then every check on the handle: a path swapped for a symlink or a FIFO between a
  // stat and a read can neither be followed nor block.
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") throw new ValidationError(`Page file ${name} is a symbolic link; pass the real file.`);
    throw new ValidationError(`Cannot read page file ${name}.`);
  }
  let text: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new ValidationError(`Page file ${name} is not a regular file.`);
    if (stat.size > (options.maxBytes ?? MAX_PAGE_FILE_BYTES)) throw new ValidationError(`Page file ${name} is too large.`);
    text = readFileSync(fd, "utf8");
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(`Cannot read page file ${name}.`);
  } finally {
    closeSync(fd);
  }
  const first = tryParseJson(text);
  if (first === undefined) throw new ValidationError(`Page file ${name} is not valid JSON.`);
  const value = unwrapTextEnvelope(first.value);
  const parsed = ListSessionsPageSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(`Page file ${name} is not a ListSessions page: ${formatZodError(parsed.error)}`);
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
