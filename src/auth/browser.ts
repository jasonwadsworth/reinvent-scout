import { spawn as nodeSpawn } from "node:child_process";

/**
 * The minimal shape `launchBrowser` needs from a spawned child process -- not the full
 * `node:child_process` `ChildProcess` interface -- so a test double can be a plain object
 * instead of a real process.
 */
export interface SpawnedProcess {
  on(event: "error", listener: (err: Error) => void): void;
  unref(): void;
}

export interface SpawnOptions {
  stdio: "ignore";
  detached: boolean;
}

export interface LaunchBrowserDeps {
  /** Defaults to `process.platform`. Inject a fixed value for deterministic tests. */
  platform?: NodeJS.Platform;
  /** Defaults to `node:child_process`'s `spawn`. Inject a stub so no test launches a real process. */
  spawn?: (command: string, args: string[], options: SpawnOptions) => SpawnedProcess;
}

function commandFor(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (platform === "win32") {
    // `cmd /c start "" <url>` looks like the obvious choice, but `start` only runs inside
    // cmd.exe, and cmd.exe re-parses its whole command line with its own rules -- an unescaped
    // `&`, present in every OAuth authorize URL, is a command separator to cmd.exe regardless of
    // how Node quoted the argument for CreateProcess, so the URL would be truncated at the first
    // `&` and the rest run as a second command. rundll32 opens a URL in the system's default
    // browser directly; it is not a shell, so there is no re-parsing step and nothing in the URL
    // needs escaping.
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }
  // linux and every other platform Node reports (freebsd, openbsd, ...) fall back to the
  // freedesktop.org opener, the closest thing to a universal default outside darwin/win32.
  return { command: "xdg-open", args: [url] };
}

/**
 * Best-effort browser launch. Failure is never fatal to the caller: the authorize URL is
 * always printed as a fallback by src/auth/login.ts, so a missing launcher binary or a
 * headless environment with no display is not an error condition here, just a no-op. Spawn
 * errors (e.g. ENOENT) arrive asynchronously via the child's `error` event, which is
 * deliberately left otherwise unhandled -- there is nothing more useful to do with it here.
 */
export function launchBrowser(url: string, deps: LaunchBrowserDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  const spawn = deps.spawn ?? nodeSpawn;
  const { command, args } = commandFor(platform, url);

  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    // Swallow: see the doc comment above.
  });
  child.unref();
}
