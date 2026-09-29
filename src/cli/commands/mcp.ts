import type { Command } from "commander";
import { runStdioServer } from "../../mcp/server.js";
import { resolveStoreRoot as resolveRoot } from "../../core/paths.js";

/**
 * This is the one CLI entry point that shares stdout with the MCP protocol stream (JSON-RPC
 * traffic, newline-delimited -- see src/mcp/server.ts's `StdioServerTransport`), so nothing here
 * may write to stdout or call `console.*` -- `console.log`/`console.error` bypass even a direct
 * `process.stdout.write` capture entirely (Node's `Console` holds its own bound reference to the
 * stream), which is exactly why `no-console` is re-enabled for this specific file in
 * eslint.config.js even though the rest of `src/cli/**` is exempt from it. Any diagnostic this
 * file (or anything it calls) needs to emit must go through `process.stderr.write` instead.
 */
export interface McpCommandDeps {
  /** Defaults to the real store root (`resolveStoreRoot`, without creating it). Inject a fixed path in tests so
   * nothing touches the real home directory. */
  resolveStoreRoot?: () => string;
  /** Defaults to `mcp/server.ts`'s real `runStdioServer`, connecting to the real stdio transport.
   * Inject a fake in tests so nothing actually attaches to this process's real stdin/stdout. */
  runServer?: (deps: { resolveStoreRoot: () => string }) => Promise<void>;
}

/** Registers `mcp`, which runs the local MCP server over stdio until the client disconnects. */
export function registerMcpCommand(program: Command, deps: McpCommandDeps = {}): Command {
  const resolveStoreRoot = deps.resolveStoreRoot ?? (() => resolveRoot());
  const runServer = deps.runServer ?? runStdioServer;

  program
    .command("mcp")
    .description(
      "Run the local MCP server over stdio, for an agent (e.g. Claude Code) to connect to.",
    )
    .action(async () => {
      await runServer({ resolveStoreRoot });
    });

  return program;
}
