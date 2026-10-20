---
name: reinvent-scout
description: Finds re:Invent sessions relevant to a codebase by profiling the repo against the services and patterns it actually uses, matching that profile against the imported session catalog with evidence and reasons, and managing the attendee's own schedule through the AWS Events MCP. Use when the user wants re:Invent session recommendations for their repo or team, asks what talks to attend for their tech stack, or wants to review, favorite, reserve or watch sessions on their schedule.
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/scripts/reinvent-scout.mjs" *) Bash(node ${CLAUDE_SKILL_DIR}/scripts/reinvent-scout.mjs *)
---

# reinvent-scout

Recommends AWS re:Invent sessions for a codebase and manages the attendee's schedule for them. Two
things do the work: the AWS Events MCP (every call to AWS: the event, the sessions, the schedule,
favorites and reservations) and this plugin's bundled script, which keeps the session catalog in a
local index so you never read or reason over the raw catalog directly. The catalog stays out of your
context on purpose (over 2,000 sessions is far too much to hold in a conversation);
`match_sessions` is what turns it into a small, ranked, explained shortlist.

## How to run

**Local commands** go through one script. Pass the command's input as one JSON object: `--json '<one-line JSON>'`
for a small one (no apostrophes in it), or `--input <file>` for a larger one such as a profile (write the file first;
`--input -` reads stdin). Do not put JSON in a heredoc: Claude Code's Bash check rejects a brace beside a quote
there. A profile always goes in a file: write the whole input object (`{ "profile": ..., "preferences": ... }`) with the Write
tool, then pass that file with `--input`. The script prints exactly one JSON document, and on a failure `{"error": ...}` (exit code 1, or 2 for a usage
error):

```sh
node "${CLAUDE_SKILL_DIR}/scripts/reinvent-scout.mjs" list_filters --json '{"field":"venue"}'
```

AWS Events tools are `mcp__plugin_reinvent-scout_awsevents__AWSEventsPublicApi-Mcp-prod___<Name>`, or
`mcp__awsevents__AWSEventsPublicApi-Mcp-prod___<Name>` when your own `awsevents` server shadows the plugin's; use whichever is
available. The docs here write the bare operation name (`GetSchedule`). Every AWS tool except `ListEvents` takes `eventId`: pass `reinvent2026` unless the user names another event. They need no
sign-in of their own here: the first call opens the AWS sign-in in the browser. If one reports you are not signed in,
tell the user to complete it, and try again.

## When to use this skill

- "What re:Invent sessions should I go to for this repo/team?"
- "Find sessions relevant to our stack and add them to my schedule."
- "What's on my re:Invent schedule?" / "Show me my favorites."
- "Favorite/unfavorite session X." / "Reserve this for me." / "Watch this full session for a seat."

## The flow

1. Call `status`. It reports the local catalog (`missing`, `stale` with a `reason`, or `fresh`) and, while it
   still describes the stored catalog, `lastImport`: what the last import changed. It needs no sign-in. When the
   catalog is usable (`status.catalog.status` is `"fresh"`, or `"stale"` with `reason: "age"` and a
   `syncedAt` you are willing to use), go straight to profiling, mapping and matching. A catalog that is
   `"missing"`, or `"stale"` for `reason: "schema-version"` or `"corrupt"`, cannot be browsed yet (step 2).
2. Import the catalog when it is missing or stale: run the `reinvent-scout:catalog-sync` agent (it pulls the
   pages from AWS and commits them with `catalog_import`) and relay only its summary: the counts and what changed. The catalog never enters your
   context, and neither do its pages: do not call `ListSessions` yourself. If the agent reports
   `shrunk` (the new catalog is more than 10% smaller than the stored one), tell the user both counts and
   ask the user, with both counts, before passing `allowShrink`: if they approve, commit the staged import
   yourself with `catalog_import` `action: "commit"`, the same `syncId` and `allowShrink: true`. For
   `reason: "schema-version"` you do not need AWS at all: `catalog_import` with `action: "reindex"` rebuilds the index from
   what is stored (it asks for the event's `timezone` from `GetEvent` only for a catalog imported before
   timezones were stored). After an import, call `catalog_changes` with the ids on the user's schedule (see step 9) to say whether anything they plan to attend moved. For "sessions about X" with no repository, use `search_sessions` (query, format, venue, level range, day).
3. Read the repository (or repositories) the user wants matched and write a profile object,
   following `reference/profiling.md` exactly -- what to read, how to cite evidence, how to name
   services and patterns, and what to do with absences and open issues.
