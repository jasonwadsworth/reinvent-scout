# reinvent-scout

A Claude Code plugin that finds the re:Invent sessions your code points at, and helps you plan and
reserve them. It is a skill, one bundled script that keeps the 2,000-session catalog in a local index
(so it never fills the conversation), a catalog-sync agent, and a declaration of the official AWS Events
MCP, which handles every call to AWS: the catalog pull, your schedule, favorites and reservations.
The one judgment-heavy step, reading a repository and deciding what it is built with, is left to the
agent, backed by file evidence it cites itself.

## Install

```text
/plugin marketplace add jasonwadsworth/reinvent-scout
/plugin install reinvent-scout@reinvent-scout
```

It runs where Claude Code runs with a local shell and a persistent home directory (Claude Code, the
Code tab of Claude Desktop, or the Agent SDK) and Node.js `>=22.13.0`. The AWS sign-in opens in your
browser on localhost port 8484; the first AWS call starts it. Sign-in tokens belong to the AWS Events
MCP, not to this plugin.

Then ask for sessions for your repo, or "sync the re:Invent catalog".

### If you already have an `awsevents` server

You may keep your own `awsevents` entry. Claude Code treats a
plugin server and a user server at the same endpoint as one: with the exact URL `https://api.awsevents.com/mcp`
in your entry you get one connection (yours), and the tools are named `mcp__awsevents__AWSEventsPublicApi-Mcp-prod___<Name>`; otherwise they
are `mcp__plugin_reinvent-scout_awsevents__AWSEventsPublicApi-Mcp-prod___<Name>`. The skill accepts either. With any other spelling of the
URL (another path, a query string, a non-default port) there are two servers and two sign-ins, one after the
other; use the exact URL in your own entry to avoid that. The permission rules below list both names for the same reason.

## Permissions

A plugin cannot ship permission rules, so add this once to
`~/.claude/settings.json`. It lets the skill, the bundled script and the read-only AWS tools run without asking, under
both server names (see above). The writes (`ReserveSessions`, `CancelReservation`, `AssociateFavorites`,
`DisassociateFavorite`) are deliberately not listed: they keep their prompt, which is also your confirmation.
Replace `<your-claude-dir>` with the absolute path of your Claude config directory, for example `/Users/you/.claude` (it is
`~/.claude` unless you set `CLAUDE_CONFIG_DIR`), written out in full. The script rule appears twice, with and without quotes
around the path, because a rule only matches the command text it was written with. It is anchored on purpose: a wildcard before the
path would also approve `node --require ...` or `node -e ...` with that path in it, and a wildcard for the version could be
stretched with `../` to a same-named script elsewhere, so the version is written out. After you update the plugin, change `0.1.0`
to the installed version (until you do, the script asks before it runs, which is the safe failure).

```json
{
  "permissions": {
    "allow": [
      "Skill(reinvent-scout:reinvent-scout)",
      "Bash(node \"<your-claude-dir>/plugins/cache/reinvent-scout/reinvent-scout/0.1.0/skills/reinvent-scout/scripts/reinvent-scout.mjs\" *)",
      "Bash(node <your-claude-dir>/plugins/cache/reinvent-scout/reinvent-scout/0.1.0/skills/reinvent-scout/scripts/reinvent-scout.mjs *)",
      "mcp__plugin_reinvent-scout_awsevents__AWSEventsPublicApi-Mcp-prod___ListEvents",
      "mcp__plugin_reinvent-scout_awsevents__AWSEventsPublicApi-Mcp-prod___GetEvent",
      "mcp__plugin_reinvent-scout_awsevents__AWSEventsPublicApi-Mcp-prod___ListSessions",
      "mcp__plugin_reinvent-scout_awsevents__AWSEventsPublicApi-Mcp-prod___GetSession",
      "mcp__plugin_reinvent-scout_awsevents__AWSEventsPublicApi-Mcp-prod___GetSchedule",
      "mcp__awsevents__AWSEventsPublicApi-Mcp-prod___ListEvents",
      "mcp__awsevents__AWSEventsPublicApi-Mcp-prod___GetEvent",
      "mcp__awsevents__AWSEventsPublicApi-Mcp-prod___ListSessions",
      "mcp__awsevents__AWSEventsPublicApi-Mcp-prod___GetSession",
      "mcp__awsevents__AWSEventsPublicApi-Mcp-prod___GetSchedule"
    ]
  }
}
```

## Use the skill

