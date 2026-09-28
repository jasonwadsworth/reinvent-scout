import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const builtEntry = join(repoRoot, "dist", "cli", "main.js");

/**
 * THIS is the real guard on stdout purity, not the in-process capture test in
 * tests/mcp/server.test.ts. That one is real but partial: it can only ever prove that *this test
 * process's own* direct `process.stdout.write` calls would be caught -- it cannot see `console.*`
 * output at all (Node's `Console` holds its own bound reference to the stream, captured at
 * construction, so replacing `process.stdout.write` afterward -- by spy or reassignment --
 * intercepts nothing routed through it), and it cannot see a dependency writing straight to file
 * descriptor 1 either (the SDK's own dependency tree pulls in ~90 packages -- express, hono,
 * cross-spawn among them -- none used by the stdio transport, but nothing rules out one of them
 * writing to fd 1 below any in-process capture). Spawning the real built server as a real
 * subprocess and reading its actual stdout pipe is the only method that catches all three
 * failure modes, and it's also how the server actually runs in production. See
 * gotcha_vitest_spyon_process_stdout_write.md.
 *
 * Builds fresh before spawning -- `npm run check` runs build after test, so relying on whatever
 * `dist/` happens to contain from a previous run (or nothing, on a clean checkout) would either
 * test stale code or fail to find the entry point at all.
 */
beforeAll(() => {
  execFileSync("npx", ["tsc"], { cwd: repoRoot, stdio: "pipe" });
}, 30_000);

interface JsonRpcLine {
  raw: string;
  parsed: { jsonrpc?: unknown; id?: unknown; [key: string]: unknown } | null;
}

interface SpawnedServer {
  lines: JsonRpcLine[];
  send: (message: Record<string, unknown>) => void;
  waitForId: (id: number) => Promise<Record<string, unknown>>;
  stop: () => void;
}

function spawnServer(env: NodeJS.ProcessEnv): SpawnedServer {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [builtEntry, "mcp"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const lines: JsonRpcLine[] = [];
  const waiters = new Map<number, (msg: Record<string, unknown>) => void>();
  let buffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const raw = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (raw.length === 0) {
        continue;
      }
      let parsed: JsonRpcLine["parsed"] = null;
      try {
        parsed = JSON.parse(raw) as JsonRpcLine["parsed"];
      } catch {
        // Recorded as a raw line with parsed: null -- the purity assertion below is what turns
        // this into a test failure; capturing it here rather than throwing lets that assertion
        // report every offending line, not just the first.
      }
      lines.push({ raw, parsed });
      const id = typeof parsed?.id === "number" ? parsed.id : undefined;
      if (id !== undefined && waiters.has(id)) {
        waiters.get(id)!(parsed as Record<string, unknown>);
        waiters.delete(id);
      }
    }
  });

  return {
    lines,
    send: (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    waitForId: (id) =>
      new Promise((resolve) => {
        waiters.set(id, resolve);
      }),
    stop: () => {
      child.kill();
    },
  };
}

async function driveOneToolCall(server: SpawnedServer): Promise<Record<string, unknown>> {
  server.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "purity-test-client", version: "0.0.0" },
    },
  });
  await server.waitForId(1);
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  server.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status", arguments: {} } });
  return server.waitForId(2);
}

/** Also drives `get_schedule` (id 3) -- task 6's tools are a separate code path (a different
 * module, `src/schedule/schedule.ts`, and the real `ApiClient`/token provider construction the
 * `status` tool never reaches) that the lint rule alone doesn't prove is clean; with no session
 * stored, the token provider throws `AuthRequiredError` before any real network call, so this
 * stays fast and hermetic while still exercising the schedule tool's own handler and error path. */
async function driveScheduleToolCall(server: SpawnedServer): Promise<Record<string, unknown>> {
  await driveOneToolCall(server);
  server.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "get_schedule", arguments: {} },
  });
  return server.waitForId(3);
}