4. Call `validate_profile` with the profile. Its response is a compact *report* on what resolved
   (service names, pattern names, unresolved names, counts) -- not the profile itself, and not
   something to pass anywhere else. Fix anything it flags as a schema error (it names the
   offending entry) and validate again. An unresolved service name is not an error -- keep going,
   but it's worth a passing mention to the user. Then call `map_profile` with the same profile and
   **show the user the map** (and, when `omittedPlatformServices` is not empty, the one line saying which platform services are not shown and why, so the user does not think they were missed): one line per topic, grouped as services, patterns, gaps and next steps,
   each with the goals that have sessions (`understand` for introductions, `deepen` for sessions at
   any level, `improve` for a gap or a next step). Offer only goals with sessions, and say plainly when a
   topic has none for a goal (its `reason` may name the closest 300-level session). Then **ask what they care about**: up to about five topics and a goal for each, in
   plain words ("understand DynamoDB, improve the dead-letter gap"). Do not guess for them.
5. Call `match_sessions` with **the profile you wrote in step 3** -- never with `validate_profile`'s
   own report, which is a different, smaller shape `match_sessions` doesn't accept -- and, when the
   user chose, a `focus`: their choices as `{ "topic": <id from the map>, "goal": ... }` (one to six;
   `perTopic` caps each list, at most 3, default 3). That returns a short ranked list per choice. `focus` replaces
   `lens` and `limit`; send one or the other. If the user just wants recommendations and does not want to choose,
   fall back to a lens. Default to the
   `"all"` lens (the sessions about the services and patterns their code is built on, any level; a
   candidate with a `demoted` reason is a sponsored, news, customer-story, modernization, industry,
   off-topic agent or off-stack technology session, so say so when you present it) unless the user wants foundational sessions (`"explain"`, which also returns
   `uncovered`: concepts of their code with no introductory session), evidenced gap
   remediation (`"fix"`), or migration options (`"next-level"`). Fix uses only supported,
   evidence-bearing gap patterns; Next-level uses `serverless`, `ecs`, or `genai-single-call`.
   See the exact vocabulary and trade-offs in `reference/profiling.md`.
   When the user states a level or a filter (no workshops, only MGM, nothing on Thursday), or asks what they can filter on (`list_filters`), pass it as `preferences` on `map_profile` and `match_sessions`:
   [reference/workflow.md](reference/workflow.md#session-preferences) has the rules, and you read it before applying any.
6. Present the candidates to the user. Lead each one with its title, format and level, then
   `why.summary` and, when present, the `why.sessionSays` quote; cite `why.yourCode` (repo, file and
   line, plus `why.more` cut ones) so the user can open the code, then every `offerings` entry
   (when and where each sitting happens, with its `endTime` when it has one). Never judge yourself whether two sessions overlap or whether the user can attend both: that is a
   `plan_schedule` question, whatever the times look like, and `plan_schedule` needs the schedule from `GetSchedule` (step 7). Do not read out ranking `reasons` unless the user asks.
   If the response came back `truncated`, say so and offer to narrow the request
   (a narrower lens or a more specific profile -- **not** a smaller `limit`, which only returns
   fewer of the exact same top-ranked candidates and can never reach the ones already omitted)
   rather than silently showing a partial list as if it were everything. A focused response is
   grouped per choice (`results[]`, each with its `topic`, `goal` and candidates): present it the same
   way, one heading per choice, sessions led by their `why`; say how many more there are when `total`
   exceeds what is listed, say why when a choice has none (`reason`), and mention `alsoMatches` when
   a session serves another choice too.
7. For reservations, call `GetSchedule` immediately before, then pass the whole `schedule` object to `plan_schedule`
   along with a priority-ordered shortlist of offering IDs (`plan_schedule` never calls AWS itself).
   Present its selected offerings, alternatives, refusals and time-only limits. Ask for confirmation before reserving
   those exact returned IDs with `ReserveSessions`, at most 10 ids per call. A plan never reserves seats or proves travel
   feasibility. Read every `failed` entry of the result and report each failed or uncertain ID. A 409 means reservations are closed: stop. On a 429, pause and try again later. Never automatically replay an
   uncertain write: call `GetSchedule` to see what landed, explain that observed state is not proof of what
   caused it, and ask before any later retry. Use `CancelReservation` only for an explicitly
   chosen cancellation; never cancel conflicts automatically.
   Exception (see `reference/watch.md`): inside a watch the user confirmed, the may-cancel list is the explicit choice of
   cancellations and the running watch is the standing request for re-attempts. Outside a watch,
   these rules hold.
8. Ask for confirmation before favoriting anything. On confirmation, call `AssociateFavorites` with
   the chosen session ids, at most 10 ids per call; on a 429, pause and continue later. Report every outcome plainly: a `failed` entry is a real refusal
   (`insufficientAccess`, or an unknown code) and must be reported as one, while `alreadyFavorited` is harmless: say so. Favorites do not conflict with the schedule, so never
   smooth a failure over as a success. Check with `GetSchedule` that the favorites stuck.
9. Call `GetSchedule` to see what's on the schedule now, and resolve the ids on a `GetSchedule` result with `lookup_sessions`
   (titles, venue, room, and `startsAt`/`endsAt` in UTC; personal time from AWS is already UTC, so sort everything by those instants). Show the user the
   relevant entries. When the user wants an abstract, use `lookup_sessions` with `includeAbstract` (at most 10 ids). Use `DisassociateFavorite` if the user wants a favorite removed,
   and confirm with another `GetSchedule` if it matters to them.
10. For on-site choices, read `get_onsite_preferences`; use `set_onsite_preferences` for requested
    local changes. Confirm the current venue on this call, then call `GetSchedule` and `nearby_sessions` with its `schedule`:
    the first call returns `refreshIds`; read each with `GetSession`, one at a time (skip any that fails), then call `nearby_sessions` again with the same input plus
    `liveSessions` (the `session` objects you read). Present both travel legs, admission uncertainty and refresh coverage before any reservation.
11. Watch a full session. When a session the user wants is full, offer to watch it: call
    `GetSession` for its live seat band (`seatAvailability`; one read, reserves nothing, and a 404
    is not proof the session is gone), and reserve when a seat opens. Confirm the targets and the
    exact reservations you may cancel to make room before you start; that confirmation is the only
    consent to cancel anything. Follow `reference/watch.md` for the loop, the state to carry and the
    swap rules.

`reference/workflow.md` has the exact input and output shape for every command above, the sync protocol,
and what each error means and how to react to it.

## Presenting reasons and evidence

A candidate's `why` is what to say about it: `summary` (what it covers, in the profile's own
words), `yourCode` (the profile's citations for it) and `sessionSays` (a sentence the session
itself says, quoted, absent when nothing can be quoted). Lead with it; it is built from the profile
you wrote and the session's text, so it is as good as your notes and citations are. Its
`reasons` are the ranking reasons (`service`, `topic`, `areaOfInterest`, `text`, `level`,
`format`): a shared service or matched wording says why the session ranked where it did, not why it
is worth attending, so do not read them out unless the user asks how the ranking works. Each
reason's own `evidence` field (see `reference/workflow.md`) is the matched catalog value, not a
file. Fix and Next-level reasons (`pillarGap`, `migrationPath`) also carry `profileEvidence` with
every source that admitted the session; when `why.summary` names only the strongest (the first on a tie) of several rules
(`(+N more)`), mention the others from those reasons. If a response came back with
`rankingReasonsOmitted`, the ranking reasons were dropped to fit the budget; `why` is unaffected.
`why.yourCode` is the traceability that agent-authored, evidence-backed profiles buy over a black-box
score.

