# reinvent-scout

Sign in with AWS Builder ID, sync the re:Invent session catalog to your machine, search it
offline, validate an agent-authored profile of your repository against it, and rank the catalog
against that profile with an explanation for every match. This is phase 1 and 2 of three: a CLI
you can use standalone today, with the schedule, an MCP server, and an agent skill (phase 3)
landing in later PRs on top of it.

## What's here right now

- `auth login` / `auth logout` / `auth status` -- sign in once with AWS Builder ID (PKCE, no
  password ever touches this tool) and check your session.
- `catalog sync` -- pull the full session catalog for an event and build a local search index.
- `catalog search` / `catalog show` -- search and inspect that catalog entirely offline, with no
  network access once it's synced.
- `profile validate` / `profile save` -- validate an agent-authored tech profile and resolve its
  service names against the catalog; save one under a name for later reuse.
- `match` -- rank the local catalog against a profile, offline, with a plain-language reason for
  every candidate.

The schedule, the MCP server and the agent skill are not in this part of the codebase yet -- they
land in phase 3.

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
reinvent-scout catalog show ANT301
```

Shows one session's full local detail (including its abstract), by either its session id or its
abbreviation -- the abbreviation is what `catalog search` prints, and matching it is
case-insensitive, so you can paste exactly what search showed you. (Real session ids are opaque,
e.g. `1780441461150001GGoc`; the abbreviation is what you'll actually have on hand.)

Some talks repeat on a later day under a suffixed abbreviation (`ARC325-R`, `ARC325-R1`). `catalog
show` also accepts the **bare base code** with the suffix removed (`ARC325`) and resolves it to the
earliest sitting -- this matters because `match`'s own output prints a candidate's base code, not
any one sitting's abbreviation, so you need to be able to paste that back in directly. Either way
you look a repeated talk up -- by its base code or by one specific sitting's own abbreviation -- the
result's `relatedAbbreviations` field (and, in the human-readable form, an "Also offered as: ..."
line) names every other sitting of the same talk, so you can find the one that fits your schedule.
A session with no repeats always reports an empty `relatedAbbreviations`.

## Validate and save a repo profile

Phase 2 doesn't profile a repository itself -- an agent (the phase 3 skill) reads the repo and
writes a **tech profile**: a small JSON document naming the services and architecture patterns it
found, each backed by file evidence. This tool validates that document and resolves its service
names against the catalog.

A profile looks like this:

```json
{
  "schemaVersion": 1,
  "repos": [{ "root": ".", "languages": ["typescript"] }],
  "services": [
    {
      "name": "dynamodb",
      "usage": "orders table",
      "evidence": [{ "repo": ".", "file": "src/db.ts", "line": 12 }]
    }
  ],
  "patterns": [
    {
      "name": "serverless",
      "note": "Lambda behind API Gateway",
      "evidence": [{ "repo": ".", "file": "src/stack.ts" }]
    }
  ]
}
```

`services[].name` can be spelled any way a person or an LLM naturally would -- a short key
(`dynamodb`), the catalog's own display name (`Amazon DynamoDB`), an SDK package name
(`@aws-sdk/client-dynamodb`), a CDK submodule path, a Java or Go import, or a Terraform resource
type (`aws_dynamodb_table`) -- it's resolved against the catalog regardless. **Every service and
every pattern must carry at least one evidence entry**, or the profile is rejected and the error
names the specific entry that's missing one.

```
reinvent-scout profile validate my-profile.json
```

Validates the file and resolves every service name, printing a summary (or the resolved profile
as JSON with `--json`). A service the catalog has no counterpart for is reported as unresolved,
not silently dropped -- and not treated as an error, since a real service (Amazon SNS, today) can
legitimately have no matching catalog session.

```
reinvent-scout profile save my-repo --from my-profile.json
```

Saves a validated profile under a name, so a later command can refer to it instead of a file path:

```
reinvent-scout profile validate --name my-repo --json
```

A profile name may only be a single safe path segment (letters, digits, dots, hyphens and
underscores, never starting or ending with a dot) -- it becomes part of a file path on disk, so an
unsafe name is refused outright rather than silently sanitized.

## Match sessions to your profile

```
reinvent-scout match --profile my-profile.json
```

Ranks every session in the local catalog against a profile and prints the candidates that share
at least one real signal with it -- an exact catalog service match, a topic or area-of-interest
match, or free-text overlap with the profile's own prose (service usage notes, pattern names and
notes, interests, and intents). Each candidate carries a `score` and a list of `reasons`, so you
(or an agent) can see exactly why a session was suggested, not just that it was:

```
API318 -- Deep dive into event-driven architectures with Lambda and Step Functions -- [Breakout session] -- (score: 100)
  - Uses AWS Lambda, which this session covers.
  - Uses AWS Step Functions, which this session covers.
