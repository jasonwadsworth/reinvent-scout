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

describe("MCP server stdout purity (real subprocess)", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

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

      // A purity test that only checked the shape of whatever the server happened to print could
      // pass against a server that emits nothing but an error frame -- assert the actual response
      // to the tool call we drove is among the captured lines, not just that every line is clean.
      expect((toolResponse as { id?: unknown }).id).toBe(2);
      expect(server.lines.some((line) => line.parsed?.id === 2)).toBe(true);
    } finally {
      server.stop();
    }
  }, 15_000);
});