Say “not evident in the cited scope” for an absence; this is not proof the whole system lacks it.
Describe migration paths as options with gains and costs, never automatic upgrades.
Catalog signals establish subject coverage, not migration direction. Before presenting a migration
option, inspect its abstract with `lookup_sessions` and `includeAbstract` and explain whether the session
explores that direction, the reverse direction, or a comparison.
Open issues are intent: connect a relevant issue to an already cited gap/path in your presentation; issue
prose does not establish a gap or authorize a migration. Fix picks are leads, not verdicts: a session can pass the stack and phrase gates while
mentioning a gap or your services only in passing, so read each pick's abstract (`lookup_sessions` with `includeAbstract`)
before presenting it and drop the ones that do not really address the gap. When `skippedRules` is
non-empty, say why that path produced nothing. Unsupported patterns produce no
candidates under these lenses. Source-service overlap ranks eligible sessions but cannot admit
one without the actual remediation or destination signal.

## What this build does not do

- No deterministic repository scanning -- you read the repository and write the profile yourself,
  per `reference/profiling.md`. There is no `profile_repo` tool.
- Never hold the full catalog, or a large slice of it, in your own context. `match_sessions`,
  `lookup_sessions` and `catalog_changes` are all size-budgeted specifically so a single call can never blow past
  a sensible response size -- follow `truncated`/`nextOffset`/`notReturned` rather than trying to work around them.

## AWS tools (the AWS Events MCP)

`GetEvent`, `ListSessions` (the sync agent only), `GetSession`, `GetSchedule`, `ReserveSessions`,
`CancelReservation`, `AssociateFavorites` and `DisassociateFavorite`. Reads are safe to repeat; the writes
(`ReserveSessions`, `CancelReservation`, `AssociateFavorites`, `DisassociateFavorite`) keep their permission prompt, which is also your
confirmation step: never call one without the user's go-ahead.

## Reference files

- `reference/profiling.md` -- how to read a repository and write its profile.
- `reference/taxonomy.md` -- the catalog's topic, role, level and session-type vocabulary.
- `reference/workflow.md` -- exact input and output contracts for the commands, the sync protocol, and error handling.
- `reference/watch.md` -- the playbook for watching a full session and reserving it when a seat opens.
