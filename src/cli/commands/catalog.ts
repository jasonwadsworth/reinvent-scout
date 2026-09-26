import type { Command } from "commander";
import { createApiClient, type ApiClient } from "../../api/client.js";
import { createTokenProviderAdapter } from "../../auth/provider-adapter.js";
import { DEFAULT_EVENT_ID, syncCatalog, type SyncResult } from "../../catalog/sync.js";
import { AuthRequiredError, NotRegisteredError } from "../../core/errors.js";
import { ensureStoreRoot } from "../../core/paths.js";

export interface CatalogCommandDeps {
  /** Defaults to the real store root (`ensureStoreRoot`). Inject a fixed path in tests so
   * nothing touches the real home directory. */
  resolveStoreRoot?: () => string;
  /** Defaults to building a real `ApiClient` over the real token provider and the global
   * `fetch`. Inject a fake in tests so nothing touches the network. */
  buildApiClient?: (storeRoot: string) => ApiClient;
  /** Where command output goes. Defaults to stdout. */
  print?: (message: string) => void;
  /** Stamped as the new meta's `syncedAt` on a full sync. Defaults to `Date.now`. */
  now?: () => number;
}

interface SyncCommandOptions {
  event: string;
  abstracts: boolean;
  reindex: boolean;
  json: boolean;
}

function defaultBuildApiClient(storeRoot: string): ApiClient {
  return createApiClient({ getAccessToken: createTokenProviderAdapter({ storeRoot }) });
}

function formatHumanSummary(result: SyncResult): string {
  const lines = [
    `Synced ${result.count} session${result.count === 1 ? "" : "s"} for ${result.eventId}.`,
  ];
  if (result.reindexed) {
    lines.push("Rebuilt the local index from the already-stored catalog without contacting the API.");
  }
  if (result.totalCountMissing) {
    // Distinct from countMismatch (which is always false in this case, since there's nothing
    // real to compare `count` against): the server not reporting a total at all is a more
    // serious signal than a mismatch, and must not be silent just because the mismatch check
    // had nothing to flag.
    lines.push(
      "Warning: the server did not report a total session count. Unable to check whether the " +
        "full catalog was stored.",
    );
  } else if (result.countMismatch) {
    lines.push(
      `Warning: the server reports ${result.totalCount} total sessions, but ${result.count} ` +
        "were stored. Some sessions may be missing from the local catalog.",
    );
  }
  return lines.join("\n");
}

/** Registers `catalog` and its `sync` subcommand. Task 16 adds `search` and `show` to the same
 * `catalog` command group returned here. */
export function registerCatalogCommands(program: Command, deps: CatalogCommandDeps = {}): Command {
  const print = deps.print ?? ((message: string) => process.stdout.write(`${message}\n`));
  const resolveStoreRoot = deps.resolveStoreRoot ?? (() => ensureStoreRoot());
  const buildApiClient = deps.buildApiClient ?? defaultBuildApiClient;

  const catalog = program
    .command("catalog")
    .description("Manage the local re:Invent session catalog.");

  catalog
    .command("sync")
    .description("Pull the session catalog and build the local search index.")
    .option("--event <id>", "the event to sync", DEFAULT_EVENT_ID)
    .option("--no-abstracts", "exclude session abstracts from the synced catalog")
    .option(
      "--reindex",
      "rebuild the local index from the already-stored catalog without contacting the API",
    )
    .option("--json", "print machine-readable JSON instead of a human-readable summary")
    .action(async (options: SyncCommandOptions) => {
      const storeRoot = resolveStoreRoot();
      const apiClient = buildApiClient(storeRoot);

      try {
        const result = await syncCatalog({
          apiClient,
          storeRoot,
          eventId: options.event,
          includeAbstracts: options.abstracts,
          reindex: options.reindex,
          ...(deps.now === undefined ? {} : { now: deps.now }),
        });

        print(options.json ? JSON.stringify(result) : formatHumanSummary(result));
      } catch (err) {
        // Both of these are the two specific, actionable failures a user can hit here -- give
        // each its own message rather than letting a raw stack trace reach the terminal.
        // Everything else (a network error, a 5xx after retries, a programmer error) is a real
        // bug or outage and should surface with its full detail, so it is deliberately rethrown.
        if (err instanceof AuthRequiredError || err instanceof NotRegisteredError) {
          print(err.message);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  return catalog;
}
