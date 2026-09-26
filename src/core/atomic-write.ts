import { randomBytes } from "node:crypto";
import { chmodSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface AtomicWriteOptions {
  mode: number;
}

/**
 * Writes `targetPath` atomically: the content is produced first (so a serialisation error
 * never touches disk), then written to a temp file in the same directory, chmod'd to the
 * requested mode, and renamed into place. Because the temp file already has the right mode
 * before the rename, there is never a window where the target exists at the wrong mode.
 */
export function writeFileAtomic(
  targetPath: string,
  produce: () => string | Buffer,
  options: AtomicWriteOptions,
): void {
  const content = produce();

  const dir = dirname(targetPath);
  const tempPath = join(dir, `.${basename(targetPath)}.${randomBytes(6).toString("hex")}.tmp`);

  try {
    writeFileSync(tempPath, content, { mode: options.mode });
    chmodSync(tempPath, options.mode);
    renameSync(tempPath, targetPath);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best effort cleanup; the error below is what matters to the caller.
    }
    throw err;
  }
}
