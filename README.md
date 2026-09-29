# reinvent-scout

Sign in with AWS Builder ID once, sync the re:Invent session catalog to your machine, and let an
agent (Claude Code, or anything else that speaks MCP) profile your repository, rank the catalog
against it with a reason for every match, and manage your schedule -- all through a local MCP
server and skill this CLI also installs. Everything that can be deterministic (auth, the catalog,
scoring, schedule writes) lives in the CLI; the one genuinely judgment-heavy step -- reading a
repository and deciding what it's built with -- is left to the agent, backed by file evidence it
cites itself.

This build includes sign-in, the catalog, agent-authored profiles, matching through `all`,
`explain`, `fix`, and `next-level`, schedule favorites, the MCP server, and the agent skill.
Reservation writes and a time-conflict-free dry-run planner are also available. Fix maps cited architecture gaps to remediation
sessions; Next-level offers named migration paths with gains and costs.

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
- `schedule show` / `schedule favorite` / `schedule unfavorite` -- read your real schedule and
  manage favorites, resolved against the local catalog.
- `mcp` -- run all of the above as a local MCP server over stdio, for an agent to call directly.
- `skill install` / `skill update` -- install the agent skill that drives the MCP tools (Claude
  Code by default, `--dir` for any other agent), and update it later without losing a local edit.

## Requirements

- Node.js `>=22.13.0`.
- A terminal that can open a URL in your default browser (macOS, Linux, or Windows). If it can't,
  every command that would open one prints the URL too, so you can open it by hand.
- An AWS Builder ID (free) to sign in with -- create one at the browser prompt during `auth login`
  if you don't already have one.

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

Three runtime dependencies: `commander` (the CLI itself), `zod` (validating an agent-authored
profile and an installed skill's manifest), and `@modelcontextprotocol/sdk` (the `mcp` command's
stdio server) -- the last one alone brings roughly ninety transitive packages with it (measured
directly: a bare `npm install @modelcontextprotocol/sdk` in an empty project pulls 91), by far the
biggest share of what `npm install` downloads here.

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
reinvent-scout catalog show ARC325
```

Prints the session's title, one line per sitting in time order -- its abbreviation, its real
session id, day, time, and venue/room -- and its abstract, by either a session id or an
abbreviation, matched case-insensitively so you can paste exactly what `catalog search` showed you.
Some talks repeat on a later day under a suffixed abbreviation (`ARC325-R`, `ARC325-R1`); `catalog
show` also accepts the **bare base code** with the suffix removed (`ARC325`) and resolves it to the
earliest sitting, with every other sitting folded into the same listing -- this matters because
`match`'s own output prints a candidate's base code, not any one sitting's abbreviation, so you need
to be able to paste that back in directly. This is real output, from the real catalog:

```
Serverless at 1M RPS: Lambda, DynamoDB & SQS Scaling Lessons
  ARC325-R -- 1780442233390001cyew -- 2026-12-02 -- 13:30 -- Caesars Forum -- Level 1 | Alliance 314
  ARC325-R1 -- 1790358237453001iwA0 -- 2026-12-03 -- 10:00 -- Caesars Palace -- Caesars Palace | Promenade Level | Trevi
We push Lambda, DynamoDB, and SQS to one million requests per second and share what breaks. Learn partition-aware DynamoDB design for extreme write throughput, ...
```

A session with no repeats prints just its own single line. The rest of the record -- type, level,
and the `relatedAbbreviations` field itself -- is only in the `--json` output; the human-readable
form above is deliberately just the sittings and the abstract, not the full record.

## Validate and save a repo profile

This tool doesn't profile a repository itself -- an agent (via the skill installed below) reads the
repo and writes a **tech profile**: a small JSON document naming the services and architecture
patterns it found, each backed by file evidence. This tool validates that document and resolves its
service names against the catalog.

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
notes, interests, and intents). Each candidate carries a `score` and a list of `reasons`, plus every
scheduled `offerings` (day, time, venue, room), so you (or an agent) can see exactly why a session
was suggested and when to actually attend it, not just that it was suggested -- this is real output,
from the profile example above run against the real catalog:

```
ARC325 -- Serverless at 1M RPS: Lambda, DynamoDB & SQS Scaling Lessons -- [Chalk talk] -- (score: 76.96)
  - Uses Amazon DynamoDB, which this session covers.
  - Matches the topic "Serverless".
  - Text overlap on: dynamodb, lambda, serverless.
  Offerings:
    2026-12-02 -- 13:30 -- Caesars Forum -- Level 1 | Alliance 314
    2026-12-03 -- 10:00 -- Caesars Palace -- Caesars Palace | Promenade Level | Trevi
