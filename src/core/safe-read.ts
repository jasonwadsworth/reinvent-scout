import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { ValidationError } from "./errors.js";

export interface SafeReadOptions {
  /** What the file is, for messages: "page" gives "Page file x.json is too large.". */
  noun: string;
  maxBytes: number;
}

/** Returns undefined for text that is not JSON; the parse error is never used, because Node's
 * SyntaxError can quote the content. */
function tryParseJson(text: string): { value: unknown } | undefined {
  try { return { value: JSON.parse(text) as unknown }; } catch { return undefined; }
}

/** Unwraps a one-element `[{type: "text", text}]` array, as an MCP client may save a tool result. */
function unwrapTextEnvelope(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 1) {
    const only: unknown = value[0];
    if (typeof only === "object" && only !== null && (only as { type?: unknown }).type === "text" && typeof (only as { text?: unknown }).text === "string") {
      return tryParseJson((only as { text: string }).text)?.value;
    }
  }
  return value;
}

/**
 * Reads a JSON file an agent saved: absolute path, one open with `O_NOFOLLOW | O_NONBLOCK`, every
 * check on the handle (so a path swapped for a symlink or a FIFO between a stat and a read can
 * neither be followed nor block), a size cap, then a parse. Error messages name the check that
 * failed and the file's basename; they never include file content. The file is never modified.
 */
export function readSafeJsonFile(path: string, options: SafeReadOptions): unknown {
  const name = basename(path);
  const label = `${options.noun[0]!.toUpperCase()}${options.noun.slice(1)} file ${name}`;
  if (!isAbsolute(path)) throw new ValidationError(`The ${options.noun} path must be absolute.`);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") throw new ValidationError(`${label} is a symbolic link; pass the real file.`);
    throw new ValidationError(`Cannot read ${options.noun} file ${name}.`);
  }
  let text: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new ValidationError(`${label} is not a regular file.`);
    if (stat.size > options.maxBytes) throw new ValidationError(`${label} is too large.`);
    text = readFileSync(fd, "utf8");
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(`Cannot read ${options.noun} file ${name}.`);
  } finally {
    closeSync(fd);
  }
  const first = tryParseJson(text);
  if (first === undefined) throw new ValidationError(`${label} is not valid JSON.`);
  return unwrapTextEnvelope(first.value);
}
