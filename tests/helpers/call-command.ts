import { toCommandError } from "../../src/commands/errors.js";
import { registry, type CommandName } from "../../src/commands/registry.js";

export interface CallCommandOptions {
  storeRoot: string;
  now?: () => number;
  randomId?: () => string;
}

/** Runs one registry command and returns `{ text, isError, reason? }`: the same output the script
 * prints. On error, `text` is the script's `error` field and `reason` is its `reason`, if any. */
export async function callCommand(name: CommandName, input: unknown, options: CallCommandOptions): Promise<{ text: string; isError: boolean; reason?: string }> {
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
    const { error, reason } = toCommandError(err);
    return { text: error, isError: true, ...(reason === undefined ? {} : { reason }) };
  }
}