```

The real catalog repeats many talks on more than one day, under a suffixed abbreviation
(`ARC325-R`, `ARC325-R1` above). `match` groups those into a single candidate by its base `code`
(`ARC325`), so asking for thirty candidates gets thirty genuinely different talks rather than the
same one occupying several slots -- both of `ARC325`'s real sittings show up under `offerings`
above, a day apart and in different venues. A candidate's own `score` and `reasons` come from its
best-scoring sitting (never a sum across repeats -- they're the same talk, not independent
signals), and `--limit` counts these grouped candidates, not raw sittings. `catalog search`, by
contrast, is left ungrouped: it's a raw listing of the catalog, not a ranked set of choices to pick
between.

`--profile` takes either a file path or a name previously saved with `profile save` -- whichever
it is, it's resolved through the exact same validation and catalog-name resolution `profile
validate` uses. Options:

- `--lens <lens>` -- `all` (default, no restriction) or `explain`, which narrows results to
  foundational and intermediate sessions (level bands 100 and 200) and favors lecture-style formats
  (`Breakout session`, `Chalk talk`) -- the shape of session that best suits someone new to a
  service or pattern. A session with no level on record at all is excluded under `explain`, the
  same way `catalog search --level` already treats an unknown level band, since there's no evidence
  either way that it qualifies. `fix` selects sessions addressing evidenced gaps; `next-level`
  selects sessions about supported migration destinations. These two lenses have no level or
  format preference and leave `all`/`explain` behavior unchanged.
- `--limit <n>` -- cap the number of candidates (default 30, maximum 100).
- `--include-abstracts` -- include each session's abstract text in the output.
- `--json` -- machine-readable output: an array of resolved sessions, each with its own `score`
  and `reasons`, with the scorer's internal term-frequency data always stripped and abstracts
  included only under `--include-abstracts`.

A profile with nothing in common with any session in the catalog returns an empty list, not every
session at a score of zero -- an empty result is a real, distinguishable outcome from "everything
matched equally."


### Fix and Next-level lenses

```sh
reinvent-scout match --profile my-profile.json --lens fix
reinvent-scout match --profile my-profile.json --lens next-level --json
```

Fix supports `gap-no-dlq` (Reliability), `gap-no-alarms` and `gap-no-tests` (Operational
Excellence), `gap-broad-iam` (Security), `gap-no-load-tests` (Performance Efficiency),
`gap-no-cost-monitoring` (Cost Optimization), and `gap-no-resource-rightsizing` (Sustainability).
These are our curated mappings using the [AWS six-pillar vocabulary](https://docs.aws.amazon.com/wellarchitected/latest/framework/the-pillars-of-the-framework.html),
not a complete Well-Architected assessment. Cite the nearest relevant code and explain the
inspected scope; absence means “not evident in the cited scope,” not proven absent everywhere.

Next-level supports three evidence-bearing source patterns:

- `serverless` → containers: runtime control versus operational ownership.
- `ecs` → EKS: Kubernetes portability/ecosystem versus cluster/platform complexity.
- `genai-single-call` → agentic: multi-step tool use versus latency, cost, evaluation, and control requirements.

Each is an exploration option. A service dependency or issue requesting a migration is not enough
to establish the current architecture. Intent, including open issues, can motivate an evidenced
option but does not prove a gap or authorize a migration. Unknown pattern names remain valid,
but only exact supported names (case-insensitive) activate a rule. No active rule or no actual
remediation/destination catalog signal means zero candidates. Source-service overlap only ranks
sessions after admission. Each distinct rule adds 30 points once; ordinary profile relevance
adds its own reasons. Repeated patterns and citations cannot inflate a rule's weight.

Catalog signals establish subject coverage, not migration direction: a reverse-direction talk
can qualify. Inspect the session abstract before treating a result as guidance for a particular path.

New `pillarGap` and `migrationPath` reasons carry optional `profileEvidence` with the original
repo/file/line, snippet and note, while `evidence` remains the matched catalog signal. The human
CLI prints source locations. MCP keeps complete reasons and drops whole candidates if necessary
to honor its existing response budget. Phrase signals use titles and available abstracts; a
catalog synced without abstracts can miss an abstract-only signal. See the complete synthetic
[profile and executable examples](skills/reinvent-scout/reference/workflow.md#evidence-lens-example)
and [profiling guidance](skills/reinvent-scout/reference/profiling.md#supported-evidence-lenses).


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
reinvent-scout schedule favorite <session-id> [<session-id> ...]
```