```

The real catalog repeats many talks on more than one day, under a suffixed abbreviation
(`ARC325-R`, `ARC325-R1`). `match` groups those into a single candidate by its base `code`, so
asking for thirty candidates gets thirty genuinely different talks rather than the same one
occupying several slots. Every sitting still shows up, under `offerings`:

```
ARC325 -- Serverless at 1M RPS: Lambda, DynamoDB & SQS Scaling Lessons -- [Breakout session] -- (score: 127.37)
  - Uses AWS Lambda, which this session covers.
  - Uses Amazon DynamoDB, which this session covers.
  Offerings:
    2026-12-02 -- 13:30 -- Caesars Forum -- Level 1 | Alliance 314
    2026-12-03 -- 10:00 -- Caesars Palace -- Caesars Palace | Promenade Level | Trevi
```

A candidate's own `score` and `reasons` come from its best-scoring sitting (never a sum across
repeats -- they're the same talk, not independent signals), and `--limit` counts these grouped
candidates, not raw sittings. `catalog search`, by contrast, is left ungrouped: it's a raw listing
of the catalog, not a ranked set of choices to pick between.

`--profile` takes either a file path or a name previously saved with `profile save` -- whichever
it is, it's resolved through the exact same validation and catalog-name resolution `profile
validate` uses. Options:

- `--lens <lens>` -- `all` (default, no restriction) or `explain`, which narrows results to
  foundational and intermediate sessions (level bands 100 and 200) and favors lecture-style formats
  (`Breakout session`, `Chalk talk`) -- the shape of session that best suits someone new to a
  service or pattern. A session with no level on record at all is excluded under `explain`, the
  same way `catalog search --level` already treats an unknown level band, since there's no evidence
  either way that it qualifies. Later phases add a Fix lens (Well-Architected gaps) and a Next-level
  lens (migration paths) without changing how `explain` or `all` behave.
- `--limit <n>` -- cap the number of candidates (default 30, maximum 100).
- `--include-abstracts` -- include each session's abstract text in the output.
- `--json` -- machine-readable output: an array of resolved sessions, each with its own `score`
  and `reasons`, with the scorer's internal term-frequency data always stripped and abstracts
  included only under `--include-abstracts`.

A profile with nothing in common with any session in the catalog returns an empty list, not every
session at a score of zero -- an empty result is a real, distinguishable outcome from "everything
matched equally."

## Read your schedule and manage favorites

```
reinvent-scout schedule show
```

Reads your schedule from the API -- reserved sessions, favorites, and personal time blocks -- and
resolves each session id against the local catalog into its title, day, time, venue and room,
grouped by day. An id the local catalog has no record for (most often because it was favorited
before the last `catalog sync`) still shows up, as a bare id with a note, rather than silently
vanishing from your own schedule. `--event <id>` reads a different event; `--json` prints
machine-readable output, including each entry's `resolved: true|false` status.

```
reinvent-scout schedule favorite ANT301-SESSION-ID ARC325-SESSION-ID
```

Favorites one or more sessions by their real session id -- the `sessionId` field `catalog search`,
`catalog show` and `match` all print, not the human-readable abbreviation or `match`'s own grouped
`code`. Requests are chunked at ten ids per call (the API's own limit) and paced to stay within the
write quota, and every outcome is reported: which ids succeeded, which were already favorited
(not treated as a failure), and which were refused and why -- including, for a scheduling
conflict, the conflicting sessions' titles. After writing, it reads your schedule back once and
warns if anything the API reported as favorited doesn't actually show up, so a response you can't
fully trust never gets reported as a clean success. The command exits non-zero if any session was
refused.

A single `-` in place of session ids reads them from stdin instead, one per line -- the point of
this is piping `match`'s own output straight in:

```
reinvent-scout match --profile my-profile.json --json | jq -r '.[].sessionId' | reinvent-scout schedule favorite -
```

`--event <id>` targets a different event; `--json` prints the full machine-readable result. At most
100 ids are accepted in one invocation.

```
reinvent-scout schedule unfavorite SESSION-ID
```

Removes one session from your favorites. Removing a session that was never favorited (or already
removed) is reported plainly, not as an error -- there's nothing left to do either way.

## Where your data lives

Everything is stored under `~/.reinvent-scout/` (override with the `REINVENT_SCOUT_HOME`
environment variable, which every command and test respects). Inside:

- `tokens.json` -- your session, at file mode `0600` (readable only by you). No token, refresh
  token, or authorization code is ever logged, printed, or included in an error message.
- `catalog/` -- the synced catalog: raw session data, the derived search index, and sync metadata
  (schema version, when it synced, how many sessions). The directory and everything in it is
  created at mode `0700`.
- `profiles/` -- profiles saved with `profile save`, one file per name, at mode `0600`.

Nothing here is ever sent anywhere except to AWS's own event API and OAuth endpoints.
