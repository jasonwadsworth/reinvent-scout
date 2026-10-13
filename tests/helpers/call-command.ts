import { registry, type CommandName } from "../../src/commands/registry.js";
import { toToolError } from "../../src/mcp/tools.js";

export interface CallCommandOptions {
  storeRoot: string;
  now?: () => number;
  randomId?: () => string;
}

/** Runs one registry command the way the MCP server does and returns the same `{ text, isError }`
 * shape the MCP tests read, so a ported test changes one line. */
export async function callCommand(name: CommandName, input: unknown, options: CallCommandOptions): Promise<{ text: string; isError: boolean }> {
  const entry = registry[name];
  try {
    const parsed = entry.inputSchema.parse(input) as never;
    const output = await (entry.run as (input: never, deps: unknown) => unknown)(parsed, {
      storeRoot: options.storeRoot,
      ...(options.now ? { now: options.now } : {}),
      ...(options.randomId ? { randomId: options.randomId } : {}),
    });
    return { text: JSON.stringify(output), isError: false };
  } catch (err) {
    return { text: toToolError(err).content[0].text, isError: true };
  }
}
