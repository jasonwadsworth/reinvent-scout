# Plugin only — Sub-plan 1 of 1: remove the legacy CLI, local MCP server, installer, sign-in and API client (#22 part 2)

Part 2 of 2 for jasonwadsworth/reinvent-scout #22, written against `41104dc` (head of `feat/plugin-skill`,
PR #23). It implements sub-plan 2 of `docs/plans/2026-10-12-skills-only-plugin.md`, corrected against the code
as it stands after part 1.

**Why single PR:** it is almost all deletion (about 5,600 src and 11,600 test lines) plus about 600 lines of
rewritten docs and tests. Every piece depends on the others: the CLI and the MCP server import each other,
and the API layer is only reachable through them. Splitting would ship "part N of M" chunks of one change.

**Branch:** `feat/plugin-part2`, cut from `main` **after PR #23 merges** (lead's decision, 2026-10-19), not from
`41104dc`. PR #23 is getting fix commits after `41104dc`: a SKILL.md trim, workflow.md edits, and `eventId` in the
examples. Every line number and quoted string in this plan was taken at `41104dc`. Before each task, re-locate
its targets in the post-merge `main`, and re-run B's import graph and coverage diff on that `main` before Task 1.
Tasks 11 and 12 in particular must work against the post-fix skill text: re-grep `plugin/skills/**` for the CLI
flags, "the CLI" and "MCP drops", and re-read the README pins in `tests/skill/content.test.ts`, instead of
trusting the line numbers below. If a sentence listed in Task 11 is already gone, skip it, and add any new hit.

**PR title:** `part 2/2: plugin only — remove the CLI, local MCP server, installer and API client`.
**PR body:** `Part 2 of 2 for #22. Closes #22. Closes #20.` PR #23 does not close #20 (its body says only "Part 1
of 2 for #22"), and #20 is still OPEN. Check `gh issue view 20 --json state` right before opening the PR, and
drop `Closes #20` if it has been closed by then.

---

## A. Decisions made

1. **Scope confirmed, with four corrections to the lead's summary and the 2026-10-12 plan.**
   - **`src/schedule/reservations.ts` is not wholly dead.** The bundle uses `validateSessionIds`,
     `MAX_RESERVATION_IDS` and `MAX_SESSION_ID_LENGTH` from it (`commands/registry.ts:17`,
     `schedule/plan.ts:7`). Through that file, `auth/oauth.ts`, `catalog/sync.ts` and `schedule/write-quota.ts`
     are in the bundle's import graph, though they contribute 0 bytes. The three exports move to a new
     `src/schedule/session-ids.ts` (Task 3) before the rest is deleted.
   - **`src/schedule/schedule.ts` still provides types.** `merge.ts` imports `ScheduleSession` from it as a
     type. The types move into `merge.ts` before `schedule.ts` is deleted (Task 4).
   - **The live bundle prints stale advice.** `timezoneWarnings` (in `merge.ts`, used by `lookup_sessions`)
     tells the agent to run `` `catalog_sync`, or `reinvent-scout catalog sync` ``. Neither exists after
     this PR. Reworded with a failing test (Task 5).
   - **The skill text still names CLI flags.** `workflow.md` lines 190, 192, 196, 198 and 283, `taxonomy.md:161`
     and `profiling.md:137` mention `--level`, `--only`, `--per-topic`, `--verbose` and "the CLI". A content
     test currently *requires* "`--level 400-500` is the CLI form" (`tests/skill/content.test.ts:1020`).
     Fixed in Task 11.
2. **`src/schedule/merge.ts` is renamed `src/schedule/session-times.ts`.** After the trim, it holds only
   `deriveSessionTimes`, `timezoneWarnings` and the `ScheduleSession` types, and nothing in it merges anything.
   The rename happens in Task 5, which changes the bundle anyway.
3. **`validateSessionIds` loses both flags.** Every caller left (`plan.ts:48`, `plan.ts:111`,
   `registry.ts:146`) passes `allowEmpty = true, writeLedger = false`. The new signature is
   `validateSessionIds(input: readonly string[]): string[]`. It accepts 0 to 50 ids and its error text stays
   "Expected 0–50 session IDs, each 1–128 characters.", so the output is the same for every caller.
4. **`api/types.ts` moves to `src/aws/types.ts`** (2026-10-12 plan, A8), without `Bulk*`, `Event` and
   `ListSessionsResponseContent`, which only the deleted code used. The move is type-only, so the bundle stays
   byte-identical. It touches about 45 importers, one line each, in its own commit.
5. **`npm run build` and `package.json` `files` go.** With no `bin` and `private: true`, nothing reads `dist/`.
   `tsc --noEmit` (typecheck) still compiles every source file. `check` becomes
   `typecheck && lint && test && bundle:verify`. `.gitignore` keeps `/dist/` so an old checkout's leftovers stay
   ignored.
6. **No version bump.** `package.json` and `plugin.json` stay at `0.1.0`. The only bundle changes are internal
   (see C), and a bump would also change the pinned permission rule the README tells users to write. Release
   versioning is the user's call; the PR body says so.
7. **The test helper `callCommand` matches the script, not the MCP server.** It uses `toCommandError`. On error,
   `text` is the `error` field the script prints, and the result also carries `reason` when there is one.
   Its only deviations from the MCP shape were the MCP-only suffixes such as "(needs catalog_sync and a
   signed-in session.)", which no surviving test asserts.
8. **The MCP-parity test is replaced by a script-parity test.** `tests/commands/registry.test.ts` checked that
   the registry and the MCP tool give the same text. It now checks that `callCommand` and the spawned bundle
   agree, so the helper the other tests rely on can't drift from what the script really prints.
9. **Dead-module guard, kept for good.** A new `tests/plugin-only.test.ts` builds the bundle in memory (esbuild
   `metafile`) and asserts that the set of `src/` files not in the bundle's import graph is exactly a
   `KNOWN_DEAD` list. The list starts as the 29 files below, shrinks in each deletion task, and is empty at the
   end. Type-only modules (`src/aws/types.ts`) are on a separate `TYPE_ONLY` allow-list, because esbuild drops
   type-only imports from the graph. After this PR, anyone who adds an unreachable module gets a red test.
10. **Comments are left alone where the behavior they describe still exists.** Comments in live modules that
    name the CLI, the MCP server, `get_schedule`, `catalog_sync` and so on are reworded (Task 9), because they
    describe callers that are gone. Exports that are now used only inside their own module (`preparePlan`,
    `assertNearbyPreconditions`) stay exported, which keeps this PR to deletion. Only exports with no caller
    left are removed (Task 8).
11. **The README pins in `tests/skill/content.test.ts` are triaged one by one** (Task 12). Pins that describe
    behavior stay as they are. Pins of CLI syntax are dropped or moved to their script-argument form.

---

## B. The import-graph proof

Method: `esbuild.build({ ...buildOptions(root), write: false, metafile: true })`, using the same options as
`npm run bundle`. The bundle's import graph is `Object.keys(metafile.inputs)` filtered to `src/`. Every
`src/` file not in it is unreachable from `src/script/main.ts`. The run on `41104dc` found 53 reachable files
and 30 unreachable ones. A second pass read each module's importers, to find modules that are reachable but
only through the code being deleted.

**Unreachable now (29 files, plus `api/types.ts`, which is type-only and reached through `import type`):**

