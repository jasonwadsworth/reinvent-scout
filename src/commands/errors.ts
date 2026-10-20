import { z } from "zod";
import { CatalogImportRejectedError } from "../catalog/import.js";
import { formatZodError } from "../core/zod-errors.js";

/** What a failed command prints: `{"error": "..."}`, plus `reason` where a machine-readable one exists. */
export interface CommandError {
  error: string;
  reason?: string;
}

const MAX_ERROR_CHARS = 512;

function cut(text: string): string {
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

/** Turns anything a command throws into the error object, cut to 512 characters (a schema error
 * can list hundreds of issues, and a Bash tool result is read back in full). */
export function toCommandError(err: unknown): CommandError {
  if (err instanceof z.ZodError) return { error: cut(formatZodError(err)) };
  if (err instanceof CatalogImportRejectedError) return { error: cut(err.message), reason: err.reason };
  return { error: cut(err instanceof Error ? err.message : String(err)) };
}