Ask in plain words: "which re:Invent sessions fit this repo?", "sync the re:Invent catalog", "what
chalk talks are at the MGM Grand on Tuesday?", "build me a conflict-free schedule from these talks".
The skill reads your repository, writes a **tech profile**, and calls the bundled script's commands
(`validate_profile`, `match_sessions` and the rest) for the local work, and the AWS Events MCP for the
rest.

### Writing a profile

An agent reads the repo and writes a profile: a small JSON document naming the services and
architecture patterns it found, each backed by file evidence. `validate_profile` checks it and resolves
its service names against the catalog:

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

`services[].name` can be spelled any way a person or an LLM naturally would: a short key (`dynamodb`),
the catalog's own display name (`Amazon DynamoDB`), an SDK package name (`@aws-sdk/client-dynamodb`), a
CDK submodule path, a Java or Go import, or a Terraform resource type. **Every
service and every pattern must carry at least one evidence entry**, or the profile is rejected and the
error names the entry that is missing one. A service the catalog has no counterpart for is reported as
unresolved, not dropped and not an error.

### Match sessions to your profile

`match_sessions` finds the sessions about what your code is built on: a session is admitted only when it
names one of the profile's services or patterns (or one of its stated `interests`) in its title or
abstract, and candidates are ranked by how central those concepts are to your code. Each candidate
carries a `why` (the concepts it matches, where your code uses them, and the session's own sentence that
says so, `sessionSays`, preferring one about what you will learn, build or see over the abstract's
opener), a `score` and `reasons`, plus every scheduled `offerings` (day, time and end time when the
catalog has a length, venue, room; overlap and "can I attend both" are `plan_schedule` questions, never
guessed from the times). A repeated talk is one candidate under its base `code`, with every sitting in
`offerings`. A profile with nothing in common with any session returns an empty list, not every
session at a score of zero.

### Map your code, then choose what to look for

Plain lenses rank everything the profile touches. To get a short list about what *you* care about, call
`map_profile` first, then `match_sessions` with a `focus` of topics and, for each, a goal. The map lists
what the profile found, grouped as services, patterns, gaps (supported rules, with their Well-Architected
pillar) and next steps (migration paths, or ones skipped because you already made the move). Each topic
has an id (`service:Amazon DynamoDB`, `pattern:event-driven`, `gap:gap-no-dlq`,
`path:genai-single-call`), a one-line note, where your code uses it, and the goals that apply with how
many sessions each would return (0 is a dead end):

- **understand**: introductory sessions (level 100/200) about the service or pattern, from the Explain lens.
- **deepen**: sessions at any level whose *title names the topic*, from the All lens, leaving out the ones it demotes.
- **improve**: for a gap, every session the Fix lens admits for that one rule; for a next step, the Next-level lens's.

A `focus` takes one to six `{ topic, goal }` choices and lists up to `perTopic` (default 3, at most 3)
sessions per choice, each with its `why`. A session listed under an earlier choice is left out of later
ones and notes `alsoMatches`. `focus` replaces `lens` and `limit`. The map names the platform services
the profile has and leaves out by design, so the skill shows a "Not shown" line naming the platform
services (S3, KMS, CDK, CloudWatch, ...).

#### Only the levels you want

`preferences: { levels: { min, max } }` on `match_sessions` and `map_profile` keeps only sessions at
those level bands (100 Foundational, 200 Intermediate, 300 Advanced, 400 Expert, 500 Distinguished; a
session with no level is left out). It applies to every lens, the map and a focus, and does not change a
session's own score: filtering removes sessions, the remaining ones are re-ranked by the same rules, and
a list is filled from the ones in range. `understand` and the `explain` lens are introductory (100-200),
so above 200 `explain` is refused (use `deepen` or `all`) and `understand` shows 0 with the reason. When
the range empties a result, it says so ("4 sessions match, none at 400-500").

#### Chalk talks more than anything, no workshops, only this venue