| File(s) | Why it is dead (its only importers) |
|---|---|
| `src/cli/main.ts` | Nothing imports it. It is the `bin` entry (`dist/cli/main.js`). |
| `src/cli/entry.ts`, `cli/version.ts`, `cli/level-option.ts`, `cli/profile-input.ts`, `cli/commands/{auth,catalog,match,mcp,profile,schedule,skill}.ts` | `cli/main.ts` and each other; `cli/version.ts` also by `mcp/server.ts` and `skill/*`, all dead |
| `src/mcp/server.ts`, `mcp/tools.ts`, `mcp/response-budget.ts` | `cli/commands/mcp.ts` → `server.ts` → `tools.ts` → `response-budget.ts` |
| `src/skill/install.ts`, `skill/update.ts` | `cli/commands/skill.ts` |
| `src/legacy/api-adapters.ts` | `cli/commands/schedule.ts`, `mcp/tools.ts` |
| `src/profile/store.ts` | `cli/commands/profile.ts`, `cli/profile-input.ts` |
| `src/api/client.ts` | `cli/commands/{auth,catalog,schedule}.ts`, `mcp/tools.ts`; type-only from `catalog/sync`, `legacy`, `schedule/{favorites,reservations,schedule}` |
| `src/auth/login.ts`, `browser.ts`, `callback-server.ts`, `pkce.ts` | `cli/commands/auth.ts` → `login.ts` → the rest |
| `src/auth/provider-adapter.ts`, `token-provider.ts`, `token-store.ts` | `cli/commands/*`, `mcp/tools.ts`, and each other |
| `src/schedule/favorites.ts` | `cli/commands/schedule.ts`, `mcp/tools.ts` |
| `src/schedule/schedule.ts` | `cli/commands/schedule.ts`, `mcp/tools.ts`; **type-only from live `merge.ts`** (Decision 1) |

**Reachable now, but dead once their legacy importers go (they add 0 bytes to the bundle):**

| File | Why it is in the graph | Fix |
|---|---|---|
| `src/schedule/reservations.ts` | `commands/registry.ts`, `schedule/plan.ts` import `validateSessionIds` and two constants (939 bytes in the bundle) | Task 3 moves the three into `session-ids.ts`; Task 4 deletes the rest |
| `src/auth/oauth.ts` | `reservations.ts` (value import of `OAuthError`) | Dead after Task 3, deleted in Task 4 |
| `src/catalog/sync.ts` | `reservations.ts` (`DEFAULT_EVENT_ID`, which is re-exported from `catalog/store.ts`) | Same |
| `src/schedule/write-quota.ts` | `reservations.ts` | Same |

**Live but trimmed:** `core/errors.ts` (8 classes and helpers used only by dead code), `schedule/merge.ts`
(`mergeAndSortScheduleEntries` and its types), `api/types.ts` (`Bulk*`, `Event`, `ListSessionsResponseContent`).

**Exports left with no caller, found by scanning every export in a live module for a use in another live
module** (scratch script, run again in Task 14). Bundle check: `grep -c` finds 0 occurrences of each in
today's bundle, so removing them leaves it byte-identical.
- `catalog/query.ts` `resolveSessionRecord` (CLI `catalog show`; a one-line wrapper over `resolveSessionToken`)
- `match/focus.ts` `profileTopics`; `match/map.ts` `resolveTopic` with its private `bare`/`names` helpers
  and `Nameable` (CLI `--focus` parsing)
