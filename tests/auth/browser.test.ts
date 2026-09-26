import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { launchBrowser, type SpawnOptions, type SpawnedProcess } from "../../src/auth/browser.js";

interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
}

function fakeSpawner(): {
  spawn: (command: string, args: string[], options: SpawnOptions) => SpawnedProcess;
  calls: SpawnCall[];
  child: SpawnedProcess & EventEmitter;
  unrefCalls: number;
} {
  const calls: SpawnCall[] = [];
  let unrefCalls = 0;
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    unref: () => {
      unrefCalls++;
    },
  });
  const spawn = (command: string, args: string[], options: SpawnOptions): SpawnedProcess => {
    calls.push({ command, args, options });
    return child;
  };
  return {
    spawn,
    calls,
    child,
    get unrefCalls() {
      return unrefCalls;
    },
  };
}

const URL_WITH_AMPERSAND = "https://oauth.awsevents.com/oauth2/authorize?a=1&b=2";

describe("launchBrowser", () => {
  it("spawns open with the url on darwin", () => {
    const fake = fakeSpawner();

    launchBrowser(URL_WITH_AMPERSAND, { platform: "darwin", spawn: fake.spawn });

    expect(fake.calls).toEqual([
      { command: "open", args: [URL_WITH_AMPERSAND], options: { stdio: "ignore", detached: true } },
    ]);
  });

  it("spawns xdg-open with the url on linux", () => {
    const fake = fakeSpawner();

    launchBrowser(URL_WITH_AMPERSAND, { platform: "linux", spawn: fake.spawn });

    expect(fake.calls).toEqual([
      { command: "xdg-open", args: [URL_WITH_AMPERSAND], options: { stdio: "ignore", detached: true } },
    ]);
  });

  it("spawns rundll32's url.dll FileProtocolHandler with the raw url on win32", () => {
    const fake = fakeSpawner();

    launchBrowser(URL_WITH_AMPERSAND, { platform: "win32", spawn: fake.spawn });

    // `cmd /c start <url>` would route the url through cmd.exe's own command-line parser,
    // which treats an unescaped `&` -- present in every OAuth authorize url -- as a command
    // separator. rundll32 opens the url in the system default browser directly, with no shell
    // in between to reinterpret it, so the url is passed through as one argv entry with nothing
    // to quote or escape.
    expect(fake.calls).toEqual([
      {
        command: "rundll32",
        args: ["url.dll,FileProtocolHandler", URL_WITH_AMPERSAND],
        options: { stdio: "ignore", detached: true },
      },
    ]);
  });

  it("falls back to xdg-open for platforms other than darwin and win32", () => {
    const fake = fakeSpawner();

    launchBrowser(URL_WITH_AMPERSAND, { platform: "freebsd", spawn: fake.spawn });

    expect(fake.calls[0]?.command).toBe("xdg-open");
  });

  it("unrefs the spawned child so it never keeps the process alive", () => {
    const fake = fakeSpawner();

    launchBrowser(URL_WITH_AMPERSAND, { platform: "darwin", spawn: fake.spawn });

    expect(fake.unrefCalls).toBe(1);
  });

  it("does not throw when the spawned child later emits an error", () => {
    const fake = fakeSpawner();

    expect(() =>
      launchBrowser(URL_WITH_AMPERSAND, { platform: "darwin", spawn: fake.spawn }),
    ).not.toThrow();

    // e.g. ENOENT when the launcher binary doesn't exist on this system, or a headless
    // environment with no display. This must never surface as an unhandled error or crash the
    // process -- the caller (src/auth/login.ts) already prints the URL as a fallback.
    expect(() => fake.child.emit("error", new Error("spawn open ENOENT"))).not.toThrow();
  });
});
