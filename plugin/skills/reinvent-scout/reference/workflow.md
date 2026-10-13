# Command contracts, the sync protocol and the AWS tools

The exact input and output of every local command this skill uses, in the order a normal run calls
them, then how to use the AWS Events tools for the schedule. Every command is run through the one
bundled script, with its input as a single JSON object on stdin (or `--input <file>`):

```sh
node "${CLAUDE_SKILL_DIR}/scripts/reinvent-scout.mjs" status --input - <<'JSON'
{}
JSON
```

It prints exactly one JSON document. On success the shapes below are that document (exit code 0).
On a failure it prints `{ "error": string, "reason"?: string }` (exit code 1; 2 for a usage error such
as an unknown command or unreadable input), with the message cut to 512 characters. Output is held to
24 KiB, so the shapes below say how a long answer is shortened. The `{"tool": ..., "arguments": ...}`
blocks in this file show a command name and its input; run them as above.

## 1. `status`

Input: `{}`.

```json
{
  "catalog": { "status": "fresh", "syncedAt": 1234567890000, "count": 2043 },
  "lastImport": { "toSyncedAt": 1234567890000, "counts": { "added": 3, "removed": 1, "changed": 12, "unchanged": 2027 } }
}
```

`status` needs no sign-in and reports none. AWS access is the AWS Events MCP's own: if an AWS tool says
you are not signed in, the MCP client opens the sign-in; ask the user to complete it and retry.
`lastImport` is present only while it still describes the stored catalog (a first import adds `firstImport: true`, a
catalog that replaced another event's adds `replacedEventId`).

`catalog.status` is one of:

- `"missing"` -- nothing has been imported yet; run the `reinvent-scout:catalog-sync` agent.
- `"stale"` -- `{ "status": "stale", "reason": "schema-version" | "age" | "corrupt", "syncedAt"?: number }`; `catalog_import` with `action: "reindex"` is enough for `"schema-version"` alone (no AWS call); otherwise run the agent.
- `"fresh"` -- `{ "status": "fresh", "syncedAt": number, "count": number }`; no sync needed.


## 2. `catalog_import`

The catalog comes from AWS `ListSessions`, 250 sessions a page, and never passes through the conversation:
each page is saved to a file by the tool result, and `catalog_import` reads that file. Run the
`reinvent-scout:catalog-sync` agent to do the whole sync; its brief is below so you can see what it does and
finish a refused commit yourself.

Input is one object with an `action`:

- `{ "action": "page", "eventId": "reinvent2026", "timezone": "America/Los_Angeles" | null, "path": "<absolute path>" }`
  stages the first page. `timezone` is `GetEvent`'s `event.timezone` (null when it has none) and is required. Pass the
  saved result as `path` (absolute; a symlink, a directory or a file over 16 MiB is refused), or a small result inline as `page`: exactly one.
  Output: `{ "syncId", "pageNumber", "stagedCount", "totalCount", "nextToken"?, "complete", "totalCountChanged"? }`, no session data.
- `{ "action": "page", "syncId": "<from the first page>", "path": ... }` stages each later page (no `eventId`, no `timezone`).
  A page that repeats a session is refused (`overlap`); a page after the last is refused (`alreadyComplete`).
- `{ "action": "commit", "syncId": "...", "allowShrink"?: true }` replaces the stored catalog. It refuses, leaving the stored catalog
  untouched, when nothing is staged (`nothingStaged`), the last page still has a `nextToken` (`incomplete`), there are no sessions
  (`empty`), fewer sessions than the final `totalCount` (`partial`), or more than 10% fewer than the stored catalog of the same event
  (`shrunk`). Only the user's approval, after seeing both counts, may add `allowShrink: true`. The `syncId` ties the pages of one import together.
  Output: `{ "committed": true, "eventId", "count", "totalCount", "syncedAt", "firstImport"?, "replacedEventId"?, "warnings"?, "summary"? }`
  where `summary` is `{ counts, abstractsCompared, highlights (at most 20), omitted }`: what changed since the previous import.
- `{ "action": "reindex", "timezone"?: string | null }` rebuilds the index from the stored sessions with no AWS call (the remedy for
  `schema-version`); `timezone` is needed only for a catalog imported before timezones were stored.

A refusal is an error whose `error` starts with its `reason` (`shrunk: ...`), and `reason` is also given on its own.
The staged pages of a refused commit are kept for 24 hours, so a user-approved `allowShrink` commit needs no new pull.

The sync brief (what the `reinvent-scout:catalog-sync` agent does): `GetEvent` and note its `timezone`; `ListSessions` with
`includeAbstracts: true`; for each page `catalog_import` with `action: "page"` (the saved file's path, or the inline page), following
`nextToken` until `complete`; then `action: "commit"`. On `shrunk` it stops and reports both counts and never passes `allowShrink`;
on any other refusal it reports the reason and stops; it returns at most about 15 lines and never session data.

## 2a. `catalog_changes`

Input: `{ "sessionIds"?: string[] (1 to 200, ids or codes), "kinds"?: ("added" | "removed" | "changed")[], "offset"?: number, "limit"?: number (1 to 50, default 25) }`.

```json
{ "available": true, "eventId": "reinvent2026", "fromSyncedAt": 1234567000000, "toSyncedAt": 1234567890000,
  "counts": { "added": 3, "removed": 1, "changed": 12, "unchanged": 2027 }, "abstractsCompared": true,
  "total": 16, "offset": 0, "nextOffset": 25,
  "changes": [{ "kind": "changed", "sessionId": "1780441461150001GGoc", "code": "ANT301", "title": "...", "fields": ["sessionTime", "room"] }] }
```

What the last import changed, removed sessions first, then schedule changes (`sessionTime`, `venue`, `room`), then added, then the rest. Pass the ids on the
user's schedule as `sessionIds` to answer "did anything I planned move?". `nextOffset` is present exactly when more remain. When there is no diff the
answer is `{ "available": false, "reason": "noImport" | "firstImport" | "eventReplaced" | "superseded" }`; `seatAvailability` never counts as a change.

## 2b. `lookup_sessions`

Input: `{ "ids": string[] (1 to 100 session ids or codes of at most 64 characters, like ARC330 or ARC330-R1), "includeAbstract"?: boolean }`; with `includeAbstract` at most 10 ids.

```json
{ "rows": [{ "query": "ARC330", "sessionId": "1780441461150001GGoc", "code": "ARC330", "title": "...", "type": "Chalk talk", "level": "300 - Advanced",
    "venue": "MGM Grand", "room": "...", "startDate": "2026-12-02", "startTime": "10:30", "endTime": "11:30",
    "startsAt": "2026-12-02T18:30:00Z", "endsAt": "2026-12-02T19:30:00Z", "otherSittings": [], "abstract": "..." }],
  "notFound": [], "ambiguous": [{ "query": "DUP100", "sessionIds": ["..."] }], "notReturned": [] }
```

Reads the local catalog once. `abstract` is present only with `includeAbstract`. `startsAt`/`endsAt` are UTC instants (null, with `warnings`, when the event's timezone is unknown); an abstract is cut to 1,500
characters. Every query is in exactly one of `rows`, `notFound`, `ambiguous` or `notReturned` (cut to fit the output budget: ask for them again).
Use it to name the ids on a `GetSchedule` result.

## 2c. `search_sessions`

Input: `{ "query"?: string, "format"?: string, "venue"?: one of the catalog's venues, "levels"?: { "min": number, "max": number }, "day"?: "YYYY-MM-DD", "limit"?: number }`
(15 by default, at most 25). Returns `{ "rows": [{ "sessionId", "code", "title", "type", "level", "venue", "startDate", "startTime", "score" }], "omitted": number }`
over the local catalog, best match first. For a tech profile use `match_sessions`; this is for "sessions about X".

## 3. Read the repository, write a profile

Not a tool call. Read the repository per `reference/profiling.md` and build the profile object
described there. Do this before calling `validate_profile` -- the profile is authored by you, not
generated by any command.

## 4. `validate_profile`

Arguments: `{ "profile": <the profile object> }`.

Returns a compact **report** on what resolved -- not the profile itself, and not a shape
`match_sessions` accepts. Never pass this response anywhere else; keep the profile object you wrote
in step 3 and call `match_sessions` with that instead (step 5). `map_profile` (next section) takes the profile object too.

```json
{
  "services": [ { "name": "Amazon DynamoDB", "catalogName": "Amazon DynamoDB" }, { "name": "some-service", "catalogName": null } ],
  "patterns": ["serverless"],
  "unresolvedServices": ["some-service"],
  "counts": { "services": 2, "patterns": 1, "unresolvedServices": 1 },
  "truncated": false,
  "omitted": 0
}
```

Each `services[]` entry names the service exactly as the profile spelled it, alongside its resolved
`catalogName` (`null` when the currently-synced catalog has no counterpart for it) -- the same names
appear, unresolved, in the flat `unresolvedServices` list. `patterns` is the profile's own pattern
names, bare. `counts` always reports the true totals from the profile you sent, even when the lists
above were shortened to fit the response budget (`truncated: true`, with `omitted` and a `hint`
naming how many and why -- a profile naming an unusually large number of services or patterns, not
something to expect from an ordinary repo). An unresolved service name is not an error -- mention it
to the user in passing, not something to fix before moving on. A schema violation (missing
evidence, an entry with no `file`, an unknown `schemaVersion`) returns `isError: true` naming the
offending entry -- fix the *profile object* and call `validate_profile` again with it.

The report may also carry `warnings`, a list of strings and absent when there is nothing to say. A
`gap-*` pattern whose `note` names no file, path or glob gets one ("the note names no file, path or glob"):
the profile is valid, but a reviewer cannot tell what you searched. A warning is not an error; add
the files or search you used, and the count, to that note and validate again.

## 4a. `map_profile`

Arguments: `{ "profile": <the profile object>, "preferences"?: <preferences, as in `match_sessions`> }`. Returns what the profile found, grouped, for the user to choose from:
`{ "services": [...], "patterns": [...], "gaps": [...], "nextSteps": [...], "omittedPlatformServices": [...] }`. Every topic is
`{ "id", "label", "note"?, "evidence": [{ "repo", "file", "line"? }], "more"?, "pillar"?, "skipped"?, "goals": [{ "goal", "sessions" }] }`.
`id` is stable (`service:Amazon DynamoDB`, `pattern:event-driven`, `gap:gap-no-dlq`, `path:genai-single-call`) and is what
`match_sessions`' `focus` takes. Services list core before supporting. Platform services (S3, KMS, CDK, CloudWatch, IAM and the like: what nearly every workload uses, so they do not narrow sessions) are left out by design, and
`omittedPlatformServices` names the ones this profile has by short name (`["S3", "KMS"]`, empty when none); the text map says "Not shown: S3, KMS (platform services nearly every workload uses; they don't narrow sessions)". Supporting services that are not platform services (SQS, WAF, SNS) stay listed; a gap is a supported
gap pattern with its Well-Architected `pillar`; a next step is a migration path the profile activates, or one it skipped because it
already has the destination (`skipped` says why, and it has no goals). The goals are `understand` (introductory sessions, level 100/200),
`deepen` (sessions at any level whose title names the topic, leaving out the ones the All lens demotes) for services and patterns, and `improve` for a gap or a next step; `sessions` counts what that
goal would return for that topic alone, and a goal with `0` is a dead end (its `reason` says why, for example the closest 300-level session): say so instead of offering it.
A very large map is trimmed
to the budget, first to one place per topic, then to none, then without notes.

With `preferences.levels` the counts are of the sessions in that band range only (bands 100, 200, 300, 400, 500; inclusive; a session with no level is left
out), the map echoes `preferences`, and a goal the range emptied says why in its `reason` ("6 sessions match, none at 400–500"; `understand` is
introductory, so above 200 it says "understand lists introductory (100–200) sessions, which is outside 400–500; use deepen").

Present the map, ask the user for up to about five topics and a goal each, then call `match_sessions` with a `focus`.

## 4b. `list_filters`

Arguments: `{ "field"?: "level" | "format" | "venue" | "day" | "topic" | "area" | "industry" | "role" }`. Read-only, from the local catalog: it needs no profile. Returns
`{ "fields": { "<field>": { "total": number, "values": [{ "value": string, "count": number }], "more"?: number } } }`: each value with how many distinct talks have it (a repeat counts once), most first
(levels in order). With no `field`, every field lists its first 40 values and `more` says how many were left out; with a `field`, its whole list, shortened only to fit the response budget (again `more`).
Call it when the user asks what they can filter on ("what venues are there?"), or names a value that does not resolve; the values are what `preferences.rules` takes. An unknown field is an `isError`
naming the fields.

## 5. `match_sessions`

Arguments: `{ "profile": <profile object>, "lens"?: "all" | "explain" | "fix" | "next-level", "limit"?: number, "focus"?: [{ "topic": <id>, "goal": "understand" | "deepen" | "improve" }], "perTopic"?: number, "preferences"?: { "levels"?: { "min": number, "max": number }, "rules"?: [{ "field": string, "value": string, "action": "only" | "prefer" | "avoid" | "exclude", "levels"?: { "min": number, "max": number } }] } }`.
`preferences.rules` are facet rules, applied with the first rule that matches winning within a field: `{ "field": "format" | "venue" | "day" | "topic" | "area" | "industry" | "role", "value": string,
"action": "only" | "prefer" | "avoid" | "exclude", "levels"?: { "min": number, "max": number } }` (`levels` limits a rule to sessions in that range; the fields are the catalog's `type`, `venue`, start date,
`topics`, `areasOfInterest`, `industries` and `roles`, and a multi-valued field matches when any value does). `value` is checked against that field's catalog vocabulary, in any case or as a unique prefix
("chalk", "mgm"), and echoed as the catalog spells it; an unknown or ambiguous value is an `isError` listing the closest values and pointing at `list_filters`. `only` keeps just the sessions with the value:
several on one field are a union, on different fields an intersection, and a session with no value for the field is left out (a level-scoped `only` also leaves out a session with no level, as the level filter does). `exclude` removes the session like a level filter. `prefer` and `avoid` move it to a
tier after the demotion tier and before every other ranking key: within one field the first matching prefer or avoid rule decides, across fields the effects add up (+1 each, -1 each) and the highest sum comes
first, then neutral, then the lowest, with the lens's own order within each tier, so a preferred session outranks a neutral one even if it matches less strongly; the per-concept cap applies within each tier, so a preferred session the cap holds back still ranks ahead of every neutral one, and the focus dedupe runs after the tier. `why.summary` names every preference that moved the session, for example "(a chalk talk at MGM Grand, which you prefer)" and "(ranked lower: a breakout session, which you asked to avoid at 300–500)".
Rules apply to every lens and focus goal, `explain` and `understand` included. The map counts under `only`, `exclude` and `levels`, not under `prefer` and `avoid`, which only reorder.
`--only <field>:<value>[@band]`, and `--prefer`, `--avoid` and `--exclude` taking `[<field>:]<value>[@band]` (the field is a format when left out), are the CLI form: repeatable, kept in the order typed.
`preferences.levels` restricts every lens and every focus choice to the sessions in that inclusive band range (100 to 500; a session with no level is left out;
the same rule as `catalog search --level`). It is applied after admission and before the per-concept cap, the focus dedupe and `limit`, so a list is filled
from sessions in range; filtering removes sessions and the remaining ones are re-ranked by the same rules (the All lens and `explain` keep their relative order apart from the cap; `fix` and `next-level` re-interleave their rules over what remains), and a session's own score does not change. The response echoes `preferences`; when the range leaves nothing of a
result that has sessions without it, `reason` says "4 sessions match, none at 400–500" (for a focus, in that choice's `reason`). The `explain` lens and `understand` are introductory
(100 to 200): they keep the sessions in both, and above 200 `explain` is an `isError` ("explain lists introductory (100–200) sessions, which is outside 400–500; use deepen or all")
and `understand` shows 0 with that reason. A range with `min` above `max`, or a value that is not a band, is an `isError`. `--level 400-500` is the CLI form, on `match` and `profile map`.
With a `focus` (one to six choices, never together with `lens` or `limit`; `perTopic` defaults to 3 and is at most 3 here, the most six choices
can list within the response budget on the profiles measured; the CLI's `--per-topic` takes up to 10) the response is instead
`{ "results": [{ "topic", "goal", "total", "candidates", "reason"? }], "truncated", "omitted", "rankingReasonsOmitted"? }`: each choice runs the lens its
goal stands for (explain, all, or fix or next-level) restricted to that topic, with that lens's own admission, demotions and ranking. Every
candidate keeps its full `why`. `total` is how many sessions the choice alone would list, before the cap. A session listed under
an earlier choice is left out of later ones and carries `alsoMatches` naming them. A choice with no sessions says why in `reason`, and so does a choice whose sessions all went to earlier choices ("all 2 matching sessions are listed under ..."); a session an earlier choice
ranked past its cap is still listed under a later choice that matches it. An
unknown topic, a goal that does not apply (`improve` is for gaps and next steps, `understand` and `deepen` for services and patterns), a
focus with `lens` or `limit`, or `perTopic` without a `focus` is an `isError` naming the problem. When the response would not fit, ranking reasons go
first, then sessions from the end of the longest list (`truncated`, `omitted`).
`lens` defaults to `"all"`: the sessions about the services and patterns the profile's code is built on,
at any level and in any format (see "The all lens" in `reference/profiling.md`). `limit` defaults to 25 and is silently capped at 50 --
asking for more never errors, it just gets the largest sensible set. Fix requires an exact supported
cited gap and a remediation signal; Next-level requires a cited source pattern, a destination
signal, and a mention of the source side. Both need the session to fit the profile's stack (see
`reference/profiling.md`) and have neutral level/format preferences. Unknown patterns or an alien
catalog return no candidates. Under
Fix and Next-level, each activated rule gets its own ranked list and the lists are interleaved, so
every cited rule with an admitted session appears near the top rather than being buried by general
relevance.

```json
{
  "candidates": [
    {
      "code": "ANT301",
      "sessionId": "1780441461150001GGoc",
      "title": "Graviton. Serverless. Apache Iceberg. Your guide to a modern data warehouse strategy",
      "type": "Breakout session",
      "levelBand": 300,
      "why": {
        "summary": "Matches your Amazon Redshift (Nightly reporting warehouse).",
        "yourCode": [ { "repo": "reports", "file": "infra/redshift.tf", "line": 12 } ],
        "sessionSays": "Modernize your warehouse with Amazon Redshift and Apache Iceberg."
      },
      "score": 50,
      "reasons": [
        { "kind": "service", "detail": "Uses Amazon Redshift, which this session covers.", "weight": 50, "evidence": "Amazon Redshift" }
      ],
      "offerings": [
        { "sessionId": "1780441461150001GGoc", "abbreviation": "ANT301", "startDate": "2026-11-30", "startTime": "10:30", "endTime": "11:30", "venue": "MGM Grand", "room": "Level 3 | Chairman's 363 | Content Hub | White Theater" }
      ]
    }
  ],
  "truncated": false,
  "returned": 1,
  "requested": 25,
  "omitted": 0,
  "skippedRules": []
}
```

Never includes full abstracts (`why.sessionSays` quotes one sentence of one). `truncated`/`omitted`/`hint` only matter when the response would
otherwise exceed the size budget:

- `truncated: false` -- every matched candidate (up to `returned`) is included; `omitted` is `0`
  and `hint` is absent.
- `truncated: true` -- the response was cut for size, in ranked order (never a partially-serialized
  candidate); `omitted` is how many ranked candidates didn't fit (never confuse this with the gap
  between `requested` and `returned` when the catalog simply had fewer matches than requested --
  that's not an omission); `hint` names the omitted count and what can actually change the ranking
  ("N lower-ranked candidates were omitted to fit the response budget. A narrower lens or a more
  specific profile changes what ranks highest."). A smaller `limit` cannot reach the omitted
  candidates -- there's no `offset` here -- so don't suggest that to the user; a narrower lens or a
  more specific profile is what actually surfaces different candidates.

`code` is a session's base code with any repeat suffix removed -- the stable id across every
sitting of the same talk. `offerings` lists every scheduled sitting (a repeat conference talk given
twice has two), each with its own date, time, venue and room; use the `sessionId` from the specific
offering you mean when calling `AssociateFavorites` or `ReserveSessions`, not `code`. An offering also has `endTime` (`startTime` plus the catalog's length, the same local time; `endDate` too when it runs past midnight) when the catalog has a length and the sitting a start time, and no
`endTime` otherwise. Under a tight response budget `endTime` is the first thing left off, before ranking reasons and before any candidate, so its absence says nothing about the session. It is for showing when a sitting ends.
**Never infer that two sittings overlap or do not, or answer "can I attend both", from these times:** call `plan_schedule` with the offerings (it needs the schedule from `GetSchedule`), which checks time overlap (not travel or seats), and
report what it says.

Each candidate's `why` is `{ "summary": string, "yourCode": [{ "repo", "file", "line"? }], "more"?: number, "sessionSays"?: string }`,
built from the profile and the session's own title or abstract (never model text). `summary` is one
sentence naming what the candidate covers: under `fix` the gap and its note (`Covers your
gap-no-dlq: ...`), under `next-level` the source pattern and destination, under `explain` the
concept and how the code uses it, under `all` the one or two concepts of the profile the session was admitted for, most about first
(`Matches your AWS Lambda (...) and serverless`), with `; ranked lower: sponsored session` when it is demoted. `yourCode` lists up to three deduped citations in profile order; `more` counts the ones
left out and is absent when none were. `sessionSays` is the abstract sentence that says it (the title only when the abstract has none): among the sentences that name the concept, one that says what the attendee will learn, build or see
("learn", "build", "walk through", "dive into", "see how", "you'll", "demo", "hands-on", "deep dive", "patterns for", "best practices") is preferred over a marketing opener, and the first sentence that names it is the fallback, trimmed to about 160 characters, and is absent (not empty) when nothing could be quoted. Lead with
`why.summary` and `sessionSays` when presenting, and cite `yourCode`.

When the response would not fit the budget, MCP drops every candidate's ranking reasons first and
sets `rankingReasonsOmitted` to true; `why` and the lens reasons stay whole. Only then are whole
candidates left out (`truncated`). The CLI's `--verbose` flag shows every reason, lens and ranking, in the
human table (they are always in `--json`); it has no effect on `--json`.

Each `reasons` entry is `{ "kind": ..., "detail": string, "weight": number, "evidence": string }`.
`kind` is one of `service`, `topic`, `areaOfInterest`, `text`, `level`, `format` (the ranking reasons of
the Fix and Next-level lenses), `pillarGap` or `migrationPath` (the Fix and Next-level lenses only, and
they also carry `profileEvidence`), `explainsConcept` (Explain lens only: the concept the session
explains and the profile files that use it, also carried as `profileEvidence`) or `matchesConcept`
(All lens only: the concept of yours, or stated interest, the session is about, the phrase that says so and the files that use it,
also carried as `profileEvidence`; `why` already says it, so MCP drops it first when the response is tight). `weight` is
that reason's own contribution to `score` (every reason's `weight` sums to `score` exactly).
`evidence` is the specific catalog value that matched -- a service name, a topic, or the matched
query terms -- not a file path; when presenting a service reason to the user, the file citation
comes from the *profile's own* evidence for that service (see `reference/profiling.md`), not from
this field.

Under `explain`, the response also has `uncovered` (always present, usually `[]`): the profile's
concepts that no introductory session is about, as `{ "concept": "Amazon Cognito", "kind": "service", "reason": ... }` (`kind` is `service` or `pattern`).
Report them to the user as parts of their code the catalog has no introduction for; see "The explain
lens" in `reference/profiling.md`. Candidates come round-robin across concepts, not by score.

Under `all`, a candidate that is sponsored, news or launch, a customer story, modernization or
migration, made for an industry, about agents or generative AI when the profile has no such pattern, or titled about a technology
the profile does not use (a catalog service or a tool such as Terraform or Kafka) carries `demoted` (a short reason, absent otherwise). Every demoted candidate follows every other one. The
order is: title before abstract, then a session about the code's evidenced concepts before one about only a stated interest, then how central the concepts are to the code, then how many there are,
then relevance; no concept is the main subject of more than three of the first ten while four or more
concepts have sessions.

Fix and Next-level results are ordered by interleaving the rules' ranked lists, not by score, so
scores can appear out of order.

Under `fix` and `next-level`, each candidate also has `lensRules`: the source pattern names
(`gap-no-dlq`, `serverless`, ...) of every rule that admitted it. `skippedRules` (always present,
usually `[]`) lists Next-level paths the profile has already taken, as
`{ "rule": "genai-single-call", "reason": "profile already has agentic" }`; tell the user why a path
produced nothing instead of reporting an empty result. An offering with `startDate: null` is
unscheduled: the talk exists but has no time yet, so it cannot go on a schedule.

Under `all` the ranking `reasons` of every candidate may be dropped to fit the output budget (`rankingReasonsOmitted`, common at the default limit); `why` is unaffected.

## 6. Present candidates

Not a tool call. Present each candidate with `why.summary` and `why.sessionSays`, cite
`why.yourCode`, and give its `offerings` (when and where) so the user can judge for themselves, not
just a bare title and score. Do not read out ranking `reasons` unless asked. For an abstract, use `lookup_sessions` with `includeAbstract` (at most 10 ids); a match never returns one. Ask for confirmation
before favoriting anything.

## 7. The schedule, favorites and reservations (AWS tools)

All account access is the AWS Events MCP: `GetSchedule`, `ReserveSessions`, `CancelReservation`, `AssociateFavorites`
and `DisassociateFavorite`, as `mcp__plugin_reinvent-scout_awsevents__<Name>` or `mcp__awsevents__<Name>` (use whichever is available).
The writes keep their permission prompt, which is also your confirmation: never call one without the user's go-ahead.

- **Read the schedule** with `GetSchedule`, and resolve its ids with `lookup_sessions`. Its `reserved` and `favorites` are session ids; `personalTime`
  blocks carry `startDateTime`/`endDateTime` in UTC (`YYYY-MM-DDTHH:MM:SS`). Sort everything by `startsAt` from `lookup_sessions` (UTC) and by those
  instants; do not guess a session's timezone.
- **Batches.** `ReserveSessions` and `AssociateFavorites` take at most 10 ids per call. Send several calls, one after another, and read every `failed` entry
  of each result and report it: a `failed` entry is a refusal, never a success. `alreadyScheduled` is not a failure. A `scheduleConflict` names
  `conflictsWith`.
- **Stop and pause.** A 409 means reservations are closed: stop. On a 429, pause until a later wakeup instead of retrying in a loop; on a 429, pause also means not sending the next batch yet.
  Authentication and registration failures stop the run; relay what already succeeded.
- **Never replay an uncertain write.** After a timeout or transport error, call `GetSchedule` to see what landed, tell the user, and ask before
  any later retry with only the still-missing ids. A 200 that contradicts the schedule you read back is uncertain too.
- **Cancel** with `CancelReservation` only for a cancellation the user chose explicitly. A 404 means the reservation is already gone.
  Remove a favorite with `DisassociateFavorite`.
- **Read a session live** with `GetSession` (see "Live session read" below).

Check what stuck with another `GetSchedule`; the observed state is not proof of which request caused it.

## Error handling

A failed command prints `{ "error": string, "reason"?: string }`; the messages that matter for how you should react:

- **No catalog imported** ("No catalog has been imported yet. Run the catalog sync (the reinvent-scout:catalog-sync agent)."): run
  the agent, then retry the command.
- **Catalog needs a local rebuild** ("Rebuild it locally with catalog_import action "reindex", or re-import it."): run
  `catalog_import` with `action: "reindex"`.
- **An import refusal** (`shrunk:`, `partial:`, `incomplete:`, `empty:`, `overlap:`, `alreadyComplete:`, `nothingStaged:`): see the
  protocol under `catalog_import`. Never pass `allowShrink` without the user's approval.
- **Schema violation**: from `validate_profile`/`match_sessions` when the profile object itself is invalid, or any command when its
  input is. The message names the offending field -- fix the input and retry rather than asking the user what went wrong.
- **AWS errors** come from the AWS Events MCP, not the script: not signed in (the client opens the sign-in; ask the user to
  complete it), not registered for the event (403: signing in again will not help; tell the user to register first), reservations
  closed (409), too many requests (429), and not found (404, which is not proof a session is gone).

## Evidence lens example

This synthetic teaching profile covers all seven gap rules and three migration paths, and names
two core services, because a Fix session must share two and both lenses admit nothing for a
profile without one. Replace
it with evidence from the repositories you actually inspect; these are not claims about this
project. Save the original JSON as `lens-profile.json`. Validation returns a report, so pass
this original profile object to `match_sessions`, never that report.

```json
{
  "schemaVersion": 1,
  "repos": [
    {
      "root": "example",
      "languages": [
        "typescript"
      ]
    }
  ],
  "services": [
    {
      "name": "Amazon SQS",
      "usage": "The example queue.",
      "evidence": [
        {
          "repo": "example",
          "file": "infra/queue.ts",
          "line": 11
        }
      ]
    },
    {
      "name": "AWS Lambda",
      "usage": "The example queue consumer.",
      "evidence": [
        {
          "repo": "example",
          "file": "infra/queue.ts",
          "line": 14
        }
      ]
    }
  ],
  "patterns": [
    {
      "name": "gap-no-dlq",
      "note": "Read infra/queue.ts: 1 of 1 queues has no dead-letter queue or redrive policy.",
      "evidence": [
        {
          "repo": "example",
          "file": "infra/queue.ts",
          "line": 12
        }
      ]
    },
    {
      "name": "gap-no-alarms",
      "note": "Searched infra/stack.ts for alarms: 0 of 2 functions have an alarm that notifies a person.",
      "evidence": [
        {
          "repo": "example",
          "file": "infra/stack.ts",
          "line": 24
        }
      ]
    },
    {
      "name": "gap-no-tests",
      "note": "Counted test files under src/ and tests/: 0 of 1 units have tests, and the package.json test script runs nothing.",
      "evidence": [
        {
          "repo": "example",
          "file": "package.json",
          "line": 8
        }
      ]
    },
    {
      "name": "gap-broad-iam",
      "note": "Grepped infra/policy.ts: 1 of 3 statements grants an action on resource '*'.",
      "evidence": [
        {
          "repo": "example",
          "file": "infra/policy.ts",
          "line": 31
        }
      ]
    },
    {
      "name": "gap-no-load-tests",
      "note": "Searched ci/test.yml and *.yml for load or stress tests: 0 of 1 workflows run any. Cited the deploy entry point infra/app.ts.",
      "evidence": [
        {
          "repo": "example",
          "file": "infra/app.ts",
          "line": 16
        }
      ]
    },
    {
      "name": "gap-no-cost-monitoring",
      "note": "Searched infra/*.ts for budgets and anomaly monitors: 0 found. Cited the deploy entry point infra/app.ts.",
      "evidence": [
        {
          "repo": "example",
          "file": "infra/app.ts",
          "line": 7
        }
      ]
    },
    {
      "name": "gap-no-resource-rightsizing",
      "note": "Read infra/service.ts: 1 of 1 production functions keeps the default memory size.",
      "evidence": [
        {
          "repo": "example",
          "file": "infra/service.ts",
          "line": 20
        }
      ]
    },
    {
      "name": "serverless",
      "note": "Application is deployed as event-driven Lambda handlers.",
      "evidence": [
        {
          "repo": "example",
          "file": "infra/functions.ts",
          "line": 15
        }
      ]
    },
    {
      "name": "ecs",
      "note": "Another component runs as an ECS service.",
      "evidence": [
        {
          "repo": "example",
          "file": "infra/service.ts",
          "line": 10
        }
      ]
    },
    {
      "name": "genai-single-call",
      "note": "One model call returns a summary; no tool loop in this handler.",
      "evidence": [
        {
          "repo": "example",
          "file": "src/summarize.ts",
          "line": 18
        }
      ]
    }
  ]
}
```

Call `validate_profile` with that object, then `match_sessions` with the same object
and `lens: "fix"` or `lens: "next-level"`. Results depend on your synced catalog; zero is valid.
Fix reasons use `kind: "pillarGap"`; Next-level reasons use `kind: "migrationPath"`. Both add
`profileEvidence` containing the original repo/file/line (and any snippet/note), while `evidence`
contains the actual matched catalog selector. Display both. Source citations are deduplicated;
ordinary service/text reasons may follow them to explain ranking.

Fix reasons say “not evident in the cited scope” rather than asserting a global absence. For
`genai-single-call` → agentic, for example, describe multi-step tool use alongside latency, cost,
evaluation, and control requirements. For serverless → containers discuss runtime control versus
operational ownership; for ECS → EKS discuss portability/ecosystem versus platform complexity.
These are options, not prescriptions. Open issues are intent to connect to evidence, not proof of
a gap or permission to migrate. Large cited reasons retain the same whole-candidate MCP budget:
read `truncated` and `omitted`; citations are not silently clipped to make a candidate fit.

## Reservation workflow

Use actual offering IDs from `match_sessions` or `lookup_sessions`. These synthetic requests show
argument shapes; replace `example-offering` with the attendee's shortlist and `<selected-session-id>` with a
`selected[].sessionId` returned by the plan. Optional `event` selects an event; the default is `reinvent2026`.
Call `GetSchedule` immediately before, and pass the whole `schedule` object it returns (or save the result and pass
`scheduleFile`):

```json
{"tool":"plan_schedule","arguments":{"sessionIds":["example-offering"],"schedule":{"reserved":[],"favorites":[],"personalTime":[]}}}
```

`plan_schedule` is read-only, never calls AWS, and accepts an ordered list of 0–50 IDs and exactly one of `schedule` and `scheduleFile`
(an empty request needs neither). `schedule` is the `GetSchedule` result as it is: `reserved` and `favorites` ids, and `personalTime` blocks with
`startDateTime`/`endDateTime` as `YYYY-MM-DDTHH:MM:SS` in UTC (a `Z` or milliseconds are refused; free text is shortened). A requested sitting whose talk is
already reserved as a different sitting is reported in `alreadyReservedAlternative`
(`{ requested, reservedSessionId }`), never dropped. It checks the full reserved
and personal schedule, expands repeat alternatives, and chooses the earliest feasible offering
for each talk in input priority. Favorites do not block. A missing/invalid hard commitment time
prevents a `conflictFree` claim. It requires a current catalog for the same event and a recognized
IANA event timezone. Results contain `selected`, `alreadyReserved`, `rejected`, `alternatives`,
`blockedBy`, `conflictFree`, and `limitations`, with `omitted` counts if whole presentation
entries must be removed to fit the output budget; every hard commitment was still checked. This is a
greedy time-only plan, not a global optimum, seat promise, or travel-feasibility check.

Present that plan and obtain the attendee's confirmation before writing these exact IDs with `ReserveSessions` (at most 10 ids per call):

```json
{"tool":"ReserveSessions","arguments":{"sessionIds":["<selected-session-id>"]}}
```

The result is `{ successful: string[], failed: [{ sessionId, code, conflictsWith? }] }`. Read every `failed` entry and report it: `alreadyScheduled` is
not a failure, `sessionFull` and `scheduleConflict` are real refusals, and an unknown code is a refusal too. A 409 means reservations are closed: stop.
On a 429, pause until a later wakeup. A timeout or lost response is uncertain: call `GetSchedule` to see what landed, tell the user, and
never replay the whole request; a later retry needs an explicit new request, fresh eligibility checks, and only the still-missing IDs. No command
replaces or cancels conflicts.
Exception: inside a watch the user confirmed ([watch.md](watch.md)), the may-cancel list is the
explicit choice of cancellations and the running watch is the standing request for re-attempts.
Outside a watch, these rules hold.

For an explicitly requested cancellation, call `CancelReservation` with one reserved offering ID:

```json
{"tool":"CancelReservation","arguments":{"sessionId":"<selected-session-id>"}}
```

A success means cancelled; a 404 means the reservation is already gone; any other failure is uncertain until `GetSchedule` says otherwise. Never repeat a cancel
after a 503 without reading the schedule first. Favorites work the same way with `AssociateFavorites` (at most 10 ids per call) and `DisassociateFavorite`.

## Live session read, and watching a full session

`GetSession` reads one session live from AWS, not from the local catalog (which can be stale), with one request and no writes:

```json
{"tool":"GetSession","arguments":{"sessionId":"<session-id>"}}
```

The result's `session` has `sessionId`, `abbreviation`, `title`, `venue`, `room`, `sessionTime` (`date`, `time`, `length`), `isReservable` and
`seatAvailability`, plus the abstract and taxonomy: read only what you need. `seatAvailability` is one of `available`, `limited`, `veryLimited`,
`unavailable` and `walkUp`; it is a hint, not a guarantee of a seat. A 404 is not proof the session is gone: during an API outage real ids 404.

To reserve a full session when a seat opens, follow [watch.md](watch.md). It is a playbook for
you to carry out with these tools, not a command to run.

## On-site: confirm venue, inspect travel, then choose

Ask the attendee to confirm their current venue for this call. Location context and recent
reserved-session venues are suggestions, not confirmation. With no confirmed venue the tool
returns `needsVenueConfirmation` and no candidates. For example, after they confirm MGM Grand:

```json
{"tool":"get_onsite_preferences","arguments":{}}
```

Walk-up defaults false. The following local settings update enables it globally while explicitly
excluding one offering in this event. Replace the example ID with a catalog-returned offering ID;
use null instead of false to reset that override to the global default. Config reads create no
files. Settings use atomic local writes and an exclusive lock, with no attendee-account mutation.

```json
{"tool":"set_onsite_preferences","arguments":{"patch":{"allowWalkUp":true,"sessionWalkUp":[{"sessionId":"example-offering","allowWalkUp":false}]}}}
```

Nearby recommendations take two calls, because the script does not call AWS. Call `GetSchedule` first and pass the whole `schedule`
object (or `scheduleFile`). The first call answers with `refreshIds` (up to 20 eligible sessions) and cached bands, which are only ever unknown:

```json
{"tool":"nearby_sessions","arguments":{"location":{"venue":"MGM Grand","source":"user","confirmed":true},"withinMinutes":60,"limit":10,"schedule":{"reserved":[],"favorites":[],"personalTime":[]}}}
```

Read each id in `refreshIds` with `GetSession`, one at a time, skipping any that fails, then call `nearby_sessions` again with the same input plus
`liveSessions`: the `session` objects you read (at most 20). A band is stamped when the second call arrives and is fresh for `freshnessMinutes`.
Unknown or repeated `liveSessions` entries are counted in `coverage.liveIgnored` and otherwise ignored.

Read `candidates` IDs, starts/ends, minutes-to-start, outbound/check-in and onward travel,
`admission`, `availabilitySource`, observation age, and `coverage`. Estimates are conservative
hand-maintained assumptions, not AWS schedules or live routes; seat bands never promise admission.
Fresh reads replace cached time/venue/bands. Failed or stale reads are unknown, even if the old
catalog band looked promising. At most 20 locally eligible offerings are asked for; a
locally excluded offering is not, so this is not an exhaustive live search. Full reserved
and personal commitments constrain feasibility before any output budget. Favorites do not block.
`skipSessionIds` requires an explicit attendee choice and does not cancel reservations.

For a shuttle override, include `shuttleEnabled:true`, `shuttleWindows:[{start:"08:00",end:"18:00"}]`
and a directed route such as `{from:"MGM Grand",to:"Venetian",mode:"shuttle",minutes:20,waitMinutes:10}`
in the patch. Windows and peak buffers use the event timezone. Route `windows` and
`peakBufferMinutes` override global values; no configured window means no shuttle. Walking
remains the conservative fallback. Per-event `checkInMinutes` defaults10, `freshnessMinutes`5,
and `peakBufferMinutes`5 during08:00–10:00/16:00–18:00. Routes and window arrays replace prior lists.

Present the actual returned offering ID and obtain confirmation, then pass that ID to
`ReserveSessions` using the reservation flow above. A nearby suggestion itself never writes.
`skipSessionIds` needs an explicit instruction. Output budgets drop whole candidates or
preference entries with omission counts; do not change settings just to inspect omissions.
