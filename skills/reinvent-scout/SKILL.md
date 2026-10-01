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

1. Call `status`. Not being signed in is not an error: it returns `signedIn: false` with the catalog state
   and a `signIn` note. Browsing needs no sign-in: when the catalog is present (`status.catalog.status`
   is `"fresh"`, or `"stale"` with a `syncedAt` you are willing to use), go straight to profiling, mapping
   and matching without signing in. Sign in only when you need to sync the catalog (step 2) or to use the
   schedule, favorite and reservation tools (step 7). When you do need to, run
   `reinvent-scout auth login` yourself in the shell -- it blocks until the browser sign-in callback
   lands, so just wait for it to return -- then call `status` again. Never tell the user to open a
   terminal and sign in themselves; you already have shell access, and this is exactly why.
2. If `status.catalog.status` is `"missing"` or `"stale"` and you need a fresh catalog, sign in if you are
   not already (see step 1) and call `catalog_sync`. Never ask for or try
   to read the whole catalog through any other means -- it's synced locally specifically so an
   agent never has to hold it in context.
3. Read the repository (or repositories) the user wants matched and write a profile object,
   following `reference/profiling.md` exactly -- what to read, how to cite evidence, how to name
   services and patterns, and what to do with absences and open issues.
4. Call `validate_profile` with the profile. Its response is a compact *report* on what resolved
   (service names, pattern names, unresolved names, counts) -- not the profile itself, and not
   something to pass anywhere else. Fix anything it flags as a schema error (it names the
   offending entry) and validate again. An unresolved service name is not an error -- keep going,
   but it's worth a passing mention to the user. Then call `map_profile` with the same profile and
   **show the user the map**: one line per topic, grouped as services, patterns, gaps and next steps,
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
   **Session preferences.** When the user states a level preference, in numbers or words, pass it as `preferences: { "levels": { "min": N, "max": M } }` on
   `map_profile` and on `match_sessions`, and keep passing it for the rest of the conversation, the map included. The words are the catalog's own
   labels: 100 Foundational, 200 Intermediate, 300 Advanced, 400 Expert, 500 Distinguished. "Only 400-500" and "expert" are 400 to 500;
   "advanced and up" and "no intro" are 300 to 500; "only intro" is 100 to 200; "300 only" is 300 to 300. State the active level range once, briefly, when you
   apply it. It filters: filtering removes sessions, and the remaining ones are re-ranked by the same rules. `understand` and the `explain` lens are introductory (100 to 200), so above 200 they
   have nothing and say so (`explain` is an error naming `deepen` or `all`). When the filter empties something the response says so (`reason`:
   "4 sessions match, none at 400–500"): tell the user, never widen the range yourself, and offer to widen it.
   The same `preferences` object carries `rules` on any catalog field: `{ "field": "format" | "venue" | "day" | "topic" | "area" | "industry" | "role", "value", "action": "only" | "prefer" | "avoid" | "exclude", "levels"? }`
   (`levels` limits a rule to sessions in that range). `only` keeps just the sessions with the value: several `only` rules on one field are a union ("MGM Grand or Wynn/Encore"), rules on different
   fields an intersection, and a session with no value for that field is left out. `exclude` removes sessions. `prefer` and `avoid` only reorder: within one field the first matching rule decides, across
   fields the effects add up (+1 each for prefer, -1 for avoid), and the sessions with the highest sum come first, after the demoted sessions' own place and before every other ranking consideration, so
   "more than anything" means a preferred session outranks a neutral one even if it matches less strongly. `why.summary` names every preference that moved a session: "(a chalk talk at MGM Grand, which you
   prefer)", "(ranked lower: a breakout session, which you asked to avoid at 300–500)". Turn plain statements into rules and keep them for the rest of the conversation, the map included:

   | The user says | Pass |
   |---|---|
   | "only 400+" | `levels: { min: 400, max: 500 }` |
   | "no workshops" | `rules: [{ field: "format", value: "Workshop", action: "exclude" }]` |
   | "I like chalk talks" | `rules: [{ field: "format", value: "Chalk talk", action: "prefer" }]` |
   | "avoid breakouts unless intro" | `rules: [{ field: "format", value: "Breakout session", action: "avoid", levels: { min: 300, max: 500 } }]` |
   | "only sessions at MGM" | `rules: [{ field: "venue", value: "MGM Grand", action: "only" }]` |
   | "I'm staying at the Venetian, prefer sessions there" | `rules: [{ field: "venue", value: "Venetian", action: "prefer" }]` |
   | "nothing on Thursday" | `rules: [{ field: "day", value: "<that date>", action: "exclude" }]`, the date from `list_filters` with `field: "day"` |
   | "what venues are there?" | call `list_filters` with `field: "venue"` |

   Format words: chalk talk; breakout or talk (the catalog's "Breakout session"); workshop; builders' session; lightning talk; code talk; lab; bootcamp. A value is checked against the catalog's own
   vocabulary for its field, in any case or as a unique prefix ("chalk", "mgm"). When the user asks what they can filter on ("what venues are there?", "what categories are there?"), or names a value that
   does not resolve (the error lists the closest values), call `list_filters` (no profile needed; `field` for one field's values with counts) and offer the real values. Never compute a day's date yourself: get the `YYYY-MM-DD` values from `list_filters` with `field: "day"` and pick the one that is the weekday the user named. Restate the active
   preferences once, briefly, when you first apply them, and say when a preference emptied a result. `only`, `exclude` and `levels` change the map's counts; `prefer` and `avoid` do not.
6. Present the candidates to the user. Lead each one with its title, format and level, then
   `why.summary` and, when present, the `why.sessionSays` quote; cite `why.yourCode` (repo, file and
   line, plus `why.more` cut ones) so the user can open the code, then every `offerings` entry
   (when and where each sitting happens). Do not read out ranking `reasons` unless the user asks.
   If the response came back `truncated`, say so and offer to narrow the request
   (a narrower lens or a more specific profile -- **not** a smaller `limit`, which only returns
   fewer of the exact same top-ranked candidates and can never reach the ones already omitted)
   rather than silently showing a partial list as if it were everything. A focused response is
   grouped per choice (`results[]`, each with its `topic`, `goal` and candidates): present it the same
   way, one heading per choice, sessions led by their `why`; say how many more there are when `total`
   exceeds what is listed, say why when a choice has none (`reason`), and mention `alsoMatches` when
   a session serves another choice too.
7. For reservations, call `plan_schedule` with a priority-ordered shortlist of offering IDs.
   Present its selected offerings, alternatives, refusals and time-only limits. Ask for confirmation before reserving
   those exact returned IDs with `reserve_sessions`. A plan never reserves seats or proves travel
   feasibility. Report every failed, uncertain and not-attempted ID, even when the tool marks the
   result as an error. A 409 means reservations are closed: stop. Never automatically replay an
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

10. For on-site choices, read `get_onsite_preferences`; use `set_onsite_preferences` for requested
    local changes. Confirm the current venue on this call, then call `nearby_sessions`. Present
    both travel legs, admission uncertainty and refresh coverage before any reservation.

`reference/workflow.md` has the exact argument and output shape for every tool above, plus what
each `isError` message means and how to react to it.

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
- `nearby_sessions`
- `get_onsite_preferences`
- `set_onsite_preferences`

## Reference files

- `reference/profiling.md` -- how to read a repository and write its profile.
- `reference/taxonomy.md` -- the catalog's topic, role, level and session-type vocabulary.
- `reference/workflow.md` -- exact tool argument/output contracts, error handling, and the CLI
  command reference.


For on-site requests, confirm the attendee's current venue on every call, including location or
schedule-derived suggestions. Use `nearby_sessions` only after that confirmation. It reads the
full hard schedule and at most 20 fresh session records; travel is estimated and seat bands are
not guarantees. Present both travel legs, admission uncertainty and refresh coverage. An explicit
skip does not cancel a reservation. Walk-up defaults false; `set_onsite_preferences` changes local
settings, with event-scoped session false overrides and null resets. Follow the on-site examples
in [reference/workflow.md](reference/workflow.md). Ask for confirmation before reserving a returned
ID; nearby never writes to the attendee account.
