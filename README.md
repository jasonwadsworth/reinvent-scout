# reinvent-scout

Sign in with AWS Builder ID, sync the re:Invent session catalog to your machine, and search it
offline. This is phase 1 of three: a CLI you can use standalone today, with a repo profiler and
matcher (phase 2) and an MCP server plus agent skill (phase 3) landing in later PRs on top of it.

## What's here right now

- `auth login` / `auth logout` / `auth status` -- sign in once with AWS Builder ID (PKCE, no
  password ever touches this tool) and check your session.
- `catalog sync` -- pull the full session catalog for an event and build a local search index.
- `catalog search` / `catalog show` -- search and inspect that catalog entirely offline, with no
  network access once it's synced.

Repo profiling, session matching, the schedule, the MCP server and the agent skill are not in this
part of the codebase yet -- they're phase 2 and phase 3.

## Requirements

- Node.js `>=22.13.0`.
- A terminal that can open a URL in your default browser (macOS, Linux, or Windows). If it can't,
  every command that would open one prints the URL too, so you can open it by hand.

## Install

```
git clone <this repo>
cd re-invent-helper
npm install
npm run build
```

Run it directly:

```
node dist/cli/main.js --help
```

Or put `reinvent-scout` on your `PATH`:

```
npm link
reinvent-scout --help
```

## Sign in

```
reinvent-scout auth login
```

Opens your browser to sign in with AWS Builder ID via PKCE (no client secret -- there isn't one to
leak; the OAuth client id in this tool's source is a public identifier by design, the same way a
browser's own OAuth client id is public). If a browser can't be opened automatically, the same URL
is printed so you can open it yourself. The command waits for you to finish signing in, then
stores your session and exits.

```
reinvent-scout auth status
```

Reports whether you're signed in, how long until your access token needs a silent refresh (the
token itself is never printed), and whether you're registered for the event.

```
reinvent-scout auth logout
```

Clears the stored session.

## Sync the catalog

```
reinvent-scout catalog sync
```

Pulls every session for the event (`reinvent2026` by default) and builds a local search index.
Options:

- `--event <id>` -- sync a different event (Summits use this too).
- `--no-abstracts` -- skip session abstracts for a smaller, faster sync.
- `--reindex` -- rebuild the local search index from the already-downloaded catalog without
  contacting the API again (useful after an upgrade that changes how the index is built).
- `--json` -- machine-readable output.

A sync never touches the previously-stored catalog until every page has been pulled successfully,
so a failed sync (network trouble, not being registered for the event) leaves what you had intact.

## Search the catalog

```
reinvent-scout catalog search "step functions" --type "Chalk talk"
```

Searches session titles and abstracts (weighted so a title match ranks higher), and can be
narrowed with:

- `--type <type>` -- e.g. `"Breakout session"`, `"Chalk talk"`, `"Workshop"`.
- `--venue <venue>` -- e.g. `"Venetian"`, `"Caesars Palace"`.
- `--level <band>` -- a single level band (`200`) or a range (`100-300`).
- `--day <date>` -- `YYYY-MM-DD`.
- `--limit <n>` -- cap the number of results (default 20).
- `--include-abstracts` -- include each session's abstract text in the output.
- `--json` -- machine-readable output; abstracts are always omitted here unless
  `--include-abstracts` is also given, so a search never bloats past what you actually asked for.

```
reinvent-scout catalog show ABC123
```

Shows one session's full local detail (including its abstract) by session id.

## Where your data lives

Everything is stored under `~/.reinvent-scout/` (override with the `REINVENT_SCOUT_HOME`
environment variable, which every command and test respects). Inside:

- `tokens.json` -- your session, at file mode `0600` (readable only by you). No token, refresh
  token, or authorization code is ever logged, printed, or included in an error message.
- `catalog/` -- the synced catalog: raw session data, the derived search index, and sync metadata
  (schema version, when it synced, how many sessions). The directory and everything in it is
  created at mode `0700`.

Nothing here is ever sent anywhere except to AWS's own event API and OAuth endpoints.
