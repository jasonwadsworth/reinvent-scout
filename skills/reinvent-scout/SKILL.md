---
name: reinvent-scout
description: Finds re:Invent sessions relevant to a codebase by profiling the repo against the services and patterns it actually uses, matching that profile against the synced session catalog with evidence and reasons, and managing the attendee's own schedule. Use when the user wants re:Invent session recommendations for their repo or team, asks what talks to attend for their tech stack, or wants to review, favorite or unfavorite sessions on their schedule.
---

# reinvent-scout

Recommends AWS re:Invent sessions for a codebase and manages the attendee's schedule for them,
using this project's own MCP tools -- never by asking for or reasoning over the raw session catalog
directly. The catalog stays local and out of your context on purpose (over 2,000 sessions is far
too much to hold in a conversation); `match_sessions` is what turns it into a small, ranked,
explained shortlist.

## When to use this skill

- "What re:Invent sessions should I go to for this repo/team?"
- "Find sessions relevant to our stack and add them to my schedule."
- "What's on my re:Invent schedule?" / "Show me my favorites."
- "Favorite/unfavorite session X."

## The flow

1. Call `status`. If it returns `isError` because no session is signed in, run
   `reinvent-scout auth login` yourself in the shell -- it blocks until the browser sign-in callback
   lands, so just wait for it to return -- then call `status` again. Never tell the user to open a
   terminal and sign in themselves; you already have shell access, and this is exactly why.
2. If `status.catalog.status` is `"missing"` or `"stale"`, call `catalog_sync`. Never ask for or try
   to read the whole catalog through any other means -- it's synced locally specifically so an
   agent never has to hold it in context.
3. Read the repository (or repositories) the user wants matched and write a profile object,
   following `reference/profiling.md` exactly -- what to read, how to cite evidence, how to name
   services and patterns, and what to do with absences and open issues.
4. Call `validate_profile` with the profile. Its response is a compact *report* on what resolved
   (service names, pattern names, unresolved names, counts) -- not the profile itself, and not
   something to pass anywhere else. Fix anything it flags as a schema error (it names the
   offending entry) and validate again. An unresolved service name is not an error -- keep going,
   but it's worth a passing mention to the user.
5. Call `match_sessions` with **the profile you wrote in step 3** -- never with `validate_profile`'s
   own report, which is a different, smaller shape `match_sessions` doesn't accept. Default to the
   `"all"` lens unless the user wants foundational sessions (`"explain"`), evidenced gap
   remediation (`"fix"`), or migration options (`"next-level"`). Fix uses only supported,
   evidence-bearing gap patterns; Next-level uses `serverless`, `ecs`, or `genai-single-call`.
   See the exact vocabulary and trade-offs in `reference/profiling.md`.
6. Present the candidates to the user: title, format and level, every `reasons` entry (why it
   matched) and every `offerings` entry (when and where each sitting happens) -- not just a bare
   title and score. If the response came back `truncated`, say so and offer to narrow the request
   (a narrower lens or a more specific profile -- **not** a smaller `limit`, which only returns
   fewer of the exact same top-ranked candidates and can never reach the ones already omitted)
   rather than silently showing a partial list as if it were everything.
7. For reservations, call `plan_schedule` with a priority-ordered shortlist of offering IDs.
   Present its selected offerings, alternatives, refusals and time-only limits. Ask for confirmation before reserving
   those exact returned IDs with `reserve_sessions`. A plan never reserves seats or proves travel
   feasibility. Report every failed, uncertain and not-attempted ID, even when the tool marks the
   result as an error. A409 means reservations are closed: stop. Never automatically replay an
   uncertain write; use its schedule read-back, explain that observed state is not proof of what
   caused it, and ask before any later retry. Use `cancel_reservation` only for an explicitly
   chosen cancellation; never cancel conflicts automatically.
8. Ask for confirmation before favoriting anything. On confirmation, call `favorite_sessions` with
   the chosen session ids. Report every outcome plainly: a `failed` entry is a real refusal (most
   often a schedule conflict, named with the conflicting session's own title) and must be reported
   as one, never smoothed over as a success; a non-empty `mismatch` means the write didn't fully
   stick and is worth telling the user about too.
9. Call `get_schedule` to confirm what's actually on the schedule now, and show the user the
   relevant entries. Use `unfavorite_session` if the user wants something removed, and confirm with
   another `get_schedule` (or by checking its outcome) if it matters to them.

`reference/workflow.md` has the exact argument and output shape for every tool above, plus what
each `isError` message means and how to react to it.

## Presenting reasons and evidence

A candidate's `reasons` field is the whole point of matching from a profile instead of a keyword
search -- always show it, not just the score. Each reason's own `evidence` field (see
`reference/workflow.md`) is the matched catalog value (a service or topic name, or matched query
terms), not a file. Fix and Next-level reasons also carry `profileEvidence`: show its repo/file/line
citations alongside the catalog signal. For ordinary service reasons, go back to the *profile you wrote* and find the
evidence entry you cited for that same service, then mention it
("relevant because your API cites `@aws-sdk/client-dynamodb` in `src/handlers/create-order.ts`") --
that traceability is exactly what agent-authored, evidence-backed profiles buy over a black-box
score.

Say “not evident in the cited scope” for an absence; this is not proof the whole system lacks it.
Describe migration paths as options with gains and costs, never automatic upgrades.
Catalog signals establish subject coverage, not migration direction. Before presenting a migration
option, inspect its abstract with `reinvent-scout catalog show` and explain whether the session
explores that direction, the reverse direction, or a comparison.
Open issues are intent: connect a relevant issue to an already cited gap/path in your presentation; issue
prose does not establish a gap or authorize a migration. Fix picks are leads, not verdicts: a session can pass the stack and phrase gates while
mentioning a gap or your services only in passing, so read each pick's abstract (`catalog show`)
before presenting it and drop the ones that do not really address the gap. When `skippedRules` is
non-empty, say why that path produced nothing. Unsupported patterns produce no
candidates under these lenses. Source-service overlap ranks eligible sessions but cannot admit
one without the actual remediation or destination signal.

## What this build does not do

- No deterministic repository scanning -- you read the repository and write the profile yourself,
  per `reference/profiling.md`. There is no `profile_repo` tool.
- Never hold the full catalog, or a large slice of it, in your own context. `match_sessions` and
  `get_schedule` are both paginated/size-budgeted specifically so a single call can never blow past
  a sensible response size -- follow `truncated`/`nextOffset` rather than trying to work around them.

## MCP tools used

- `status`
- `catalog_sync`
- `validate_profile`
- `match_sessions`
- `get_schedule`
- `favorite_sessions`
- `unfavorite_session`
- `plan_schedule`
- `reserve_sessions`
- `cancel_reservation`

## Reference files

- `reference/profiling.md` -- how to read a repository and write its profile.
- `reference/taxonomy.md` -- the catalog's topic, role, level and session-type vocabulary.
- `reference/workflow.md` -- exact tool argument/output contracts, error handling, and the CLI
  command reference.