describe("MCP server stdout purity (real subprocess)", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  /** No captured frame's own text content may read as commander/MCP's own "I could not find this"
   * response -- a tool-not-found error is itself a perfectly well-formed JSON-RPC frame (valid
   * JSON, `jsonrpc: "2.0"`, a matching `id`), so checking only frame shape would pass identically
   * whether the tool under test exists or was renamed out from under the test. Reviewer's finding
   * against this file's first version: the schedule half asserted exactly that shape and stayed
   * green with `get_schedule` entirely unregistered, proving nothing about task 6's own code path.
   * Applied to every captured line, protecting `status` from the same latent hole too. */
  function assertNoToolNotFoundFrame(lines: JsonRpcLine[]): void {
    for (const line of lines) {
      expect(line.raw, `frame reads as a tool-not-found error: ${line.raw}`).not.toMatch(
        /Tool \w+ not found/,
      );
    }
  }

  it("writes only newline-delimited JSON-RPC to stdout across a real initialize and tool call", async () => {
    const server = spawnServer({ ...process.env, REINVENT_SCOUT_HOME: home.path });
    try {
      const toolResponse = await driveOneToolCall(server);

      expect(server.lines.length).toBeGreaterThan(0);
      for (const line of server.lines) {
        // Every line must parse as JSON at all, and carry "jsonrpc": "2.0" -- not merely be valid
        // JSON (a stray `console.log(JSON.stringify({...}))` would pass a bare JSON.parse check
        // but have no jsonrpc field, which is exactly the gap this second assertion closes).
        expect(line.parsed, `line did not parse as JSON: ${line.raw}`).not.toBeNull();
        expect(line.parsed!.jsonrpc, `line missing jsonrpc field: ${line.raw}`).toBe("2.0");
      }
      assertNoToolNotFoundFrame(server.lines);

      // A purity test that only checked the shape of whatever the server happened to print could
      // pass against a server that emits nothing but an error frame -- assert the actual response
      // to the tool call we drove is among the captured lines, not just that every line is clean.
      expect((toolResponse as { id?: unknown }).id).toBe(2);
      expect(server.lines.some((line) => line.parsed?.id === 2)).toBe(true);
    } finally {
      server.stop();
    }
  }, 15_000);

  it("stays pure across a schedule tool call too, not just status", async () => {
    // Reviewer's ask: the lint override covers src/mcp/**, but the subprocess purity guard is
    // what actually catches a stray write, and it needs to run against task 6's own code path
    // (src/schedule/**, and the real ApiClient construction status never reaches), not just the
    // one tool task 4 originally wrote this test against.
    const server = spawnServer({ ...process.env, REINVENT_SCOUT_HOME: home.path });
    try {
      const scheduleResponse = await driveScheduleToolCall(server);

      for (const line of server.lines) {
        expect(line.parsed, `line did not parse as JSON: ${line.raw}`).not.toBeNull();
        expect(line.parsed!.jsonrpc, `line missing jsonrpc field: ${line.raw}`).toBe("2.0");
      }
      assertNoToolNotFoundFrame(server.lines);
      expect((scheduleResponse as { id?: unknown }).id).toBe(3);
      expect(server.lines.some((line) => line.parsed?.id === 3)).toBe(true);

      // The decisive assertion, per the reviewer's finding: a well-formed JSON-RPC frame alone
      // (even the general "no tool-not-found" guard above) does not prove get_schedule's own
      // handler actually ran -- only its real, amendment-3-specific wording does. With no session
      // stored, the token provider throws AuthRequiredError before any network call, so this text
      // is exactly what the real handler (and nothing else) produces.
      const scheduleContent = (scheduleResponse as { result?: { content?: Array<{ text?: string }> } })
        .result?.content?.[0]?.text;
      expect(scheduleContent).toContain(
        "No signed-in session found. Run `reinvent-scout auth login` (the skill can run it for you)",
      );
    } finally {
      server.stop();
    }
  }, 15_000);
});
