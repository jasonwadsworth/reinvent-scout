# Reservations, then on-site mode

**Split reason — genuine product independence:** Reservations and a conflict-free dry-run planner are useful without on-site recommendations. On-site adds a separately usable attendee workflow over the schedule/time foundation. Deliver two coherent local implementation batches in that order; no prerequisite-only PR. Each stage receives one full check and one local commit after its targeted test cycles. Publishing is not authorized.

## Decisions made

- Stack locally on the completed lens work (lead created `codex/reservations-onsite`). Preserve current profile, matching, schedule, and favorites interfaces except additive safety reporting explicitly described below. No deterministic repository scans, geolocation SDK, automatic reservation replacement, or personal-time CRUD.
- Domain functions own validation, quotas, conflict/feasibility decisions, persistence, and outcome accounting; CLI/MCP parse and present. Use injected store root, API client, time, and sleep. All tests and smoke runs use temporary roots/fake fetch; no real store, attendee account, or network.
- Public API contracts verified by the lead supersede older prose in `docs/api/openapi.json`: [quotas](https://docs.aws.amazon.com/events/latest/devguide/quotas.html), [errors and retries](https://docs.aws.amazon.com/events/latest/devguide/errors.html). Reserve uses POST `/v1/events/{eventId}/reservations`, unique 1–10 IDs per request, `{sessionIds}` → `{result: BulkResult}`. Cancel uses DELETE `/v1/events/{eventId}/reservations/{sessionId}`, 204 or an already-absent 404. Reservations open October 8; server 409 is authoritative, with no local date gate.
- **Pacing is per operation**, not a combined favorites/reservations quota. Share limiter code, but key windows by store root and operation. Reserve/Favorite charge one unit per session; cancellation/unfavorite one per request. Preserve the existing 30 units/rolling minute and 1-second safety margin for these write operations. Serialize concurrent acquisition so calls asleep at the boundary cannot overspend. Independent roots/operations never block each other. Document unchanged cross-process limitation and API429 backstop.
- No blind POST retry on network/timeout/500/503. Fix the generic client policy for favorites too. A single auth refresh after 401 and bounded429 Retry-After retries remain safe. Never automatically replay an entire domain write after an ambiguous response. Reconcile against `GetSchedule` and report IDs whose outcome remains uncertain; only a later explicit request may retry still-missing IDs after rechecking eligibility. Do not claim a verified present reservation was newly created by the uncertain request.
- Reserve result: `successful`, `alreadyScheduled`, `failed`, `uncertain`, `notAttempted`, `verified: {reserved: string[]} | null`, `mismatch`, optional `verificationError` and `aborted`. Failure entries retain code, optional resolved `conflictsWith`, and reason; unresolved conflict IDs remain visible with null titles. `alreadyScheduled` is distinct from newly successful. Preserve every attempted outcome through later auth, registration, throttling, closed-operation, or verification failures. Throw auth/registration/409 only when no write or uncertain attempt needs reporting. Unknown bulk codes remain visible refusals.
- Cancellation result: `outcome: "cancelled" | "alreadyAbsent" | "uncertain"`, `verifiedAbsent: boolean | null`, optional verification/error details. A204 followed by read-back failure still reports cancellation acknowledged; ambiguous DELETE failure cannot be reported as successful. Use separate endpoint-specific retry semantics, not a global “all deletes are safe” assumption.
- Planner accepts an ordered shortlist of up to50 session IDs. Expand repeat alternatives from the local catalog using existing `baseSessionCode`; one selection per talk. Use deterministic greedy priority in input order, selecting the earliest feasible alternative, with stable ID tie-breaks. This is a conflict-free suggestion, not a globally optimal schedule or seat guarantee. Output actual selected offering IDs, alternatives considered, and structured rejection reasons; never write or cancel anything.
- Hard commitments are reservations and personal-time blocks; favorites are interests. Intervals are half-open (`start < otherEnd && end > otherStart`) and use existing event-IANA/UTC conversion. Reject unknown/invalid candidate times; an unresolved or invalid hard commitment blocks a claim of a conflict-free plan until fixed. Do not guess duration/timezone. Already-reserved exact IDs are reported separately and occupy time; an already-reserved talk prevents an additional repeat of that talk. Empty input returns an empty plan with no writes.
- Planning and on-site both reject a stored catalog whose `eventId` differs from the requested event before mixing it with that event's schedule; report the required event-specific sync.
- Reservation planning initially proves time non-overlap only and says so. Travel feasibility belongs to on-site mode. Scheduling data can change after planning; reserve returns authoritative API conflicts, never silently cancels blockers or switches to another sitting.
- On-site evaluates “next hour” by default, bounded to a maximum4-hour horizon. It accepts a per-call confirmed venue `{venue, source: "user" | "location" | "schedule", confirmed: true}`. Unconfirmed/missing venue returns `needsVenueConfirmation` and an optional suggestion from the current or most recent resolved reservation; location services may be supplied by the agent, never invoked by this CLI. Confirmation is required for every source; do not persist/reuse a stale confirmed location.
- “Skipping this” may exclude an explicitly supplied `skipSessionIds` from this one feasibility calculation. Report the exclusion and that its real reservation remains unchanged. Never infer a skipped commitment or ignore personal-time blocks automatically.
- On-site applies arrival travel plus check-in margin, interval overlap, and travel from the candidate's end to the next hard commitment. Unknown destination/commitment times or venue cannot prove feasibility. For personal-time locations use exact known venue names only; arbitrary addresses remain unknown. Current occupied time blocks prevent attending another session unless the user explicitly skipped that session. No early departure assumed.
- On-site prefilters the local catalog by time/route, then refreshes at most20 unique shortlisted offerings with `GetSession`; default output10, cap20. Recompute eligibility with the returned time/venue/seat fields. Never fetch the entire catalog into agent context or make an unbounded per-session scan. Surface shortlist and refresh caps as coverage limits, not proof there are no other feasible sessions.
- Availability is a band, never an inferred seat count: preserve `available`, `limited`, `veryLimited`, `unavailable`, `walkUp`, and unknown. Return observation time and age. Successful per-session read is fresh at that instant; cached fallback uses catalog `syncedAt`, never reindex time. Freshness threshold defaults to5 minutes, configurable within1–60. Failed, missing, malformed, or stale bands are “unknown” and cannot claim available seats. Existing reservations may remain attendance candidates despite `unavailable`; unreserved `unavailable` is excluded. `walkUp` requires effective walk-up permission. A nonreservable session without a band is labeled “no reservation offered; admission unknown,” requiring walk-up permission and carrying that uncertainty.
- Persist `allowWalkUp` globally (default false) and optional per-session boolean overrides; absence inherits, false is a real override, and reset removes the override. Scope overrides and travel settings by event ID. All externally supplied keys use Map/null-prototype handling, including `constructor`.
- Travel is a hand-maintained estimate, **not API data**. Ship a small typed matrix for the five known venues with walking and shuttle estimates, source/provenance notes, same-venue movement time, and explicit event-local peak buffers. Conservative starting values must be labeled estimates. Shuttle is disabled by default until the attendee enables it and confirms operating windows; unavailable routes never become zero-minute travel. Allow directed user overrides with mode, minutes, operating windows, and peak buffer; no inferred symmetry, route graph framework, or inferred live transport status. Select the fastest enabled estimate and return its mode, base/buffer/check-in minutes, and whether default or user supplied.
- One validated event-scoped `onsite.json` config document stores preferences and travel overrides under the injected root, atomic0600 writes and0700 directory conventions. Missing config means documented defaults; corrupt/unsupported config errors visibly and is never silently overwritten. Use a small exclusive config-write lock with fail-fast “busy, retry” behavior and finally cleanup to prevent lost updates across processes; no lock stealing. Reject symlinked config/lock paths and symlinked controlled parent/root paths before mutation. Read-only commands never create a config.
- New MCP reads fit30KiB whole-result envelopes using page/limit semantics or complete candidate omission with honest counts. Write outcomes must never be silently dropped for size: retain every requested ID and state, abbreviate optional descriptive strings with explicit markers, and validate bounded IDs (1–128 chars) before writes. If unusually large server conflict lists must be capped, retain returned conflict IDs intact and report an explicit omitted-conflict count plus schedule-read guidance; never trim a requested ID or its outcome. Reject an input before mutation if the mandatory response ledger cannot fit. Read tools must never hide omitted hard commitments before domain planning.

# Reservations — Sub-plan 1 of 2: reservation writes and dry-run planning

**Goal:** Reserve/cancel with truthful per-session outcomes and prepare a time-conflict-free plan before writing.
**Merges after:** none — independently useful first stage
**PR title prefix:** `part 1/2:` (only if publishing is later authorized)

**Files:**
- Modify: `src/api/client.ts` — reserve/cancel endpoints and operation-aware POST retry policy.
- Modify: `src/api/types.ts` — only additional response aliases needed by these methods; reuse BulkResult.
- Create: `src/schedule/write-quota.ts` — serialized, operation-keyed rolling write windows.
- Modify: `src/schedule/favorites.ts` — use shared limiter, pace unfavorite, preserve ambiguous POST outcomes additively.
- Create: `src/schedule/reservations.ts` — validated chunked writes, cancellation, reconciliation, and per-ID outcomes.
- Create: `src/schedule/plan.ts` — pure deterministic shortlist/repeat planner over full hard commitments.
- Modify: `src/schedule/merge.ts` — export/reuse time derivation if needed, without duplicating timezone logic.
- Modify: `src/cli/commands/schedule.ts` — `schedule reserve`, `schedule cancel`, `schedule plan` and human/JSON output.
- Modify: `src/mcp/tools.ts` — `reserve_sessions`, `cancel_reservation`, `plan_schedule`, plus bounded result serialization.
- Create: `src/mcp/response-budget.ts` — narrow reusable envelope measurement/ledger fitting for these tools and later on-site responses; avoid rewriting unrelated tools.
- Modify: `tests/api/client.test.ts` — endpoint encoding, payloads, no blind POST503 retry,401/429 behavior.
- Modify: `tests/schedule/favorites.test.ts` — existing behavior plus uncertainty and independent operation windows.
- Create: `tests/schedule/write-quota.test.ts` — fake-clock rolling, concurrency, operation/root isolation, lock release.
- Create: `tests/schedule/reservations.test.ts` — write/error/read-back state machine.
- Create: `tests/schedule/plan.test.ts` — conflict/repeat/time edge cases.
- Modify: `tests/cli/schedule-command.test.ts` — new commands and update typed ApiClient fakes.
- Modify: `tests/mcp/tools-schedule.test.ts` — new contracts and update typed ApiClient fakes.
- Modify: `tests/mcp/tools-catalog.test.ts` — add unused new client method stubs to its full ApiClient fake.
- Modify: `tests/mcp/server.test.ts` — tool registry expectations if enumerated.
- Modify: `tests/skill/content.test.ts` and `tests/docs.test.ts` — executable documented contracts and command coverage.
- Modify: `skills/reinvent-scout/SKILL.md`, `skills/reinvent-scout/reference/workflow.md`, `README.md` — plan→confirm→reserve flow, conflicts, uncertainty, closed-operation handling.

### Task R1: Endpoint and retry contracts
- [ ] Write failing tests in `tests/api/client.test.ts`: encoded event/session IDs, reserve unique1–10 request shape, unwrap result, cancel204 without JSON parsing,404/409 taxonomy; reserve/favorite503 and network failure attempt once,401 refresh once,429 bounded retry.
- [ ] Run `npm test -- tests/api/client.test.ts` — expect FAIL.
- [ ] Implement `ApiClient.reserveSessions(eventId, sessionIds)`, `ApiClient.cancelReservation(eventId, sessionId)` in `src/api/client.ts`; update response aliases in `src/api/types.ts` as necessary and typed fakes in the named CLI/MCP test files. Narrow POST retry policy without changing ordinary GET retry behavior.
- [ ] Run the targeted test — expect PASS. Sabotage POST retry guard and require the request-count assertion to fail; restore.
- [ ] Commit deferred to R5 after the stage is coherent; no partial endpoint-only commit.

### Task R2: Share pacing safely across real callers
- [ ] Write failing tests in `tests/schedule/write-quota.test.ts` and `tests/schedule/favorites.test.ts`:31st unit waits with margin, two waiters cannot reuse the same expired slots, repeated calls retain their window, different operations/roots do not wait, rejected sleeps release the queue, and cancel/unfavorite spend their own request units.
- [ ] Run `npm test -- tests/schedule/write-quota.test.ts tests/schedule/favorites.test.ts` — expect FAIL.
- [ ] Extract `acquireWriteQuota(operation, units, deps): Promise<void>` to `src/schedule/write-quota.ts`, with concrete operation union `favorite | unfavorite | reserve | cancel`, and replace existing favorites pacing in `src/schedule/favorites.ts`. Preserve prior rolling-window behavior and add additive `uncertain` reporting for ambiguous favorite POST failures plus reconciliation.
- [ ] Run targeted tests — expect PASS. Disable serialization and then operation-key partitioning separately; each concurrent/isolation assertion must fail.
- [ ] Commit deferred to R5.

### Task R3: Preserve reservation outcomes across failures
- [ ] Write failing tests in `tests/schedule/reservations.test.ts`: deduplication before pacing, empty/oversized IDs rejected before network,11 IDs→10+1 chunks, mixed successes/alreadyScheduled/sessionFull/conflicts/unknown codes, missing conflict titles, auth on first and later chunks,409 stops remaining chunks, throttling stops, OAuth failure stops, read-back mismatch/failure, uncertain503 then auth/read-back failure, and cancellation204/404/ambiguous outcome.
- [ ] Run `npm test -- tests/schedule/reservations.test.ts` — expect FAIL.
- [ ] Implement `reserveSessions(sessionIds, deps): Promise<ReserveSessionsResult>` and `cancelReservation(sessionId, deps): Promise<CancelReservationResult>` in `src/schedule/reservations.ts`. Validate at domain boundary; use limiter and one final schedule reconciliation; carry all attempted, uncertain and unsent IDs. Do not automatically retry the workflow or substitute repeat offerings. Keep existing favorites behavior compatible except documented additive uncertainty.
- [ ] Run `npm test -- tests/schedule/reservations.test.ts tests/schedule/favorites.test.ts` — expect PASS. Sabotage chunk size,409 stop, conflict forwarding, and retained uncertainty separately; require targeted reds and restore.
- [ ] Commit deferred to R5.

### Task R4: Build a conflict-free dry-run plan
- [ ] Write failing tests in `tests/schedule/plan.test.ts`: overlap with reservation/personal time, favorites not blocking, boundary adjacency, cross-midnight/DST event conversion, repeat alternative succeeds after preferred sitting conflicts, one talk only, input-order priority, unknown candidate/commitment times, missing timezone, invalid durations, wrong catalog event, duplicate/missing IDs, and empty input. Assert no write method is called in the orchestration contract.
- [ ] Run `npm test -- tests/schedule/plan.test.ts` — expect FAIL.
- [ ] Implement `buildSchedulePlan(sessionIds, context): SchedulePlan` in `src/schedule/plan.ts`, where context supplies complete index, complete schedule, event timezone and injected `now`; output selected offerings, already-reserved IDs, rejected/blocked reasons and `conflictFree`. Reuse `src/schedule/merge.ts` time derivation. Exclude sessions already ended/started at `now`; keep seat availability advisory at this stage.
- [ ] Run targeted tests — expect PASS. Remove hard-commitment checking, replace timezone conversion with raw local comparison, and suppress unknown-time blocking independently; each must produce a specific red.
- [ ] Commit deferred to R5.

### Task R5: Ship reservation adapters and the documented flow
- [ ] Write failing tests in `tests/cli/schedule-command.test.ts`, `tests/mcp/tools-schedule.test.ts`, `tests/skill/content.test.ts` and `tests/docs.test.ts`: same domain result through CLI/MCP, `plan_schedule` never writes, plan-returned offering IDs accepted by reserve, new tool registry, request validation before API, input cap50 for new reservation tool/command, full ledger retained below30KiB with maximum-length IDs/descriptions, and409/partial/uncertain states visible in human output.
- [ ] Run those four test files — expect FAIL.
- [ ] Add `schedule reserve <ids...>`, `schedule cancel <id>`, `schedule plan <ids...>` (stdin `-` for lists, `--json`); tools `reserve_sessions`, `cancel_reservation`, `plan_schedule`. Both planning adapters read the entire schedule and require a usable event-matching local catalog before the pure planner, never the budgeted display page. Implement budget utility in `src/mcp/response-budget.ts`; preserve IDs/states, expose truncation of descriptions. Update skill/workflow/README with explicit attendee confirmation before write tools and truthful Oct8/409 behavior.
- [ ] Run targeted files — expect PASS. Sabotage ledger preservation and turn planner into a write call in a fake-client probe; require red and restore. Walk built CLI plan→reserve→schedule with fake fetch/temp root using only IDs the plan printed; read human output.
- [ ] Run `npm run check` — expect PASS; stage named files and commit `feat: add reservation writes and conflict-free planning` with session attribution. Review the complete stage once; batch findings.

# On-site — Sub-plan 2 of 2: nearby feasible sessions

**Goal:** Suggest sessions reachable now without missing the next hard commitment, using confirmed location, fresh seat bands, and configurable estimated travel.
**Merges after:** sub-plan1 (time/planning primitives); reservations remain useful if this stage is cancelled
**PR title prefix:** `part 2/2:` (only if publishing is later authorized)

**Files:**
- Modify: `src/api/client.ts` — `getSession(eventId, sessionId): Promise<Session>`.
- Modify: `src/api/types.ts` — GetSession response wrapper only if needed.
- Create: `src/onsite/config.ts` — schema/defaults, event-scoped preference/route updates, guarded atomic persistence.
- Create: `src/onsite/travel.ts` — five-venue estimated matrix, operating windows/peak buffers, directed overrides.
- Create: `src/onsite/recommend.ts` — confirmation gate, local shortlist, bounded fresh reads, feasibility and ranking.
- Modify: `src/catalog/venue.ts` — export shared venue literals for input schemas/matrix coverage.
- Modify: `src/cli/commands/schedule.ts` — `schedule nearby` and `schedule onsite-config` read/update commands.
- Modify: `src/mcp/tools.ts` — `nearby_sessions`, `get_onsite_preferences`, `set_onsite_preferences`.
- Modify: `src/mcp/response-budget.ts` — whole-candidate bounded output with honest coverage/refresh counts.
- Modify: `tests/api/client.test.ts` — GetSession contract and errors.
- Create: `tests/onsite/config.test.ts` — preferences, schema, atomic persistence, concurrency and path hazards.
- Create: `tests/onsite/travel.test.ts` — matrix coverage, directed routes, windows/peak boundaries and estimates.
- Create: `tests/onsite/recommend.test.ts` — location, seats, time, hard-commitment and bounded-refresh behavior.
- Modify: `tests/cli/schedule-command.test.ts`, `tests/mcp/tools-schedule.test.ts`, `tests/mcp/tools-catalog.test.ts` — contracts and ApiClient fake updates.
- Modify: `tests/mcp/server.test.ts`, `tests/skill/content.test.ts`, `tests/docs.test.ts` — tool/command registry and executable documentation.
- Modify: `skills/reinvent-scout/SKILL.md`, `skills/reinvent-scout/reference/workflow.md`, `README.md` — location confirmation, walk-up controls, estimated travel, seat freshness and coverage limitations.

### Task O1: Safe preferences and estimated route configuration
- [ ] Write failing tests in `tests/onsite/config.test.ts`: missing defaults without writes; global true/session false override and reset; event isolation; unknown schema/corrupt config retained; prototype keys; invalid/negative/nonfinite minutes rejected; directed overrides; lock collision fails without overwrite; write failure preserves prior file and cleans lock; live/dangling symlink leaf, lock, root/parent refused without touching target.
- [ ] Run `npm test -- tests/onsite/config.test.ts` — expect FAIL.
- [ ] Implement `readOnsiteConfig(deps): OnsiteConfig` and `updateOnsiteConfig(eventId, patch, deps): OnsiteConfig` in `src/onsite/config.ts`, guarded read-modify-write under exclusive lock, existing atomic writer and permissions. Patch has explicit set/reset semantics; no arbitrary filesystem path input.
- [ ] Run targeted tests — expect PASS. Remove explicit-false handling, lock, and symlink guards one at a time; require corresponding reds and restore.
- [ ] Commit deferred to O5.

### Task O2: Estimated walking and shuttle feasibility
- [ ] Write failing tests in `tests/onsite/travel.test.ts`: every known venue pair has explicit walking estimates, same venue is nonzero movement; directed overrides do not reverse automatically; shuttle disabled/closed cannot win; enabled shuttle includes wait/peak buffer; event-local time and midnight-crossing windows; exact peak boundary; unknown route cannot equal zero.
- [ ] Run `npm test -- tests/onsite/travel.test.ts` — expect FAIL.
- [ ] Implement `estimateTravel(from, to, departureAt, context): TravelEstimate | null` in `src/onsite/travel.ts`, with exported typed starting matrix and clearly labeled assumptions. Context contains event timezone and effective configuration. Export venue literal list from `src/catalog/venue.ts` and share it with validation. Shuttle activation and window configuration are explicit user settings.
- [ ] Run targeted tests — expect PASS. Remove shuttle window gate and replace unknown route with zero separately; require reds and restore.
- [ ] Commit deferred to O5.

### Task O3: Bounded fresh session details
- [ ] Write failing tests in `tests/api/client.test.ts` and `tests/onsite/recommend.test.ts`: GetSession URL/unwrap/error mapping; shortlist capped20 despite a large catalog; no duplicate reads; fresh seat state/time/venue supersedes cache; read failures retain observed cache age but no fresh-seat claim; catalog reindex does not freshen observations.
- [ ] Run `npm test -- tests/api/client.test.ts tests/onsite/recommend.test.ts` — expect FAIL.
- [ ] Add `getSession` to `src/api/client.ts` and typed test fakes in the three named CLI/MCP test files. Begin `recommendNearbySessions(input, deps): Promise<NearbyResult>` in `src/onsite/recommend.ts` with local prefilter and at most20 serial fetches; retain a per-call observation timestamp. Stop further reads on auth/registration/throttling failures and expose refresh diagnostics rather than treating failures as empty successful results.
- [ ] Run targeted tests — expect PASS. Remove refresh cap and replace observed seat fields with cache fields independently; require reds and restore.
- [ ] Commit deferred to O5.

### Task O4: Confirmed location and both travel legs
- [ ] Write failing tests in `tests/onsite/recommend.test.ts`: venue missing/unconfirmed for all three sources prevents recommendations/refresh; only explicit skip excludes a reservation; arrival exactly at check-in deadline; insufficient travel time; next commitment reachable/unreachable despite no time overlap; personal time with unknown location; ongoing commitment; wrong catalog event; unknown duration/timezone/venue; walkUp global/session false override; reserved full session vs unreserved full session; stale/unknown bands cannot claim seats; future/past observation timestamps; all-day/unscheduled sessions excluded; no hidden cancellation; deterministic ranking/ties.
- [ ] Run `npm test -- tests/onsite/recommend.test.ts` — expect FAIL.
- [ ] Finish `recommendNearbySessions` with complete schedule reads, confirmed-location gate, effective config, two travel legs, fresh-field recheck and response `{candidates, rejected, warnings, coverage, needsVenueConfirmation?}`. Candidate includes offering ID, starts/ends, minutes-to-start, outbound/next-commitment estimates, seat band/freshness/admission status and reasons. Rank proven time-feasible candidates by reserved status, known attendance availability, travel time, start time, stable ID; optional profile relevance is deferred rather than invented.
- [ ] Run targeted tests — expect PASS. Sabotage confirmation, second-leg calculation and explicit false override separately; require reds and restore. Unknown admission may be shown as uncertain only with clear labeling, never as guaranteed seats.
- [ ] Commit deferred to O5.

### Task O5: Usable on-site commands, tools and guide
- [ ] Write failing tests in `tests/cli/schedule-command.test.ts`, `tests/mcp/tools-schedule.test.ts`, `tests/skill/content.test.ts`, `tests/docs.test.ts`: same candidates/config through adapters, enum/input bounds, confirmation protocol, effective preference explanation, fresh/failed reads,30KiB response with intact reason/time/venue fields and honest omission counts, no omitted hard commitment before feasibility, config get causes no mutation, and documented returned IDs usable in later explicit reserve calls.
- [ ] Run these four files — expect FAIL.
- [ ] Add `schedule nearby --venue <venue> --confirm-venue [--source user|location|schedule] [--skip-session <ids...>] [--within <minutes>] [--limit <n>] [--json]`; `schedule onsite-config [--event <id>]` reads effective configuration, and `schedule onsite-config --file <json>` applies a validated patch. Add tools `nearby_sessions`, `get_onsite_preferences`, `set_onsite_preferences` with shared domain schemas; config update accepts only the explicit patch shape. Explain local settings writes separately from attendee-account writes.
- [ ] Update skill/workflow/README with the actual location-confirmation conversation, explicit skipped-session behavior, fresh-seat limits, estimated travel and shuttle enablement, walk-up override/reset examples, and source→result flow. Reuse `src/mcp/response-budget.ts` for bounded candidates; expose rejected totals/coverage without sending the catalog.
- [ ] Run targeted files — expect PASS. Remove whole-candidate budget accounting and confirmation forwarding separately; require reds and restore. Walk built CLI config→nearby→explicit reserve against temporary roots/fake API, using only prior printed IDs and reading human explanations.
- [ ] Run `npm run check` — expect PASS; stage named files and commit `feat: recommend feasible nearby sessions with travel preferences` with session attribution. Batch review findings once.

## Final gates and review briefing

Targeted red/green cycles precede each implementation change; existing behavior tests use mutation to establish red. Sabotage edits must be checked to have applied and restored. Count executed tests; inspect actual user-readable outcomes and budgets. A negative fixture must pass the wrong implementation. Keep prototype-key probes, temporal boundary/concurrency probes, complete write ledgers, every write/read-back failure phase, and all symlink shapes in the review scope. Reviewer runs the real built flow, not just source inspection, using printed IDs.

The lead supplies all twelve principles from `review-principles-run-dont-read.md` verbatim in implementer/reviewer briefs. Run one reviewer per coherent stage, collect findings in a batch, and keep only required fixes. No fresh PR review is possible before a PR exists; if publishing is later explicitly authorized, each PR receives a fresh independent review before merging. Report local commits, exact validations, estimated travel assumptions, and the fact live reservation writes remain untested until separately authorized after API opening.

## Lead approval and travel starting assumptions

### Reservation stage validation

Completed locally: full check passed 774 tests across 54 files, typecheck, lint, and build.
Seventeen asserted implementation mutations produced the intended failing tests and were restored.
The built CLI plan → printed offering ID → reserve → schedule → cancel flow passed with fake API
responses in a temporary store. An independent saved-catalog probe selected a nonconflicting repeat
while preserving the original reservation, and verified partial/uncertain writes and cancellation
read-back failures. Review approved with no findings after 200 targeted tests, an independent built
CLI walkthrough, and restored quota/planner mutation checks (21 tests). No live account access.

Approved 2026-09-29. The two stages run sequentially with one implementer and one reviewer.
No live attendee-store access or publishing is authorized. Limit full checks to coherent stage
boundaries and required fixes; use targeted red/green and mutation checks within the stages.

On-site default walking estimates in minutes (including venue-scale movement, not measured routes):

| From / to | MGM Grand | Caesars Forum | Venetian | Wynn/Encore | Caesars Palace |
| --- | ---: | ---: | ---: | ---: | ---: |
| MGM Grand | 10 | 50 | 55 | 70 | 45 |
| Caesars Forum | 50 | 10 | 20 | 30 | 25 |
| Venetian | 55 | 20 | 10 | 20 | 25 |
| Wynn/Encore | 70 | 30 | 20 | 10 | 35 |
| Caesars Palace | 45 | 25 | 25 | 35 | 10 |

These are deliberately conservative hand-maintained starting assumptions, not AWS data or a
published route schedule. Document and return their estimated nature; directed user overrides
win. Shuttle estimates may use a simple explicit pair table plus wait time, but remain disabled
until the attendee enables them and supplies operating windows. Apply configured peak buffers
in the event timezone at departure and a separate check-in margin. Do not infer shuttle service
from a fast estimate. Retain same-venue movement time; different rooms are not zero travel.

## Stage 1 implementation notes

- Completed R1–R5 as one coherent local batch. Endpoint calls use injected fake fetch for all verification; no attendee account or real store was touched. Full typed API-client fixtures outside the initial file list received the two required unused-method stubs.
- Reservation outcomes are disjoint per requested ID; incomplete/contradictory acknowledgements remain uncertain and unsolicited IDs are never credited. Favorites keep existing failed-request fields and add explicit uncertain IDs for compatibility.
- The shared pacer now rechecks the injected clock after every sleep; old frozen-clock test helpers were updated to advance simulated elapsed time. Windows remain process-local and separated by operation/store root.
- Mandatory response size is checked before writes, including JSON-in-text escaping and UTF8. Optional descriptions/conflicts are shortened or omitted explicitly; unknown long Unicode refusal codes receive marked prefixes when needed, without dropping requested IDs or refusal states.
- Built CLI fixture walk exercised plan → reserve using the printed offering ID → schedule → cancel, plus acknowledged state after an uncertain503 and closed409. It verified no planner write and exactly one ambiguous POST. Harness: `/tmp/reinvent-reservations-walk.mjs`; no live API call.
- Seventeen asserted-applied mutation probes were killed by discriminating test assertions (timeouts rejected). Evidence: `/tmp/reinvent-reservations-mutations.log`. Test additions reconcile to72 above the702-test lens baseline: expected774 tests across54 files.
- Live reservation writes remain untested and require separate authorization after the service opens. Planning guarantees only new time non-overlap, not seats, travel, or a globally optimal schedule.


## Stage 2 implementation and validation

- Completed O1–O5 as one local batch: guarded version1 on-site preferences, directed travel assumptions, GetSession, confirmed nearby recommendations, CLI/MCP adapters and executable guide examples. Config uses event/session arrays and Maps for external IDs; explicit false and null-reset semantics are preserved. MCP startup now resolves its root without creating it so preference reads remain read-only.
- Travel uses the approved walking table. Shuttle requires explicit enablement, route and operating windows; route windows/peak buffers override global defaults. Unknown hard timing or next venue blocks feasibility. Explicit skips affect reserved commitments only and never cancel anything. Personal-time IDs cannot collide with own-reservation exclusion.
- Refresh is capped at20 unique serial reads after a local feasibility prefilter. Fresh records replace time/venue/bands; failed reads force unknown admission even when the cache is recent. The final completion clock rechecks every retained candidate's routes, minutes-to-start, age and expired admission. Aggregated rejection reasons explain empty results without returning the whole catalog. MCP drops whole candidates/preferences with omission counts; CLI can inspect full preferences.
- Full check passed **835 tests across59 files**, typecheck, lint and build. Reconciled against774/54: onsite config16, travel10, recommend28, budget2, adapters2; plus one API, one CLI and one MCP test =61 additions across5 new files.
- Sixteen asserted-applied and restored mutations produced targeted reds: explicit false, lock exclusivity, symlink guards, shuttle windows, event timezone, venue confirmation, onward feasibility, refresh cap, fresh fields, failed-recent bands, personal-ID collision, explicit skip, final-clock recheck, nearby/preference byte budgets and no-create MCP root resolution. Evidence: `/tmp/reinvent-onsite-mutations.log`. The timezone probe exposed an accidental equal-offset fixture; its morning-only window now discriminates UTC from the event timezone.
- Built CLI config → unconfirmed/confirmed nearby → printed offering ID → reserve → show passed using only injected fake fetch and an owned temporary store; human travel/admission/age explanations were inspected. Harness: `/tmp/reinvent-onsite-walk.mjs`. An independent saved2043-row catalog probe also passed, including ten simulated two-minute reads that correctly removed sessions no longer reachable at completion. No real account/store/network access or publication.
- Review approved with no findings: independent lint and148 tests across9 files, isolated built CLI flow using printed IDs, and an asserted final-clock mutation producing two intended failures. After restoration, all28 recommendation tests and diff checks passed.
- Limitations: hand-maintained travel estimates and bands never guarantee arrival/admission; local prefilter plus20 live reads is incomplete coverage. Intervening hard commitments conservatively prevent a new trip. Live API writes remain untested. Optional profile-based on-site ranking remains deferred.