Favorites one or more sessions by their real session id. It's present in every command's `--json`
output as the `sessionId` field, and `catalog show`'s human-readable output (above) prints it
directly on each sitting's own line too, so a person reading it can paste it straight in --
`reinvent-scout catalog show ARC325` followed by `reinvent-scout schedule favorite
1790358237453001iwA0` favorites the second sitting shown above. `catalog search` and `match` still
print only the shorter abbreviation or grouped `code`, since those exist for browsing a list, not
for pasting one id into `favorite`. When a script needs an id with no person reading the output,
pull it out of `--json` with `jq` instead:

```
reinvent-scout schedule favorite "$(reinvent-scout catalog show ARC325-R1 --json | jq -r .sessionId)"
```

Requests are chunked at ten ids per call (the API's own limit) and paced to stay within the write
quota, and every outcome is reported: which ids succeeded, which were already favorited (not
treated as a failure), and which were refused and why -- including, for a scheduling conflict, the
conflicting sessions' titles. After writing, it reads your schedule back once and warns if anything
the API reported as favorited doesn't actually show up, so a response you can't fully trust never
gets reported as a clean success. The command exits non-zero if any session was refused.

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

### Plan and reserve

Start with offering IDs from a catalog lookup or match result, in your preferred order:

```sh
reinvent-scout schedule plan <offering-id> [<offering-id> ...] --json
```

The dry-run planner reads the full schedule and expands repeats, selecting the earliest feasible
sitting for each talk. Reservations and personal time block overlapping sessions; favorites do
not. It uses the event's real timezone and refuses to claim `conflictFree` when hard-commitment
times are unknown. This is greedy time-only planning: no seat guarantee, travel check, or global
optimization. The local catalog must match the requested event. The plan never writes anything.

Review the plan and confirm the actual `selected[].sessionId` values before reserving:

```sh
reinvent-scout schedule reserve <selected-session-id> [<selected-session-id> ...] --json
reinvent-scout schedule show
```

Plan/reserve accept a single `-` for newline-separated IDs on stdin. All three new commands accept
`--event <id>` and `--json`. Lists are capped at 50 IDs; reservation IDs are 1–128 characters and
are deduplicated before 10-ID chunks. Reserve reports every newly successful, already scheduled,
failed, uncertain, and not-attempted ID, then reconciles against the schedule. Partial/uncertain
results retain their complete JSON ledger and return failure status. A read-back failure never
erases acknowledged writes. Observed reservations do not prove an uncertain request created them.

Reservations are scheduled to open October 8, 2026, but API 409 is authoritative: stop when closed.
There is no automatic replacement of conflicts and no blind replay after an ambiguous POST 500,
503 or network failure. A later retry needs an explicit request and rechecking still-missing IDs.
For an explicitly chosen cancellation:

```sh
reinvent-scout schedule cancel <reserved-session-id> --json
```

Cancellation distinguishes acknowledged 204, already-absent 404, and uncertainty, with independent
schedule verification. Reserve/favorite each spend their own 30-session rolling-minute quota;
cancel/unfavorite each have a separate 30-request quota. A 1-second margin and serialized in-process
windows help avoid bursts; concurrent processes still rely on API 429 handling.

MCP exposes `plan_schedule`, `reserve_sessions`, and `cancel_reservation` with the same domain
behavior. Write responses never drop requested IDs/outcomes to fit 30 KiB: optional descriptions
may be marked shortened, conflict lists carry explicit omitted counts, and oversized mandatory
ledgers are rejected before writing. See the [complete contracts](skills/reinvent-scout/reference/workflow.md#reservation-workflow).


## Run the MCP server

```
reinvent-scout mcp
```

Runs a local [MCP](https://modelcontextprotocol.io) server over stdio, so an agent (Claude Code,
or anything else that speaks MCP) can call `reinvent-scout` directly instead of shelling out to the
CLI. It never writes anything but protocol traffic to its stdout; every diagnostic goes to stderr.

Seven tools are registered, and every one of them holds its response to a 30 KB budget -- the
catalog and the attendee's own data stay local; only a bounded summary ever reaches agent context:

- `status` -- signed-in state and local catalog state. Call this first.
- `catalog_sync` -- returns counts only, never session data.
- `validate_profile` -- resolves an agent-authored profile's service names against the catalog.
- `match_sessions` -- ranks the catalog against a resolved profile. At any limit or profile
  richness, a response that would exceed the budget is truncated in ranked order, never
  mid-candidate, with `truncated`/`returned`/`requested`/`omitted` and a `hint` reporting what was
  cut.
- `get_schedule` -- reserved sessions, favorites and personal time, merged into one list and
  paginated with `limit`/`offset` (default 50, cap 60) plus `total`/`totals`/`returned`/
  `nextOffset` -- unlike `match_sessions`, nothing here is ever dropped permanently: a page too
  large for the budget is shortened and `nextOffset` reflects exactly what was returned, so paging
  through it always reaches everything. Every entry carries a common `startsAt`/`endsAt` (a real
  UTC instant, via `catalog sync`'s own `GetEvent` call for the event's IANA timezone) alongside
  its raw kind-specific fields, and the list is sorted by `startsAt` -- this is what lets a
  personal-time block and a session sort correctly against each other across a day boundary,
  something raw local date/time alone can't do. When the event's timezone is unknown (the API
  didn't report one), sessions fall back to `startsAt: null` and sort by their raw local date and
  time instead; the response then carries a `warnings` entry explaining that ordering across kinds
  is unreliable in that case.
- `favorite_sessions` -- up to fifty ids, chunked and paced, with per-session outcomes and resolved
  conflict titles. A response carrying a refusal is never reported as a plain success.
- `unfavorite_session`.

### Connect it to Claude Code

```
claude mcp add --scope user reinvent-scout -- reinvent-scout mcp
```

Or, if you'd rather not put `reinvent-scout` on your `PATH`, point it at the built entry point
directly (use an absolute path):

```
claude mcp add --scope user reinvent-scout -- node /absolute/path/to/re-invent-helper/dist/cli/main.js mcp
```

`--scope user` is what makes this available in every project, not just whichever directory you
happen to run `claude mcp add` from -- `claude mcp add`'s own default scope (`local`) is scoped to
the current project only, which would defeat the point for a tool meant to profile *any* repo you
point an agent at. Either way adds an entry to your user-level MCP config. To check it into a
project instead (so anyone who clones the project gets the same server configured), add it to a
`.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "reinvent-scout": {
      "command": "reinvent-scout",
      "args": ["mcp"]
    }
  }
}
```

Any other MCP-speaking agent (Kiro, or anything else) configures a stdio server the same way --
point it at `reinvent-scout mcp` (or the built `main.js mcp` path above), no extra flags or
environment variables needed. It reads and writes the same `~/.reinvent-scout/` store the CLI
itself uses, so signing in and syncing once from the CLI (or letting the skill run `auth login`
itself) is enough for both.

## Install the agent skill

```
reinvent-scout skill install
```

Installs the `reinvent-scout` skill -- `SKILL.md` and its `reference/` files -- into Claude Code's
default skills directory (`~/.claude/skills`), so an agent knows how to profile a repository, call
the MCP tools above, and present matched sessions with evidence. Use `--dir <path>` to install
into another agent's skills directory instead (Claude Code's own path can't be assumed for every
agent, so it's never guessed):

```
reinvent-scout skill install --dir /path/to/other/skills
```

Refuses rather than overwriting anything if a skill (or just a conflicting file) is already at the
target -- `skill update` (below) owns every decision about touching an existing install.

To pick up a newer version of the skill later, without losing a file you edited locally:

```
reinvent-scout skill update
```

Compares the new build's exact file set and content against what's installed -- if nothing
changed, it reports up to date and touches nothing; a version bump alone with identical content is
not treated as a reason to rewrite anything, and unchanged version numbers never mask a real content
change either. Otherwise, every tracked file is checked against the hash recorded at install time:
one that still matches is safely overwritten with the new content, one that's changed since (a
local edit) refuses the *entire* update and names every file it found modified, so nothing is
silently lost -- including a file the new version is about to start shipping for the first time
under a name you already have on disk, untracked. Pass `--force` to overwrite local edits anyway,
and `--dir` to match wherever `skill install` put it.

`skill update` never performs a fresh install itself -- run `skill install` first if nothing is
there yet, or if the target directory is empty. If the directory exists with content but was never
tracked by this tool at all (hand-copied, or the manifest deleted), `update` refuses and tells you
to either run it again with `--force` (which adopts the directory -- installs the skill's own files
into it and starts tracking them, leaving anything else already there alone) or remove the directory
and run `skill install` instead.

## How it works

**The catalog is synced locally and never passed through agent context, on purpose.** The full
re:Invent catalog is over 2,000 sessions -- hundreds of thousands of tokens even without abstracts.
Handing that to an agent on every turn (or even once, to "look something up") would burn a
significant chunk of a conversation's context on data that's mostly irrelevant to any one question.
`catalog sync` pulls it once into a local, indexed store; every MCP tool response is held to a
30 KB budget (measured on the real wire format, not just the JSON text) and reports a bounded,
already-ranked or already-paginated slice -- a few dozen candidates from `match_sessions`, one page
of a schedule from `get_schedule` -- never the raw catalog itself. `catalog search`/`catalog show`
exist specifically so a human (or an agent that wants one more specific lookup) can query it
directly without that ever meaning "send the whole thing somewhere."

**This CLI runs its own local MCP server instead of using the official `api.awsevents.com/mcp`
server.** Two reasons, both load-bearing rather than incidental: first, the official server would
mean signing in twice -- once for the CLI's own catalog sync and schedule writes, once more for
whatever the official server's own auth flow requires -- when one PKCE sign-in, stored once and
reused by both the CLI and this server, is strictly simpler and is exactly what `skill install` and
the skill's own flow are built around. Second, and more fundamentally: a remote MCP server has no
way to enforce the local-only, budgeted-response design above -- it would have to either pass the
full catalog through agent context on a lookup, or build the same local-indexing story this CLI
already has, at which point it isn't a "the API can do it for you" server anymore. Building a local
server over the same 12-operation REST API everything else in this project already talks to keeps
one code path responsible for both.

**API surface used today:** `GetEvent` (the event's IANA timezone, for `get_schedule`'s common
`startsAt`/`endsAt`), `ListSessions` (paginated to build the catalog), `GetSchedule`,
`AssociateFavorites`, `DisassociateFavorite`, `ReserveSessions`, and `CancelReservation`. Not yet used: `ListEvents` (the event id is a
CLI/tool argument, defaulting to `reinvent2026`, rather than something this build discovers),
`GetSession` (a single session lookup -- `catalog show` reads the local index instead), and the
personal-time-management operations (`Create`/`Update`/`DeletePersonalTime`). Reservation writes
are implemented; whether the service accepts them is decided by its current response, not a
local date gate.

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
