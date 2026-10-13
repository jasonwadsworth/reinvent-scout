import type { z } from "zod";

/**
 * Every issue's own message, one per line, prefixed with its field path when it has one --
 * `"services: Invalid input: expected array, received undefined"` rather than the bare message
 * alone. Without the path, three different missing top-level fields (`repos`, `services`,
 * `patterns`) print as three identical, indistinguishable lines, which is close to the
 * "flattened generic 'invalid profile'" this formatting exists to avoid in the first place --
 * `superRefine`'s own custom issues already name the offending entry in their message
 * (`Service "dynamodb" has no evidence`), so the path prefix mainly helps the *other* case: a
 * field missing or malformed at the top level, where zod's own message has nothing to say about
 * which field it's talking about.
 *
 * Shared by `profile.ts` and `match.ts`, the two commands that resolve an agent-authored profile
 * and so can both fail this exact way for the same file.
 */
export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("\n");
}
