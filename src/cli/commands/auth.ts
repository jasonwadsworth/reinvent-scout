import type { Command } from "commander";
import { createApiClient, type ApiClient } from "../../api/client.js";
import { login as loginFlow, type LoginDeps } from "../../auth/login.js";
import { createTokenProviderAdapter } from "../../auth/provider-adapter.js";
import { clearTokens, readTokenStore } from "../../auth/token-store.js";
import { DEFAULT_EVENT_ID } from "../../catalog/sync.js";
import { AuthRequiredError, NotRegisteredError } from "../../core/errors.js";
import { ensureStoreRoot } from "../../core/paths.js";

export interface AuthCommandDeps {
  /** Defaults to the real store root (`ensureStoreRoot`). Inject a fixed path in tests so
   * nothing touches the real home directory. */
  resolveStoreRoot?: () => string;
  /** Defaults to building a real `ApiClient` over the real token provider and the global
   * `fetch`. Inject a fake in tests so nothing touches the network. */
  buildApiClient?: (storeRoot: string) => ApiClient;
  /** Where command output goes. Defaults to stdout. */
  print?: (message: string) => void;
  /** Defaults to `Date.now`. Used only to compute the relative "expires in/ago" duration for
   * `status`. */
  now?: () => number;
  /** Defaults to `src/auth/login.ts`'s real `login`. Inject a fake in tests so nothing launches
   * a real browser, starts a real callback server, or waits on a real callback. */
  login?: (deps: LoginDeps) => Promise<void>;
}

interface StatusCommandOptions {
  event: string;
}

function defaultBuildApiClient(storeRoot: string): ApiClient {
  return createApiClient({ getAccessToken: createTokenProviderAdapter({ storeRoot }) });
}

/** Formats a millisecond offset from now as a short relative duration -- "in 47m 12s" or
 * "3m 4s ago". Never given the token itself, only a numeric offset, so there is nothing here
 * that could leak token material even by accident. */
function formatRelativeDuration(offsetMs: number): string {
  const totalSeconds = Math.round(Math.abs(offsetMs) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  let value: string;
  if (hours > 0) {
    value = `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    value = `${minutes}m ${seconds}s`;
  } else {
    value = `${seconds}s`;
  }

  return offsetMs >= 0 ? `in ${value}` : `${value} ago`;
}

/** Registers `auth` and its `login`, `logout` and `status` subcommands. */
export function registerAuthCommands(program: Command, deps: AuthCommandDeps = {}): Command {
  const print = deps.print ?? ((message: string) => process.stdout.write(`${message}\n`));
  const resolveStoreRoot = deps.resolveStoreRoot ?? (() => ensureStoreRoot());
  const buildApiClient = deps.buildApiClient ?? defaultBuildApiClient;
  const runLogin = deps.login ?? loginFlow;
  const now = deps.now ?? Date.now;

  const auth = program.command("auth").description("Sign in, sign out, and check your session.");

  auth
    .command("login")
    .description("Sign in with AWS Builder ID.")
    .action(async () => {
      const storeRoot = resolveStoreRoot();
      // Login failures (a provider error, a state mismatch, a timeout waiting for the callback,
      // a non-JSON token response) are varied enough, and login.ts's own errors already carry
      // clear messages, that there is no single small set of "friendly" cases worth special-
      // casing here the way sync and status do -- this deliberately propagates to the CLI's
      // top-level handler (src/cli/main.ts's main()), which already prints just the message and
      // exits 1 rather than a raw stack trace.
      await runLogin({ storeRoot, print, now });
      print("Signed in.");
    });

  auth
    .command("logout")
    .description("Sign out and clear the stored session.")
    .action(() => {
      const storeRoot = resolveStoreRoot();
      clearTokens({ storeRoot });
      print("Signed out.");
    });

  auth
    .command("status")
    .description("Show whether you're signed in and registered for the event.")
    .option("--event <id>", "the event to check registration for", DEFAULT_EVENT_ID)
    .action(async (options: StatusCommandOptions) => {
      const storeRoot = resolveStoreRoot();
      const state = readTokenStore({ storeRoot });

      if (state.status === "absent") {
        print("Not signed in. Run `reinvent-scout auth login`.");
        process.exitCode = 1;
        return;
      }
      if (state.status === "corrupt") {
        print(
          "Your stored session could not be read. Run `reinvent-scout auth login` to sign in again.",
        );
        process.exitCode = 1;
        return;
      }

      const expiresAt = state.tokens.obtainedAt + state.tokens.expiresIn * 1000;
      print(`Signed in. Access token expires ${formatRelativeDuration(expiresAt - now())}.`);

      const apiClient = buildApiClient(storeRoot);
      try {
        await apiClient.getSchedule(options.event);
        print(`Registered for ${options.event}.`);
      } catch (err) {
        // Both name the exact situation and (for AuthRequiredError) the exact fix; everything
        // else is a real bug or outage and should surface with its full detail.
        if (err instanceof NotRegisteredError) {
          // NotRegisteredError's own message is deliberately generic ("this event"), since the
          // API client that throws it has no event id to name -- the CLI does, so it says which
          // event, matching how the sync command already names the event in its own summary.
          print(
            `You're signed in, but not registered for ${options.event}. Signing in again ` +
              "will not help; register for the event first.",
          );
          process.exitCode = 1;
          return;
        }
        if (err instanceof AuthRequiredError) {
          print(err.message);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  return auth;
}