Rules by any catalog field: `preferences: { levels, rules: [{ field, value, action, levels? }] }`. The
fields are `format`, `venue`, `day`, `topic`, `area`, `industry` and `role`; a value is any case or a
unique prefix (`chalk`, `mgm`); the actions are `only`, `prefer`, `avoid` and `exclude`, and a rule's
`levels` limits it to those bands. Several `only` on one field are a union, on different fields an
intersection, and a session with no value for the field is left out; `exclude` removes sessions like a
level range. `prefer` and `avoid` only reorder: within a field the first matching rule decides, across
fields the effects add up, and the sessions with the highest sum come first, ahead of every other
consideration except that demoted sessions still come last, so a preferred session outranks a neutral one
even if it matches less strongly. A `why` names every preference that moved a session ("a chalk talk at
MGM Grand, which you prefer"). The map counts under `only`, `exclude` and `levels`, not under `prefer` and `avoid`.

#### What can I filter on?

`list_filters` lists each field's values with how many talks have each (a repeat counts once), most
first, from the local catalog. `list_filters` with `field: "venue"` returns one field's whole list. A value
that does not resolve is an error listing the catalog's values.

### Lenses

`match_sessions` takes a `lens`: `all` (the default), `explain`, `fix` or `next-level`.

- **all**: sessions about what your code is built on, at any level and in any format. Sponsored, news or
  launch, customer-story, modernization, industry and off-topic agent sessions and sessions about a
  technology the code does not use are not dropped but follow the rest, each with a `demoted` reason.
- **explain**: introductory sessions (levels 100 and 200) about the services and patterns the profile
  evidences, round-robin across concepts, most-cited first. The response also carries `uncovered`, the
  concepts no introductory session is about, each with a reason.
- **fix**: sessions addressing evidenced gaps. It supports `gap-no-dlq` (Reliability), `gap-no-alarms`
  and `gap-no-tests` (Operational Excellence), `gap-broad-iam` (Security), `gap-no-load-tests`
  (Performance Efficiency), `gap-no-cost-monitoring` (Cost Optimization) and
  `gap-no-resource-rightsizing` (Sustainability). These are curated mappings using the
  [AWS six-pillar vocabulary](https://docs.aws.amazon.com/wellarchitected/latest/framework/the-pillars-of-the-framework.html),
  not a complete Well-Architected assessment: cite the nearest code and explain the inspected scope;
  absence means "not evident in the cited scope," not proven absent.
- **next-level**: sessions about supported migration destinations: `serverless` to containers, `ecs` to
  EKS, and `genai-single-call` to agentic, each an exploration option with its gains and costs. Intent,
  including an open issue, can motivate an option but does not prove a gap or authorize a migration.

Fix and Next-level have no level or format preference. Catalog signals establish subject coverage, not
migration direction: a reverse-direction talk can qualify, so read the abstract before treating a result
as guidance. Every candidate carries `why`; the script keeps `why` and the lens reasons complete and,
to fit its output budget, drops every candidate's ranking reasons first (`rankingReasonsOmitted`), then
whole candidates if necessary. See the [profile and executable
examples](plugin/skills/reinvent-scout/reference/workflow.md#evidence-lens-example) and the
[profiling guidance](plugin/skills/reinvent-scout/reference/profiling.md#supported-evidence-lenses).

### Plan and reserve

`plan_schedule` is a dry run: given offering ids in your preferred order and your AWS schedule, it expands
repeats and selects the earliest feasible sitting for each talk. Reservations and personal time block
overlapping sessions; favorites do not. It uses the event's real timezone, refuses to claim
`conflictFree` when hard-commitment times are unknown, and never writes. This is greedy time-only
planning: no seat guarantee, travel check or global optimization. Writes go through the AWS Events MCP
(`ReserveSessions`, `CancelReservation`, `AssociateFavorites`, `DisassociateFavorite`), only after you
confirm the exact ids, and each keeps its permission prompt. The skill reports every outcome, never
replays an ambiguous write, and reads your schedule back to see what landed. See the [reservation
workflow](plugin/skills/reinvent-scout/reference/workflow.md#reservation-workflow).

### Watch a full session

When a session you want is full, ask the agent to watch it. There is no watcher command: the agent polls
the live seat band with `GetSession` about every 3 minutes, using the client's own scheduling, and
reserves the moment a seat opens. Before it starts, it confirms the sessions and the exact reservations it
may cancel to make room (often none). It cancels only those, only when every clashing reservation is on
that list, and tries to put back anything it cancelled if the new session does not land. A swap briefly
frees your existing seat, and a restore refused as full means that seat is lost. Travel time between
venues is not checked. The rules it follows are in the
[watch playbook](plugin/skills/reinvent-scout/reference/watch.md).

### Nearby sessions on site

Confirm your current venue for **each call**, whether you named it, supplied location context, or inferred
it from a recent reservation. A schedule venue is only a suggestion of where you are. `nearby_sessions`
reads your complete reserved and personal schedule (from `GetSchedule`), checks outbound travel plus
check-in and travel to the next hard commitment, and asks for live reads of at most 20 locally eligible
sessions: its first call returns their ids in `refreshIds`, the skill reads each with `GetSession`, and a
second call with those sessions as `liveSessions` gives the shortlist. `skipSessionIds` ignores a
reservation for this calculation; it does not cancel it. Favorites do not block. Unknown timing or the next
commitment's unknown venue prevents a feasibility claim. Started, unscheduled and all-day sessions are
excluded. This is a conservative shortlist, not exhaustive live routing: travel values are hand-maintained
assumptions, with nonzero same-venue movement, not AWS published journey times. Bands are not seat counts
or admission guarantees. Results include age, refresh coverage and omissions.

Walk-up defaults to false. `get_onsite_preferences` reads the effective settings (and creates nothing);
`set_onsite_preferences` changes them. A patch can enable walk-up globally, override it per session in one
event, or reset an override with null:

```json
{"allowWalkUp":true,"sessionWalkUp":[{"sessionId":"<offering-id>","allowWalkUp":false}]}
```

Unknown admission appears only when walk-up is allowed, labeled uncertain. A reserved session can still be
recommended when its band is unavailable. An unreserved unavailable session cannot. Route patches replace
`routes` and use `{from,to,mode,minutes,waitMinutes?,windows?,peakBufferMinutes?}`; routes are directed.
`shuttleEnabled:true` also requires configured `shuttleWindows` (or route `windows`); no shuttle schedule is
inferred. Windows use `{start:"HH:MM",end:"HH:MM"}` in event-local time and can cross midnight. Defaults
are 10 minutes check-in and a 5-minute peak buffer during 08:00-10:00 and 16:00-18:00; override with
`checkInMinutes`, `peakWindows` and `peakBufferMinutes`. `freshnessMinutes` defaults to 5. A nearby result
never reserves anything: the skill presents the actual offering id and gets your confirmation before
`ReserveSessions`.

## How it works

**The catalog is never passed through agent context, on purpose.** The full re:Invent catalog is over
2,000 sessions: hundreds of thousands of tokens even without abstracts. Handing that to an agent on every
turn would burn a large part of a conversation on data that is mostly irrelevant to any one question. The
catalog-sync agent (`reinvent-scout:catalog-sync`) pages `ListSessions` from the AWS Events MCP, 250
sessions a page; each page is saved to a file by the tool result, and `catalog_import` reads that file, so
no page ever enters the conversation. A commit replaces the stored catalog only after a shrink guard (it
refuses an empty, partial or more-than-10%-smaller catalog unless you approve both counts), and records
what changed since the previous import (`catalog_changes`, and `status.lastImport`). Nothing but the
agent's brief and a short report passes through context.

**Every AWS call goes through the official AWS Events MCP** (`https://api.awsevents.com/mcp`), which the
plugin declares: the catalog pull, your schedule, favorites, reservations and live session reads. The
plugin has no sign-in, token or API client of its own. Its own code does only what keeping session data
out of context requires: the local index, search and matching.

**One script, thirteen commands.** The bundled script runs `status`, `catalog_import`, `catalog_changes`,
`lookup_sessions`, `search_sessions`, `validate_profile`, `map_profile`, `list_filters`, `match_sessions`,
`plan_schedule`, `nearby_sessions`, `get_onsite_preferences` and `set_onsite_preferences`. Each takes its
input as one JSON object (`--json '<one-line JSON>'`, or `--input <file>`) and prints one JSON document.
Each output is held to 24 KiB, because Claude Code's Bash output cap is 30,000 characters; a long answer is
shortened with explicit counts rather than cut.

## Where your data lives

Everything is stored under `~/.reinvent-scout/` (override with the `REINVENT_SCOUT_HOME` environment
variable). Inside:

- `catalog/`: the raw session records, the derived search index, the import metadata (schema version, when
  it was imported, how many sessions) and the last import's changes. The directory is created at mode
  `0700` and its files at `0600`.
- the import staging, kept for 24 hours so an approved commit needs no new pull;
- `onsite.json`: your on-site preferences, written atomically.

A `tokens.json` and a `profiles/` directory left by the earlier command-line tool can be deleted; the plugin
never reads them. The script sends nothing anywhere; AWS calls are the AWS Events MCP's.

## Development

```sh
npm ci
npm run check
```

`npm run check` runs the type check (over `src/` and `tests/`), lint, the tests, and `npm run bundle:verify`.
After any change under `src/`, run `npm run bundle` to rebuild the committed script
(`plugin/skills/reinvent-scout/scripts/reinvent-scout.mjs`); `bundle:verify` fails on a stale one, and CI
runs `check`. Validate the plugin with `claude plugin validate ./plugin --strict`. `CLAUDE.md` holds the
architecture rules.