- `match/preferences.ts` `describePreferences` (the CLI's header line)
- `core/paths.ts` `ensureStoreRoot` (CLI only; `ensureDirWithMode` stays and is used by catalog, diff, import
  and onsite)
- `schedule/timezone.ts` `formatEventLocalTime` (CLI `schedule` printing)
- `core/errors.ts` `markRequestNotSent`, `isRequestNotSent`, `EmptyCatalogError`, `ServiceError`,
  `AuthRequiredError`, `NotRegisteredError`, `ThrottledError`, `NotFoundError`, `OperationUnavailableError`
- `commands/registry.ts` the `errorMaxChars` field ("The legacy MCP server cuts this command's error text"),
  set on three commands

**Coverage lost when the legacy tests go** (measured: `@vitest/coverage-v8` installed with `--no-save`, the
full suite against the surviving tests, live modules only). These are the ports Task 1 must make:
- `commands/registry.ts` 193–205, 209–211: the `match_sessions` refusals (focus with limit, focus with lens,
  perTopic without focus) and the **whole focus path**, covered today only by `tests/mcp/focus.test.ts` and
  `tests/mcp/levels.test.ts`;
- `registry.ts` 227–231: `list_filters`' halving loop, covered only by `tests/mcp/filters.test.ts`;
- `registry.ts` 244: `map_profile` with `preferences` (`tests/mcp/levels.test.ts`);
- `registry.ts` 260–261: `set_onsite_preferences` run (`tests/onsite/adapters.test.ts`);
- `core/atomic-write.ts` 30–35: the temp-file cleanup when a write fails, covered only by the token-store and
  profile-store tests;
- `schedule/reservations.ts` 19: the throw on bad ids in `validateSessionIds` (Task 3);
- branch-only: `match/response.ts` 122/123/138/206/253 and `match/topics.ts` 71/74 (the preference and
  reason echoes, a pattern's twin concept), `onsite/recommend.ts` 85 (an explicit `eventId`),
  `profile/report.ts` 175 (the pattern budget break), and `core/paths.ts` 22 (the default `homedir`).
- `focus.ts:143`, `map.ts:62–96`, `errors.ts:110–127` and `merge.ts:140–146` are lost too, but they are the
  dead exports above and are deleted.

---

## C. The bundle, task by task

Guard for a task that must leave the bundle unchanged: `npm run bundle && git diff --exit-code --
plugin/skills/reinvent-scout/scripts/reinvent-scout.mjs` (exit 0), plus `npm run check` (which runs
`bundle:verify`). A copy of the repo with Task 2's deletions applied was simulated, and `bundle:verify` passed
on it.

| Task | Bundle | Expected diff (verified by simulation where marked) |
|---|---|---|
| 1, 2, 4, 6, 7, 8, 10–14 | **byte-identical** | none (Task 2 simulated) |
| 3 | changes | `// src/schedule/reservations.ts` becomes `// src/schedule/session-ids.ts`; `RESPONSE_BUDGET_BYTES` and the `writeLedger` branch go; the call in `plan_schedule` loses its two flag arguments (simulated: exactly these hunks) |
| 5 | changes | `// src/schedule/merge.ts` becomes `// src/schedule/session-times.ts`; the two reworded `timezoneWarnings` strings |
| 9 | changes | the three `errorMaxChars: 512` lines go; comment lines inside object literals in `registry.ts` that esbuild keeps (for example the "unlike the CLI's own" line, today bundle line 23782) |

In Tasks 3, 5 and 9, commit the rebuilt bundle with the source change, and paste `git diff --stat` and the hunks
of the bundle into the commit body. Any hunk not in this table is a stop-and-investigate.

---

**Files:**
- Create:
  - `tests/plugin-only.test.ts`: the dead-module guard (B), the import and dependency guards, and the
    stale-reference scan of config files and docs.
  - `src/schedule/session-ids.ts`: `MAX_RESERVATION_IDS`, `MAX_SESSION_ID_LENGTH` and `validateSessionIds`.
  - `tests/schedule/session-ids.test.ts`: its tests.
  - `tests/commands/focus.test.ts`, `tests/commands/levels.test.ts`, `tests/commands/filters.test.ts`: the
    local-command cases of `tests/mcp/{focus,levels,filters}.test.ts`, ported to `callCommand`.
  - `tests/lint-config.test.ts`: the no-console coverage that `tests/mcp/eslint-console.test.ts` gave, for the
    paths that remain.
- Move:
  - `src/schedule/merge.ts` to `src/schedule/session-times.ts`, and `tests/schedule/merge.test.ts` to
    `tests/schedule/session-times.test.ts`;
  - `src/api/types.ts` to `src/aws/types.ts`.
- Delete:
  - src: everything in B's two dead-file tables, and `src/schedule/reservations.ts` after Task 3;
  - tests: `tests/{cli,mcp,auth,api,integration,legacy}/**`, `tests/skill/{install,update}.test.ts`,
    `tests/smoke.test.ts`, `tests/catalog/sync.test.ts`,
    `tests/schedule/{favorites,reservations,schedule,write-quota}.test.ts`, `tests/profile/store.test.ts`,
    `tests/helpers/fake-fetch.ts`.
- Modify:
  - src: `src/commands/registry.ts`, `src/schedule/plan.ts`, `src/catalog/lookup.ts`, `src/core/errors.ts`,
    `src/core/paths.ts`, `src/catalog/query.ts`, `src/match/{focus,map,preferences,response}.ts`,
    `src/schedule/timezone.ts`, `src/profile/{profile,report}.ts`, `src/catalog/store.ts`, and every importer of
    `api/types`;
  - tests: `tests/helpers/call-command.ts`, `tests/commands/registry.test.ts`, `tests/skill/content.test.ts`,
    `tests/onsite/adapters.test.ts`, `tests/match/offering-times.test.ts`, `tests/docs.test.ts`,
    `tests/core/{errors,paths,atomic-write}.test.ts`, `tests/catalog/query.test.ts`,
    `tests/match/{formats,facets}.test.ts`, `tests/schedule/timezone.test.ts`;
  - config: `package.json`, `package-lock.json`, `eslint.config.js`;
  - docs: `README.md`, `CLAUDE.md`, `plugin/skills/reinvent-scout/reference/{workflow,taxonomy,profiling}.md`.
- Unchanged (each checked): `tsconfig.json` and `tsconfig.tests.json` (they include `src` and `tests` as a
  whole), `vitest.config.ts`, `.github/workflows/check.yml` (`npm ci` and `npm run check` only),
  `scripts/*.mjs`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json` and `plugin/.mcp.json`
  (none names a removed path; Task 10's scan proves it), `tests/ci.test.ts`, `tests/plugin/manifest.test.ts`
  and `tests/script/*.test.ts`.

**Commands** (CLAUDE.md): `npm test -- <path>` for one file; `npm run typecheck`; `npm run lint`;
`npm run bundle`; `npm run check` before every commit. The sabotage rule applies to every new or changed test:
defeat the two or three production lines it checks, confirm that exactly that test goes red, revert, then
commit. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

Setup (after #23 merges): `git fetch origin && git worktree add -b feat/plugin-part2 <dir> origin/main && cd <dir> && npm ci`.

---

### Task 1: Move the surviving tests off the MCP server and the CLI, and add the dead-module guard
Afterwards, no test that survives this PR imports `src/mcp`, `src/cli`, `src/api/client` or `catalog/sync`.
Every coverage gap in B is ported.

- [ ] **Guard first.** Create `tests/plugin-only.test.ts` with `describe("plugin only")` and the test
  `"every src module is in the bundle's import graph, apart from the known-dead list"`:
  - dynamically import `scripts/bundle-options.mjs` (as `tests/script/bundle-reproducible.test.ts` does);
  - `build({ ...buildOptions(root), write: false, metafile: true })`;
  - `reachable = Object.keys(metafile.inputs).filter(p => p.startsWith("src/"))`;
  - list every `.ts` file under `src/` with `readdirSync(..., { recursive: true })`;
  - `expect(all.filter(p => !reachable.includes(p) && !TYPE_ONLY.includes(p)).sort()).toEqual([...KNOWN_DEAD].sort())`;
  - `TYPE_ONLY = ["src/api/types.ts"]`; `KNOWN_DEAD = []`.
- [ ] Run `npm test -- tests/plugin-only.test.ts`. Expect FAIL, listing exactly the 29 files in B's first table.
  Copy that output into `KNOWN_DEAD`, with a one-line comment that each deletion task shrinks it. Run it again.
  Expect PASS.
- [ ] Sabotage: add an empty `src/zz-unused.ts`. Expect exactly this test to go red. Delete the file.
- [ ] **`callCommand` matches the script.** In `tests/commands/registry.test.ts`, replace
  `"gives the same text through the registry as through the MCP tool for the same input"` with
  `"gives callCommand the script's own output, error text included"`. For each of
  `["validate_profile", { profile }]`, `["list_filters", {}]` and `["get_onsite_preferences", {}]`, plus
  `["match_sessions", { profile }]` against an **empty** store (a `CatalogMissingError`), spawn the bundle as
  `tests/script/main.test.ts` does (`--json`, `REINVENT_SCOUT_HOME` set to the temp home). Then:
  - on success: `expect(callCommand(...).text).toBe(stdout.trim())`;
  - on error: `expect(callCommand(...).text).toBe(JSON.parse(stdout).error)`, and `isError` is true exactly when
    the exit code is 1.
- [ ] Run. Expect FAIL on the `match_sessions` case: `toToolError` appends "(needs catalog_sync and a signed-in
  session.)".
- [ ] Rewrite `tests/helpers/call-command.ts` to use `toCommandError` from `src/commands/errors.ts`. Return
  `{ text, isError, reason? }`; on error, `text` is `toCommandError(err).error`, and `reason` is added with a
  conditional spread (`exactOptionalPropertyTypes`). Update the doc comment: "the same output the script
  prints".
- [ ] Run `npm test -- tests/commands tests/skill tests/onsite`. Expect PASS. A test that asserted an MCP-only
  suffix would fail here. None is expected (none was found by grep for `needs catalog_sync` or
  `needs a local rebuild` outside `tests/mcp` and `tests/cli`); fix any that does by asserting the script's
  text.
- [ ] Sabotage: make the helper return `String(err)`. The new parity test and `commands/import.test.ts`'s
  `/^shrunk:/` should go red. Revert.
- [ ] **`tests/skill/content.test.ts`:**
  - `DEFAULT_EVENT_ID` comes from `src/catalog/store.js`;
  - `"documents exactly the keys the real tool's response actually has"` calls
    `callCommand("validate_profile", ...)` instead of the MCP client;
  - `"documents the exact MCP lens enum ..."` is renamed `"documents the exact match_sessions lens enum ..."`.
    It reads the enum from `z.toJSONSchema(registry.match_sessions.inputSchema).properties.lens.enum`, and
    runs `validate_profile` and `match_sessions` through `callCommand`;
  - drop the `@modelcontextprotocol/sdk` imports and `createMcpServer`;
  - reword the two comments that cite `src/mcp/tools.ts` (around lines 399 and 417) to name the
    `match_sessions` command and drop the `accessTokenExpiresAt` example.

  Sabotage: change one value in the lens enum in `src/match/lens.ts`'s `LENSES`. The lens test should go red.
  Revert.
- [ ] **`tests/onsite/adapters.test.ts`:**
  - Delete `"MCP default resolver and CLI config reads create no store"`. In its place, add
    `"get_onsite_preferences through the script creates no store"`: spawn the bundle with `REINVENT_SCOUT_HOME`
    set to a missing directory, then check that the directory still does not exist.
  - Trim `"documented MCP preferences→confirmed nearby→printed ID reservation agrees with CLI"` to its registry
    half, renamed `"the documented on-site examples run through the commands"`. Keep the workflow.md
    examples, the two `nearby_sessions` calls and the `writes === 0` assertion (rename the counter to no
    reads, since no API client exists). Drop the CLI and the MCP `reserve_sessions` lines, and the
    `createApiClient`, `commander` and SDK imports.

  Sabotage for the new test: in `src/onsite/config.ts`, make `readOnsiteConfig` call
  `ensureDirWithMode(deps.storeRoot, 0o700)`. Expect red. Revert.
- [ ] **`tests/match/offering-times.test.ts`:** delete the last test (it drives `registerMatchCommands` and
  checks the CLI's printed `10:00-11:00` line), and the `commander` and CLI imports. The `endOf` and lean-
  response tests above it keep the domain assertions.
- [ ] **Ports for the coverage gaps in B.** Each case below is copied from the named MCP file, with
  `client.callTool({ name, arguments })` replaced by `callCommand(name, arguments, { storeRoot })`.
  "Equals the CLI's response" assertions become comparisons with the domain function, for example
  `buildMatchResponse(matchSessionsDetailed(...), limit, fits)`, or are dropped where the domain test already
  has them.
  - `tests/commands/focus.test.ts`, from `tests/mcp/focus.test.ts`:
    - the map shape;
    - a bad profile and a missing catalog are errors;
    - a focus returns the focus response;
    - the refusals: focus with lens, perTopic without focus, an unknown topic, a goal that does not apply,
      **and focus with limit** (no MCP test covered `registry.ts:193`; add it);
    - the 24 KiB budget at six choices, and the default of 3.
  - `tests/commands/levels.test.ts`, from `tests/mcp/levels.test.ts`: every `it` except the CLI-equality halves.
    This includes `map_profile` under `preferences` (registry 244) and the focus that echoes them
    (`response.ts` 206/253).
  - `tests/commands/filters.test.ts`, from `tests/mcp/filters.test.ts`:
    - one field, and an unknown one;
    - each field's list shortened, with `more`;
    - **within the output budget, however many values a field has** (registry 227–231);
    - a missing catalog is an error.

  Sabotage, one at a time, each making exactly the named test red:
  - delete the `focus !== undefined && limit !== undefined` throw;
  - make the `list_filters` loop return the first response;
  - drop the `preferences` spread in `mapProfileCommand`.
- [ ] **`tests/core/atomic-write.test.ts`:** add `"removes the temp file when the write fails"`. Point
  `writeFileAtomic` at a target whose parent is a regular file, or make `renameSync` fail by targeting an
  existing directory. Assert that it throws and that no `*.tmp*` sibling is left. Sabotage: delete the
  `unlinkSync(tempPath)` line. Expect red. Revert.
- [ ] **Re-measure.** Run `npm i --no-save @vitest/coverage-v8@<vitest's version>`. Run the suite with coverage
  twice, once whole and once excluding every test file this PR deletes. Diff statement coverage over the live
  modules (the scratch `covdiff.mjs` method in B).
  - The only lost statements left must be in the dead exports of B and in `reservations.ts` (Task 3 covers
    line 19).
  - Each remaining lost branch is either ported or listed with a reason in the commit body. For example,
    `paths.ts:22` is the default `os.homedir` and is not tested, because a test must not touch the real home.
  - Afterwards, run `git checkout package.json package-lock.json`, if `--no-save` touched them.
- [ ] Run `npm run check`. Expect PASS. Bundle: byte-identical.
- [ ] Commit: `test: move the surviving tests onto the commands and the script; guard the bundle's import graph`.

### Task 2: Delete the CLI, the local MCP server, the installer and the legacy adapters
These go in one commit because `cli/commands/mcp.ts` imports `mcp/server.ts`, and `mcp/server.ts` imports
`cli/version.ts`. Neither half compiles without the other.

- [ ] **Failing guard.** In `tests/plugin-only.test.ts` add `"no source or test file imports the MCP SDK,
  commander, or a removed directory"`. It reads every `.ts` file under `src/` and `tests/`, takes each
  `from "..."` and `import("...")` specifier, and fails on:
  - `@modelcontextprotocol/sdk` or `commander`;
  - a relative path that resolves into `src/{cli,mcp,skill,legacy}/` or to `src/profile/store.ts`.
- [ ] Run. Expect FAIL (`src/cli/**` imports commander; `src/mcp/**` imports the SDK).
- [ ] Delete:
  - src: `src/cli/**`, `src/mcp/**`, `src/skill/**`, `src/legacy/**`, `src/profile/store.ts`;
  - tests: `tests/cli/**`, `tests/mcp/**`, `tests/legacy/**`, `tests/skill/install.test.ts`,
    `tests/skill/update.test.ts`, `tests/smoke.test.ts`, `tests/profile/store.test.ts`.
- [ ] Before each test file goes, check it against the B coverage diff that Task 1 already applied. Anything it
  asserts about a *live* module that no surviving test asserts gets ported now, and is listed in the commit
  body. (Task 1's re-measure should mean there is nothing left. Say so if that is the case.)
- [ ] **`tests/docs.test.ts`:** delete the `"README command coverage"`, `"README match output examples"`,
  `"README .mcp.json example"` and `"README rationale"` describes, and the `buildProgram` and `commander`
  imports. Keep `"README example profile"` and `"README: Install as a Claude Code plugin"`. The README itself is
  unchanged until Task 12, and both kept describes pass against it.
- [ ] Remove the deleted files from `KNOWN_DEAD`.
- [ ] `npm uninstall @modelcontextprotocol/sdk commander`, which rewrites the lockfile.
- [ ] Run `npm run check`. Expect PASS. Bundle: byte-identical (simulated).
- [ ] Sabotage: restore `src/cli/version.ts` alone (`git checkout HEAD~1 -- src/cli/version.ts`). Both the
  import guard and the dead-module guard should go red. Remove the file again.
- [ ] Commit: `refactor: remove the reinvent-scout CLI, the local MCP server and the skill installer`. In the
  body, list the deleted LOC and that the bundle is byte-identical.

### Task 3: Move session-id validation out of `reservations.ts`
- [ ] Write `tests/schedule/session-ids.test.ts` for `validateSessionIds` from `src/schedule/session-ids.ts`:
  - it trims each id and removes duplicates in order (`[" a ", "b", "a"]` → `["a", "b"]`);
  - it accepts `[]`;
  - it rejects 51 ids, an empty id, a non-string, and an id of 129 code points (with 128 accepted: count by
    `Array.from`, so `"界".repeat(128)` passes). Each rejection is a `ValidationError` with the message
    "Expected 0–50 session IDs, each 1–128 characters.".
- [ ] Run `npm test -- tests/schedule/session-ids.test.ts`. Expect FAIL: the module does not exist.
- [ ] Create `src/schedule/session-ids.ts`:
  - `MAX_RESERVATION_IDS = 50` and `MAX_SESSION_ID_LENGTH = 128`;
  - `validateSessionIds(input: readonly string[]): string[]`, the current body without the `allowEmpty` and
    `writeLedger` branches, keeping the "Trim first" comment;
  - a doc comment: "Checks the ids `plan_schedule` is given: 0–50, each 1–128 characters after trimming.
    Returns them trimmed and de-duplicated."
- [ ] Point `src/schedule/plan.ts` (lines 7, 48, 111) and `src/commands/registry.ts` (lines 17, 146) at it,
  and drop the flag arguments.
- [ ] Add `src/schedule/reservations.ts`, `src/auth/oauth.ts`, `src/catalog/sync.ts` and
  `src/schedule/write-quota.ts` to `KNOWN_DEAD`: they now leave the graph. Task 4 deletes them.
- [ ] Run `npm run check`. Expect FAIL only on `bundle:verify`. Run `npm run bundle`, check the diff against C
  (Task 3 row), then run `npm run check`. Expect PASS.
- [ ] Sabotage: drop the `> MAX_SESSION_ID_LENGTH` condition. Only the 129-code-point case should go red.
  Revert, and rebuild the bundle.
- [ ] Commit: `refactor: session-id validation in its own module; plan_schedule keeps its exact checks`. Paste
  the bundle hunks into the body.

### Task 4: Delete sign-in, the API client and the schedule wrappers
- [ ] **Failing guard.** Extend the import guard so it also fails on relative imports that resolve into
  `src/auth/`, to `src/api/client.ts`, `src/catalog/sync.ts`, or
  `src/schedule/{favorites,reservations,schedule,write-quota}.ts`, from `src/` or `tests/`.
- [ ] Run. Expect FAIL. `src/schedule/merge.ts` imports `ScheduleSession` from `./schedule.js`, and
  `tests/schedule/merge.test.ts` imports types from it too.
- [ ] Move `ResolvedScheduleSession`, `UnresolvedScheduleSession` and `ScheduleSession` (with their doc
  comments, reworded so they no longer name `catalog sync` or `getSchedule`) from `schedule.ts` into
  `merge.ts`. Point `tests/schedule/merge.test.ts` there. `ScheduleResult` stays only as long as
  `mergeAndSortScheduleEntries` does; Task 5 removes both.
- [ ] Delete:
  - src: `src/auth/**`, `src/api/client.ts`, `src/catalog/sync.ts`, `src/schedule/{favorites,reservations,schedule,write-quota}.ts`;
  - tests: `tests/auth/**`, `tests/api/**`, `tests/integration/**`, `tests/catalog/sync.test.ts`,
    `tests/schedule/{favorites,reservations,schedule,write-quota}.test.ts`, `tests/helpers/fake-fetch.ts`.
- [ ] Remove the deleted files from `KNOWN_DEAD`. The list should now be empty;
  keep the test and the empty constant, with the comment "Empty: add nothing here; delete the module instead."
- [ ] Run `npm run check`. Expect PASS. Bundle: byte-identical.
- [ ] Sabotage: add `src/zz.ts` containing `import "./auth/oauth.js";`. The import guard should go red (and
  typecheck). Delete it.
- [ ] Commit: `refactor: remove PKCE sign-in, the API client and the schedule wrappers`.

### Task 5: Trim the schedule merge to session times, and fix the timezone advice
- [ ] In `tests/schedule/merge.test.ts`'s `describe("timezoneWarnings")`, add
  `"names the catalog-sync agent as the remedy, never a removed command"`. For each of the three non-empty
  cases (`unrecognized`, `syncedBeforeTimezoneSupport`, `omittedByApi`):
  - `expect(warning).not.toMatch(/catalog_sync|reinvent-scout catalog|personal-time/)`;
  - for the first two, `expect(warning).toContain("catalog-sync agent")`.
- [ ] Run. Expect FAIL.
- [ ] Reword in `merge.ts`:
  - **unrecognized:** "The stored event timezone (<value>) is not a recognized IANA timezone, so `startsAt`
    and `endsAt` could not be computed. Re-importing with the catalog-sync agent may resolve this, but is not
    guaranteed to: if `GetEvent` reports the same value again, importing again will not help."
  - **synced before timezone support:** "This catalog was imported before timezone support was added, so
    `startsAt` and `endsAt` could not be computed. Re-import it with the catalog-sync agent; that will very
    likely resolve this."
  - **omittedByApi:** "The event's timezone is unknown (GetEvent's response omitted it), so `startsAt` and
    `endsAt` could not be computed. Local dates and times are still correct."

  Keep "very likely resolve", "omitted it" and "not a recognized" for the existing assertions.
- [ ] Delete `mergeAndSortScheduleEntries`, `compareMergedEntries`, `toSessionEntry`, `toPersonalTimeEntry`,
  `MergedScheduleEntry`, `ScheduleEntryKind`, `ScheduleResult` and the `PersonalTime` import, with their tests.
  Rewrite the module doc comment. Lint's `no-unused-vars` must then be clean.
- [ ] `git mv src/schedule/merge.ts src/schedule/session-times.ts` and
  `git mv tests/schedule/merge.test.ts tests/schedule/session-times.test.ts`. Update the imports in
  `src/catalog/lookup.ts`, `src/schedule/plan.ts` and the test.
- [ ] `npm run bundle`, then check the diff against C (Task 5 row). Run `npm run check`. Expect PASS.
- [ ] Sabotage: put back the old `catalog_sync` sentence in the `syncedBeforeTimezoneSupport` branch. Only the
  new test should go red. Revert, and rebuild.
- [ ] Commit: `fix(lookup): timezone warnings name the catalog-sync agent; keep only session times`.

### Task 6: Remove the API errors
- [ ] In `tests/core/errors.test.ts`, delete the `AuthRequiredError`, `NotRegisteredError` and
  `ThrottledError` describes. Narrow the last describe to `ValidationError`. Add
  `"exports only the errors the plugin raises"`: `Object.keys(await import("../../src/core/errors.js")).sort()`
  equals `["CatalogMissingError", "CatalogUnusableError", "ValidationError"]`.
- [ ] Run. Expect FAIL (extra exports).
- [ ] Remove from `src/core/errors.ts`: `AuthRequiredError`, `NotRegisteredError`, `ThrottledError`,
  `NotFoundError`, `OperationUnavailableError`, `ServiceError`, `EmptyCatalogError`, `markRequestNotSent`,
  `isRequestNotSent` and their symbol. Reword the `CatalogUnusableError` doc comment, which names
  `catalog sync --reindex` and the MCP tools, to name `catalog_import` `action: "reindex"`.
- [ ] Run `npm run check`. Expect PASS. Bundle: byte-identical (the removed classes are already tree-shaken; 0
  occurrences in the bundle).
- [ ] Sabotage: re-add `export class ServiceError extends Error {}`. Only the new test should go red. Revert.
- [ ] Commit: `refactor: remove the API error types`.

### Task 7: `api/types.ts` becomes `src/aws/types.ts`
- [ ] In `tests/plugin-only.test.ts`, change `TYPE_ONLY` to `["src/aws/types.ts"]`. Run. Expect FAIL:
  `src/api/types.ts` is unreachable and not allowed, and `src/aws/types.ts` does not exist.
- [ ] `git mv src/api/types.ts src/aws/types.ts`. Delete `BulkFailureCode`, `BulkFailure`, `BulkResult`,
  `Event` and `ListSessionsResponseContent`, and reword the header comment ("the shapes the AWS Events MCP
  returns").
- [ ] Rewrite every importer:

  ```sh
  grep -rl 'api/types' src tests | xargs sed -i '' 's#api/types\.js#aws/types.js#'
  ```

  Then check with separate greps for `api/types`, `api/client` and `"../api/` (expect none) and `aws/types`
  (expect the same file count as before). Comments that say "api/types.ts" (for example the one in
  `session-times.ts`) are updated too.
- [ ] Run `npm run check`. Expect PASS. Bundle: byte-identical.
- [ ] Commit: `refactor: the AWS record types live in src/aws/types.ts`.

### Task 8: Remove the exports nothing calls
Each item: delete the export and its private helpers, then delete or port its tests as said. Run
`npm run lint` after each, so that `no-unused-vars` finds orphaned helpers.

- [ ] **`resolveSessionRecord`** (`catalog/query.ts`). In `tests/catalog/query.test.ts`, rewrite each case in
  `describe("resolveSessionRecord")` to call `resolveSessionToken(requireCurrentIndex({ storeRoot }), token)`,
  and rename the describe `"resolveSessionToken against a stored catalog"`. The missing-catalog case expects
  the throw from `requireCurrentIndex`. Delete `"is the logic resolveSessionRecord uses"`, and reword the
  `"... like resolveSessionRecord"` title. Run before deleting: PASS (same logic). Delete the export. Run:
  PASS. Sabotage: make `resolveSessionToken` skip the case-insensitive abbreviation match. The ported case
  should go red. Revert.
- [ ] **`ensureStoreRoot`** (`core/paths.ts`). In `tests/core/paths.test.ts`, port its four cases (mode 0700,
  refuses a file at the path, does not widen an existing mode, creates missing parents at 0700) to
  `ensureDirWithMode(root, STORE_DIR_MODE)`, renamed `describe("ensureDirWithMode")`. Delete the export, and
  reword the `ensureDirWithMode` doc comment ("currently: the token store") and the "the CLI and the MCP
  server share one store" comment to name the script's concurrent runs. Sabotage: delete its
  `chmodSync(path, mode)`. The 0700 cases should go red. Revert.
- [ ] **`profileTopics`** (`match/focus.ts`), **`resolveTopic`, `bare`, `names`, `Nameable`**
  (`match/map.ts`): there are no tests. Delete them.
- [ ] **`describePreferences`** (`match/preferences.ts`): delete its assertions in `tests/match/formats.test.ts`
  (line 111) and `tests/match/facets.test.ts` (line 197). They test the CLI header line, which nothing prints
  now. Delete the export, and any helper lint then reports as unused.
- [ ] **`formatEventLocalTime`** (`schedule/timezone.ts`): delete its describe in
  `tests/schedule/timezone.test.ts`, and the export.
- [ ] Run the scratch unused-export scan again (B). Expect no export in a live module with neither another
  live caller nor its own use, apart from deliberate test-facing constants (`LENS_RULE_SELECTORS`, which the
  content test reads).
- [ ] Run `npm run check`. Expect PASS. Bundle: byte-identical (each name has 0 occurrences in the bundle).
- [ ] Commit: `refactor: remove the exports only the CLI called`.

### Task 9: Remove the registry's legacy hooks, and the comments about removed callers
- [ ] In `tests/plugin-only.test.ts` add `"no source file describes a removed surface"`. For every file under
  `src/`, `expect(text, file).not.toMatch(...)` for
  `/\bCLI\b|MCP server|MCP tool|catalog_sync|get_schedule|get_session|reserve_sessions|cancel_reservation|favorite_sessions|unfavorite_session|reinvent-scout (?:auth|catalog|profile|match|schedule|skill|mcp)\b|errorMaxChars|signed-in session/`.
- [ ] Run. Expect FAIL. The hits found on `41104dc`, after Tasks 2–8:
  - `catalog/query.ts:197`;
  - `catalog/store.ts:19, 45, 188`;
  - `commands/registry.ts:39, 44, 45, 65, 118, 160, 251, 258, 339`, and the `MAX_FOCUS_PER_TOPIC` comment
    ("The CLI, with no budget, takes up to 10");
  - `match/response.ts:29, 33, 127–129, 216`;
  - `profile/profile.ts:109`;
  - `profile/report.ts:3, 109`.
- [ ] Remove `errorMaxChars` from `CommandDefinition` and the three commands. Reword each comment to describe
  the script and its 24 KiB budget, without changing any code. Where a comment explains a default that existed
  only for the CLI (`buildMatchResponse`'s `fits = () => true`, "the CLI has no budget"), reword it to say the
  default accepts everything. The default stays: changing the signature is not deletion.
- [ ] `npm run bundle`, then check the diff against C (Task 9 row). Run `npm run check`. Expect PASS.
- [ ] Sabotage: re-add `errorMaxChars?: number;`. Only the new test should go red. Revert, and rebuild.
- [ ] Commit: `refactor: drop the registry's MCP-only error cut and the comments about removed callers`.

### Task 10: `package.json`, `eslint.config.js`, and a scan for references to removed paths
- [ ] In `tests/plugin-only.test.ts` add:
  - **`"package.json is a private plugin package"`:**
    - `private === true`, no `bin`, no `files`, no `scripts.build`;
    - `scripts.check === "npm run typecheck && npm run lint && npm run test && npm run bundle:verify"`;
    - `dependencies` is exactly `["zod"]`;
    - `description` contains "Claude Code plugin";
    - every `node <path>` in `scripts` names a file that exists.
  - **`"no config or doc names a removed path or command"`:** for each of `package.json`, `eslint.config.js`,
    `tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`, every `.github/workflows/*.yml`,
    `scripts/*.mjs`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.mcp.json`,
    `plugin/agents/*.md`, every `.md` under `plugin/skills/`, and `CLAUDE.md`, the text must not match
    `/src\/(?:cli|mcp|skill|auth|api|legacy)\b|dist\/cli|tests\/(?:cli|mcp|auth|api|integration|legacy)\b|fake-fetch|@modelcontextprotocol|\bcommander\b|skill (?:install|update)|reinvent-scout mcp|npm run build/`.
    README.md is added to this list in Task 12, once it is rewritten.
- [ ] Run. Expect FAIL. The `package.json` test fails on `bin` and `build`. The scan fails on
  `eslint.config.js` (`src/cli/**`, `src/cli/commands/mcp.ts`) and on `CLAUDE.md` (`src/cli/commands/**`,
  `src/mcp/**`, `npm run build`).
- [ ] **`package.json`:**
  - add `"private": true`;
  - delete `bin`, `files` and `scripts.build`;
  - `check`: `npm run typecheck && npm run lint && npm run test && npm run bundle:verify`;
  - `description`: "A Claude Code plugin: match re:Invent sessions to your code and manage your schedule
    through the AWS Events MCP, with a local catalog index."
- [ ] **`eslint.config.js`:** delete the `src/cli/**/*.ts` exemption and the `src/cli/commands/mcp.ts` block.
  Delete the `src/script/**` and `src/commands/**` block: the `**/*.ts` rule already makes `no-console` an
  error everywhere outside `tests/`. Move its comment ("stdout carries exactly one JSON document, so nothing in
  src may print") onto the `**/*.ts` block.
- [ ] **`tests/lint-config.test.ts`**, replacing the deleted `tests/mcp/eslint-console.test.ts` with ESLint's
  `calculateConfigForFile`:
  - `no-console` is 2 for `src/script/main.ts`, `src/commands/registry.ts`, `src/catalog/import.ts` and
    `src/deeply/nested/new.ts`;
  - it is 0 for `tests/x.test.ts`.

  Sabotage: change the `**/*.ts` rule to `"warn"`. The src cases should go red. Revert.
- [ ] **`CLAUDE.md`** gets the minimal edits to pass the scan here. Its full rewrite is Task 13.
- [ ] Run `npm ci` to check that the lockfile matches, then `npm run check`. Expect PASS. Bundle: byte-identical.
- [ ] Sabotage: put `bin` back. The `package.json` test should go red. Revert.
- [ ] Commit: `chore: a private plugin package; lint config without the CLI exemptions`.

### Task 11: The skill names no CLI
- [ ] In `tests/skill/content.test.ts`'s `"names no CLI subcommand anywhere in the skill's files"`, add, over
  `allSkillText`:
  - `not.toMatch(/`--(?:level|only|prefer|avoid|exclude|per-topic|verbose|focus|lens|limit|profile)\b/)`;
  - `not.toMatch(/\bthe CLI(?:'s)?\b/)` (this still allows "the AWS CLI" and "a registered CLI command" in
    `profiling.md`, which are about the user's code);
  - `not.toMatch(/\bMCP drops\b|whole-candidate MCP budget/)`.

  In `"documents the preferences argument ..."` (line 1020), delete "`--level 400-500` is the CLI form".
- [ ] Run. Expect FAIL. The hits are the lines listed in Decision 1, plus `workflow.md:281`, `:292` and `:539`.
- [ ] Edit the skill references:
  - **`workflow.md:190`:** delete the `--only`/`--prefer` "CLI form" sentence;
  - **`:192`:** "the same rule as `search_sessions`' level range" replaces "the same rule as
    `catalog search --level`";
  - **`:196`:** delete "`--level 400-500` is the CLI form, on `match` and `profile map`.";
  - **`:198`:** delete "; the CLI's `--per-topic` takes up to 10";
  - **`:281`:** "the script drops every candidate's ranking reasons first";
  - **`:283`:** delete the `--verbose` sentence;
  - **`:292`:** "so the script drops it first";
  - **`:539`:** "the same whole-candidate output budget";
  - **`taxonomy.md:161`:** "what spellings `validate_profile` resolves automatically";
  - **`profiling.md:137`:** "though `validate_profile` will resolve either".
- [ ] Run `npm test -- tests/skill`. Expect PASS. Sabotage: put the `:196` sentence back. Only the new
  assertion should go red. Revert.
- [ ] Run `npm run check`. Expect PASS. Bundle: byte-identical (only skill docs changed).
- [ ] Commit: `docs(skill): name the script's arguments, not the removed CLI's flags`.

### Task 12: Rewrite the README for the plugin only
- [ ] **Rewrite `tests/docs.test.ts` first.** Keep:
  - `"README example profile"`, unchanged;
  - the permission-rule test, with its matcher and attack strings, the `<your-claude-dir>` sentence, both
    prefixes, no write tool, and "keep their prompt";
  - the awsevents-entry test;
  - the data-location test.

  The last three now read their sections by heading: `## Install`, `## Permissions`, `## Where your data
  lives`. The "ahead of the legacy install" assertion goes. Add:
  - **section order:** the sections `## Install`, `## Permissions`, `## Use the skill`, `## How it works`,
    `## Where your data lives` and `## Development`, in that order, and no other `## ` headings;
  - **`## How it works`** matches `/never passed through agent context/i`, contains `catalog-sync`, contains
    `api.awsevents.com/mcp`, and contains "24 KiB";
  - **no CLI:** no line matches `/^\s*(?:\$ )?reinvent-scout [a-z]/`, no backtick span matches
    `/^reinvent-scout [a-z]/`, there is no `mcpServers` JSON block, and nothing matches
    `/--(?:level|only|prefer|avoid|exclude|focus|lens|verbose|json)\b/` outside the script's own
    `--json '<one-line JSON>'` and `--input` usage;
  - **every lowercase snake_case backtick span** is a registry command, or in an allow-list
    (`["node_modules"]`, asserted unregistered, as content.test does);
  - **`## Where your data lives`** says an old `tokens.json`, and an old `profiles/` directory, can be deleted
    (`/tokens\.json.*can be deleted/`).
- [ ] **Triage the README pins in `tests/skill/content.test.ts`.** Keep the exact text of:
  - "preferring one about what you will learn, build or see over the abstract's opener" (l.367);
  - "overlap and \"can I attend both\" are `plan_schedule` questions, never guessed from the times" (l.380);
  - "a \"Not shown\" line naming the platform services" (l.391);
  - "`uncovered`" (l.648);
  - "rankingReasonsOmitted" (l.974);
  - "`demoted`" (l.991);
  - "about a technology the code does not use" (l.1002);
  - "#### Chalk talks more than anything, no workshops, only this venue", "demoted sessions still come last",
    "`preferences: { levels, rules: [{ field, value, action, levels? }] }`" and "#### What can I filter on?"
    (l.1047);
  - "#### Only the levels you want", "filtering removes sessions, the remaining ones are re-ranked by the same
    rules" and "none at 400-500" (l.1053);
  - "### Map your code, then choose what to look for", "**understand**", "**deepen**", "**improve**" and
    "title names the topic" (l.1081);
  - "Watch a full session" (l.1097);
  - "tries to put back" (l.1225).

  Drop or replace:
  - drop "--verbose" (l.973) and rename the test `"documents rankingReasonsOmitted in the README"`;
  - drop the `--only venue:mgm --prefer ...` CLI line and "reinvent-scout catalog filters --field venue", and
    add "`list_filters` with `field: \"venue\"`";
  - drop "`--level 400-500`" and rename that test `"documents level ranges in the readme"`;
  - drop "reinvent-scout profile map --profile" and the `--focus "DynamoDB:..."` line;
  - replace "`--focus` replaces `--lens` and `--limit`" with "`focus` replaces `lens` and `limit`", and rename
    the test `"documents the map, the focus and the three goals in the readme"`.
- [ ] Add `README.md` to Task 10's reference scan list.
- [ ] Run `npm test -- tests/docs.test.ts tests/skill/content.test.ts tests/plugin-only.test.ts`. Expect FAIL
  (old headings, CLI lines, the `.mcp.json` block, PKCE).
- [ ] **Rewrite `README.md`** (about 250 lines; the current one is 771):
  - **intro:** a Claude Code plugin; a skill, one bundled script, a sync agent, and the AWS Events MCP for
    every AWS call;
  - **`## Install`:** the two `/plugin` commands; a local shell and a persistent home; sign-in on localhost
    port 8484; `### If you already have an awsevents server`, moved as it is;
  - **`## Permissions`:** the existing rule block and its explanation, as they are;
  - **`## Use the skill`:**
    - what to ask ("sessions for this repo", "sync the re:Invent catalog");
    - `### Map your code, then choose what to look for` (map → focus, the three goals, `focus` replaces
      `lens` and `limit`, title names the topic);
    - `#### Only the levels you want`;
    - `#### Chalk talks more than anything, no workshops, only this venue`;
    - `#### What can I filter on?`;
    - `### Lenses` (explain and `uncovered`; fix; next-level; all and `demoted`; off-stack; the
      `sessionSays` sentence; the "Not shown" line; `rankingReasonsOmitted`);
    - `### Writing a profile` (the one JSON example profile; take it from the current README);
    - `### Plan and reserve` (the `plan_schedule` overlap sentence; writes need the user's confirmation);
    - `### Watch a full session` ("tries to put back");
    - `### Nearby sessions on site`, rewritten from the CLI version around `get_onsite_preferences`,
      `set_onsite_preferences` and `nearby_sessions`. Keep the walk-up, routes and freshness rules. The
      onsite-patch JSON example stays, as an argument to `set_onsite_preferences`;
  - **`## How it works`:**
    - the catalog is never passed through agent context;
    - the catalog-sync agent pages `ListSessions` into `catalog_import` from saved files;
    - the shrink guard and the change diff (`catalog_changes`, `status.lastImport`);
    - every AWS call goes through `https://api.awsevents.com/mcp`;
    - the 13 commands, each output held to 24 KiB because Claude Code's Bash output cap is 30,000 characters;
  - **`## Where your data lives`:**
    - `~/.reinvent-scout` / `REINVENT_SCOUT_HOME`;
    - `catalog/` (the raw records, index, meta and last changes, all `0700`/`0600`);
    - the import staging;
    - `onsite.json`;
    - an old `tokens.json` and `profiles/` from the removed CLI can be deleted; the plugin never reads them;
    - nothing is sent anywhere by the script; AWS calls are the MCP's;
  - **`## Development`:** `npm ci`, `npm run check` (what it runs), `npm run bundle` after any `src/` change,
    `bundle:verify` in CI, `claude plugin validate ./plugin --strict`.
- [ ] Run the three test files. Expect PASS. Sabotage, one at a time, each turning only its own test red, then
  revert:
  - put a `reinvent-scout catalog sync` line back;
  - remove "can be deleted";
  - rename `## Development`.
- [ ] Run `npm run check`. Expect PASS. Bundle: byte-identical.
- [ ] Commit: `docs(readme): rewrite as a Claude Code plugin`.

### Task 13: CLAUDE.md for the plugin
There is no new test beyond Task 10's scan; the reviewer checks the prose. Per the 2026-10-12 plan, A7:
- [ ] **Commands:** `test`, `typecheck`, `lint`, `bundle` (rebuild after any `src/` change; the bundle is
  committed), `bundle:verify` (fails on a stale bundle), and `check` (typecheck, lint, test, bundle:verify; CI
  runs it). `build` goes.
- [ ] **Core vs. adapter:**
  - the domain is `src/catalog/**`, `src/match/**`, `src/profile/**`, `src/schedule/**` and `src/onsite/**`,
    plus `src/core/**`;
  - `src/commands/registry.ts` is the one adapter layer: parse input with the command's schema, call one domain
    function, bound the output;
  - `src/script/main.ts` is only argv, stdin and stdout;
  - business logic in `src/commands` or `src/script` is a review rejection.

  The old wording about the CLI and "phase 3 MCP" goes.
- [ ] **Agentic first:** every AWS call goes through the plugin's `awsevents` MCP; nobody adds an API wrapper.
  Code earns its place only for the local catalog import, index, search and match, and for keeping session data
  out of context.
- [ ] **Injection:** the network bullet (`fetchFn`) and the PKCE bullet go. Add the `randomId?: () => string`
  bullet (`CommandDeps`). `tests/helpers/fake-fetch.ts` is no longer mentioned.
- [ ] **New "Plugin" section:**
  - the layout (`.claude-plugin/marketplace.json`, `plugin/` with its manifest, `.mcp.json`, the agent, the
    skill and the committed bundle);
  - one JSON document on stdout, exits 0/1/2;
  - the 24 KiB output budget and its reason;
  - `tests/plugin-only.test.ts` and the empty `KNOWN_DEAD` list (delete a dead module; never list it).
- [ ] Keep the `exactOptionalPropertyTypes` and "Verify a test by deleting the implementation" sections, but
  replace their examples that name the API client's pagination and `login`'s deps with `importCatalog`'s
  deps.
- [ ] Run `npm run check`. Expect PASS.
- [ ] Commit: `docs: CLAUDE.md for the plugin architecture`.

### Task 14: Final sweep, and the PR
- [ ] Run separate greps over `src`, `tests`, `plugin` (excluding the bundle), `README.md` and `CLAUDE.md`:
  - `catalog_sync`, `get_schedule`, `get_session`, `favorite_sessions`, `unfavorite_session`,
    `reserve_sessions`, `cancel_reservation`;
  - `auth login`, `buildApiClient`, `ApiClient`, `createApiClient`, `McpServer`, `createMcpServer`,
    `registerTool`, `toToolError`, `skill install`, `fake-fetch`, `tokens.json`;
  - `profile save`, `catalog show`, `schedule show`, `--verbose`;
  - `--json`: expect only the script's own flag (`src/script/main.ts`, `tests/script/main.test.ts`,
    `SKILL.md`, the agent, the README permission text).

  Expect zero other hits, apart from deliberate negative samples in tests (the `not.toMatch` lists) and the
  README's "an old `tokens.json` can be deleted". `docs/plans/**` is history and is not touched.
- [ ] Run the import graph again (B's esbuild metafile script). Expect no `src/` file outside the graph except
  `src/aws/types.ts`. This is the same check as `tests/plugin-only.test.ts`; run it once by hand and paste the
  output into the PR body.
- [ ] Byte-compare the bundle with `41104dc`: `git diff --stat 41104dc -- plugin/skills/reinvent-scout/scripts/`.
  Confirm the hunks are exactly C's rows for Tasks 3, 5 and 9.
- [ ] Run `npm ci && npm run check` on Node 22.13.0 if available (CI covers it anyway). If `claude` is on PATH,
  run `claude plugin validate ./plugin --strict` and `claude plugin validate . --strict`.
- [ ] Count the LOC: `git diff --shortstat 41104dc -- src tests` and the same for `README.md CLAUDE.md plugin`,
  excluding `package-lock.json` and the bundle.
- [ ] Hand off to the reviewer for the pre-PR review. Push only after "Approve ✓". Before opening the PR, check
  #20's state.
- [ ] Open the PR with the title and body above. The body has:
  - the summary;
  - the deleted LOC;
  - the import-graph output;
  - the bundle diff summary (C);
  - the coverage ports (B);
  - "Decisions made during implementation" (A, plus anything new);
  - no version bump (Decision 6), as a note for the user;
  - "Residual risks".

---

## D. Self-review

- **Every requirement covered:**
  - delete the CLI, the MCP server and the installer: Task 2;
  - `src/legacy/api-adapters.ts`: Task 2;
  - sign-in, PKCE, the token store and the API client: Task 4;
  - the wrapper domain: Tasks 3–6;
  - dead exports: Task 8;
  - an import graph, not grep: B, `tests/plugin-only.test.ts`, Task 14;
  - every deleted file, with why it is dead: B;
  - keep what the 13 commands use: the guard asserts the graph, and the bundle is byte-identical except C's
    three expected diffs;
  - the README: Task 12;
  - CLAUDE.md: Tasks 10 and 13;
  - closing #22 and #20: the PR body;
  - checks of bin and scripts, eslint, tsconfig, CI, the content tests that pin the README and the skill, and
    the `.claude-plugin` files: Tasks 10, 11 and 12, and the Files list ("Unchanged (each checked)").
- **TDD:** every task that changes behavior or a guard starts with a failing test and has a named sabotage.
  Pure deletions are guarded by the import and dead-module tests (red before the deletion), `npm run check`,
  and a byte-identical bundle.
- **Consistent names:**
  - `tests/plugin-only.test.ts`, `KNOWN_DEAD`, `TYPE_ONLY`;
  - `src/schedule/session-ids.ts` with `validateSessionIds(input)`, `MAX_RESERVATION_IDS`,
    `MAX_SESSION_ID_LENGTH`;
  - `src/schedule/session-times.ts` with `deriveSessionTimes`, `timezoneWarnings`, `ScheduleSession`;
  - `src/aws/types.ts`;
  - `callCommand` returning `{ text, isError, reason? }`.
- **Order:**
  - Task 1 moves tests off the code before Task 2 deletes it;
  - Task 3 extracts before Task 4 deletes `reservations.ts`;
  - Task 4 moves the `ScheduleSession` types before deleting `schedule.ts`;
  - Task 5 renames after Task 4;
  - Task 7's sed runs after every deletion, so it touches only survivors;
  - the README scan is added in Task 12, after the rewrite, so Task 10 stays green.
- **Every commit stays green:** each task ends in `npm run check`, and `KNOWN_DEAD` changes with each
  deletion.
- **Edge cases with a task:**
  - an empty id list, the 128/129 code-point boundary, de-duplication (Task 3);
  - a failed atomic write (Task 1);
  - a missing store on a read (Task 1);
  - all three timezone states (Task 5);
  - focus with limit (Task 1);
  - the budget loop in `list_filters` (Task 1).
