import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { toCommandError, type CommandError } from "../commands/errors.js";
import { registry, type CommandName } from "../commands/registry.js";
import { resolveStoreRoot } from "../core/paths.js";

/** Replaced with package.json's version by the bundler; unbundled runs (tests) fall back. */
declare const __VERSION__: string | undefined;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-unbundled";

export interface ScriptIo {
  /** Reads all of stdin. */
  readStdin: () => string;
  env: NodeJS.ProcessEnv;
}
export interface ScriptResult {
  /** Exactly one JSON document and a newline. */
  stdout: string;
  exitCode: 0 | 1 | 2;
}

const done = (value: unknown, exitCode: 0 | 1 | 2): ScriptResult => ({ stdout: `${JSON.stringify(value)}\n`, exitCode });
const usageError = (message: string): ScriptResult => done({ error: message } satisfies CommandError, 2);
const isCommandName = (name: string): name is CommandName => Object.hasOwn(registry, name);

/** Reads and parses the input: `--json` (a small one-line object), `--input` (a file, or `-` for stdin), or nothing for `{}`. A bad file or bad JSON
 * is a usage error whose message never quotes the content. */
function readInput(json: string | undefined, path: string | undefined, io: ScriptIo): { value: unknown } | { error: string } {
  if (json !== undefined && path !== undefined) return { error: "Pass either --json or --input, not both." };
  if (json !== undefined) {
    try { return { value: JSON.parse(json) as unknown }; }
    catch { return { error: "--json is not valid JSON." }; }
  }
  if (path === undefined) return { value: {} };
  let text: string;
  try { text = path === "-" ? io.readStdin() : readFileSync(path, "utf8"); }
  catch { return { error: path === "-" ? "Could not read stdin." : "Could not read the --input file." }; }
  try { return { value: JSON.parse(text) as unknown }; }
  catch { return { error: "The input is not valid JSON." }; }
}

/** Runs one command and returns what to print and the exit code. Pure apart from the store the
 * command itself reads and writes; the only I/O of its own is `io`. */
export async function runScript(argv: readonly string[], io: ScriptIo): Promise<ScriptResult> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, options: { input: { type: "string" }, json: { type: "string" }, help: { type: "boolean" }, version: { type: "boolean" } } });
  } catch (err) {
    return usageError(err instanceof Error ? err.message : "Invalid arguments.");
  }
  if (parsed.values.version) return done({ version: VERSION }, 0);
  if (parsed.values.help) {
    return done({ usage: "reinvent-scout.mjs <command> [--json '<one-line JSON>' | --input <file> | --input -]", commands: Object.entries(registry).map(([name, entry]) => ({ name, description: entry.description })) }, 0);
  }
  const [name, ...extra] = parsed.positionals;
  if (name === undefined) return usageError("Name a command. Run with --help for the list.");
  if (extra.length > 0) return usageError("Expected a single command name.");
  if (!isCommandName(name)) return usageError(`Unknown command "${name.slice(0, 64)}". Run with --help for the list.`);
  const input = readInput(parsed.values.json, parsed.values.input, io);
  if ("error" in input) return usageError(input.error);
  const entry = registry[name];
  try {
    const checked = entry.inputSchema.parse(input.value);
    const run = entry.run as (input: unknown, deps: { storeRoot: string }) => unknown;
    return done(await run(checked, { storeRoot: resolveStoreRoot({ env: io.env }) }), 0);
  } catch (err) {
    return done(toCommandError(err), 1);
  }
}

const result = await runScript(process.argv.slice(2), { readStdin: () => readFileSync(0, "utf8"), env: process.env });
process.stdout.write(result.stdout);
process.exitCode = result.exitCode;
