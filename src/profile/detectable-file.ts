/** A file made available to a detector: a path relative to the repository root, exactly as
 * `walkRepo` returns it, and its content already read. Detectors are pure functions over a list
 * of these rather than over a filesystem, so they're testable without a real directory tree and
 * usable against evidence sourced some other way in the future (the plan's seam for GitHub
 * issues as intent). Shared across every detector in `src/profile/detectors/**` so they all take
 * the same input shape. */
export interface DetectableFile {
  path: string;
  content: string;
}
