import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readPackageVersion } from "../cli/version.js";
import { registerTools, type McpToolDeps } from "./tools.js";

/**
 * Builds an `McpServer` with every implemented tool registered, but does not connect it to any
 * transport -- `runStdioServer` does that for the real stdio entry point, while tests connect an
 * `InMemoryTransport` pair directly (see tests/mcp/server.test.ts) so the protocol machinery runs
 * in-process without spawning anything.
 */
export function createMcpServer(deps: McpToolDeps): McpServer {
  const server = new McpServer({ name: "reinvent-scout", version: readPackageVersion() });
  registerTools(server, deps);
  return server;
}

/**
 * Connects the server to the real stdio transport and runs until the transport closes (the
 * client disconnects, or stdin ends). This is the one function on the real, unbounded stdin/
 * stdout streams -- everything else in `src/mcp/**` only ever touches the abstract `Transport`
 * the SDK hands it, never `process.stdin`/`process.stdout` directly, so `src/cli/commands/mcp.ts`
 * (which calls this) is the only place those streams are touched at all outside the SDK itself.
 */
export async function runStdioServer(deps: McpToolDeps): Promise<void> {
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
