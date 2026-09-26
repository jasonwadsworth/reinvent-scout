import { SKIPPED_DIRECTORY_NAMES } from "../walk.js";

/** Whether `path` passes through any directory `walkRepo` itself would never descend into.
 * Shares `SKIPPED_DIRECTORY_NAMES` with the walker rather than each detector hard-coding its own
 * subset -- independent defense against a file a real walk would never surface, in case a
 * detector is ever called with a file list `walkRepo` didn't produce (a detector's primary
 * caller, `profile.ts`, always filters this already, but no detector should have to trust that),
 * while guaranteeing every detector agrees with the walker about what counts as "inside the
 * repository". Shared by every detector in `src/profile/detectors/**`, per the lead decision
 * recorded in the plan's Implementation notes. */
export function isInsideSkippedDirectory(path: string): boolean {
  return path.split(/[/\\]/).some((segment) => SKIPPED_DIRECTORY_NAMES.has(segment));
}

export function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}

/** The file extension including its leading dot (e.g. `.ts`), or `""` when `path` has none --
 * treats a dotfile like `.gitignore` as having no extension, the same distinction
 * `detectors/manifests.ts` already drew for `.env`. */
export function extensionOf(path: string): string {
  const name = basename(path);
  const dotIndex = name.lastIndexOf(".");
  return dotIndex <= 0 ? "" : name.slice(dotIndex);
}
