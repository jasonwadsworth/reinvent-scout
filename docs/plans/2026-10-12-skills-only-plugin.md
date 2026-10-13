# Skills-only: reinvent-scout as a Claude Code plugin (#22)

Plan for jasonwadsworth/reinvent-scout issue #22, written against `main` at `0808632`. It supersedes #20, whose
change diff is part of sub-plan 1.

The user confirmed this direction on 2026-10-12:
- reinvent-scout is a **Claude Code plugin**: a skill, the skill's bundled scripts for the local catalog work,
  a sync subagent, and a `.mcp.json` declaring the official AWS `awsevents` MCP;
- every AWS call goes through that MCP;
- there is no local MCP server, no CLI and no custom skill installer.

The AWS MCP signs in through a localhost OAuth callback, so the plugin only runs locally (Claude Code, Claude
Desktop's Code tab, or the Agent SDK) with a shell and a persistent `~/.reinvent-scout`.

When the plan is committed, it goes to `docs/plans/2026-10-12-skills-only-plugin.md`.

**Why two PRs (risk isolation, plus size).**
- **Sub-plan 1 ships the plugin next to the legacy surfaces.** The legacy surfaces are the `reinvent-scout` CLI,
  its local MCP server and `skill install`. They keep working, but the skill no longer uses them. The user can
  install the plugin, run a real sync through the AWS MCP, and use every flow, while the old path is still
  there to fall back on. It is worth merging even if sub-plan 2 is cancelled: syncing and the schedule no longer
  need reinvent-scout's own sign-in, and the diff closes #20.
- **Sub-plan 2 is almost all deletion.** It removes the legacy surfaces, sign-in, the API client and the
  installer, and rewrites the README and CLAUDE.md. It merges only after one real plugin sync has succeeded.
- **Size.** Sub-plan 1 is about 3,400 lines of substantive change: about 1,100 src, 1,500 tests and 800 skill
  docs. Splitting it further would ship pieces that nothing can use yet, which the global rules forbid. Sub-plan
  2 is about 600 lines of rewritten docs and tests, plus roughly 6,000 src and 10,000 test lines deleted.

Each sub-plan merges independently and keeps `npm run check` green on every commit.

---

## A. Decisions made

### A0. Packaging, invocation and permissions

**Repository layout.**
- The repo root becomes a single-plugin **marketplace**. `/.claude-plugin/marketplace.json` lists one plugin:
  `{"name": "reinvent-scout", "owner": {"name": "Jason Wadsworth"}, "plugins": [{"name": "reinvent-scout", "source": "./plugin", "description": "…"}]}`.
- The plugin lives in **`plugin/`**, so an install copies only what runs, not `src/`, `tests/` or `node_modules`.
  Its contents:

  ```text
  plugin/
  ├── .claude-plugin/plugin.json            name, displayName, version (= package.json), description, author, repository, license
  ├── .mcp.json                             ONLY the AWS server: { "mcpServers": { "awsevents": { "type": "http", "url": "https://api.awsevents.com/mcp",
  │                                           "oauth": { "clientId": "7vmom55m1qstvq8i71ph127bfq", "callbackPort": 8484 } } } }
  ├── agents/catalog-sync.md                the sync subagent (A1)
  └── skills/reinvent-scout/
      ├── SKILL.md, reference/{workflow,watch,profiling,taxonomy}.md     moved from skills/reinvent-scout/
      └── scripts/reinvent-scout.mjs        the single bundled script (committed)
  ```

- **`.mcp.json` must carry the `oauth` block.** Checked on 2026-10-12:
  - `https://api.awsevents.com/.well-known/oauth-protected-resource` names a Cognito authorization server
    (`us-east-1_NdvQjp0vF`).
  - That server's OpenID configuration has **no `registration_endpoint`**, so dynamic client registration is
    impossible.
  - Claude Code therefore needs the public PKCE client id and its registered localhost callback port. The values
    come from the user's working `reinvent-planning/.mcp.json`: `clientId 7vmom55m1qstvq8i71ph127bfq`,
    `callbackPort 8484`.
  - The AWS docs (https://docs.aws.amazon.com/events/latest/devguide/mcp-server.html) say this client id is public
    and "shared by all callers", and that the callback port must be fixed: a random port fails with
    `redirect_mismatch`. So `.mcp.json` sets `oauth.clientId` and `callbackPort: 8484`, matching the planning
    repo's config. This is resolved and is not a user question.

**AWS tool names (namespacing).** Per the Claude Code MCP docs ("Plugin-provided MCP servers" and "Scope
hierarchy and precedence"):
- **What the plugin's server exposes.** It registers as `plugin:reinvent-scout:awsevents`, and its tools are
  `mcp__plugin_reinvent-scout_awsevents__<Tool>`, for example `mcp__plugin_reinvent-scout_awsevents__ListSessions`.
  Permission rules, `allowed-tools` and an agent's `tools:` field need that full name.
- **Duplicates are matched by endpoint.** Claude Code deduplicates a plugin server against user, project and
  local servers by endpoint, not by name. User scope outranks plugins. A user who already has `awsevents` at
  `https://api.awsevents.com/mcp`, as this user does at user scope and in the planning repo's project
  `.mcp.json`, gets **one** connection: their own. The plugin's copy is suppressed, and the tools appear as
  `mcp__awsevents__<Tool>`.
- **When it is two servers.** A user config that spells the endpoint differently (another path, a query
  string, or a non-default port) is not a duplicate. Then both servers connect, and **each holds its own
  token, so the user signs in twice**, through the same port 8484, one after the other.
- **Decision: the skill accepts either name, and never asks the user to remove their own entry.**
  - In the usual case, the user's own server wins and the plugin's is hidden. Telling them to remove their
    entry would change nothing for the deduplicated case. It would also break their other projects, such as the
    planning repo's reservation-day flow, which uses `mcp__awsevents__*` directly.
  - Accepting both names costs one sentence in the skill and two entries in the agent's `tools:` list.
  - The README still explains the double sign-in for a non-duplicate spelling, and recommends the exact URL
    `https://api.awsevents.com/mcp` in any user-level entry, so it deduplicates.
- **How the docs name AWS tools.** The skill, workflow.md and watch.md write the **bare operation name**
  (`ListSessions`, `ReserveSessions`). One sentence near the top of `SKILL.md` and of the agent body says: "AWS
  Events tools are `mcp__plugin_reinvent-scout_awsevents__<Name>`, or `mcp__awsevents__<Name>` when your own
  `awsevents` server shadows the plugin's; use whichever is available."
- **The `catalog-sync` agent's `tools:`** lists both forms: `mcp__plugin_reinvent-scout_awsevents__GetEvent`,
  `mcp__plugin_reinvent-scout_awsevents__ListSessions`, `mcp__awsevents__GetEvent` and `mcp__awsevents__ListSessions`.
  Task 1.11 checks by hand that a `tools:` entry naming an absent server is ignored, not an error. If it is an
  error, drop `tools:` from the agent and rely on inheritance, which the subagent docs say covers all parent MCP
  tools.
- **The README permission rule** lists the read-only AWS tools under both prefixes (see the permission
  allowlist below).

**Invocation.** One entry point dispatches every local command:

```text
node "${CLAUDE_SKILL_DIR}/scripts/reinvent-scout.mjs" <command> [--input <file> | --input -]
```

- `${CLAUDE_SKILL_DIR}` is substituted inside `SKILL.md` and the agent body. It isn't present in Bash's
  environment, so the docs always write the substituted form.
- Each command's input is **one JSON object**, the same shape as today's MCP tool argument. It is validated by
  the same zod schema and read from a file (`--input path`) or from stdin (`--input -`, usually a quoted
  heredoc). No `--input` means `{}`.
- Profiles and `GetSchedule` results travel inside that JSON. Where they can be large, there is a file-path
  field instead: `catalog_import.path`, `plan_schedule.scheduleFile` and `nearby_sessions.scheduleFile` (A4).
- **Output.**
  - Success: exactly one JSON document on stdout, exit code 0.
  - Command error: `{"error": "<message>"}` on stdout, plus `"reason"` where one exists, exit code 1.
  - Usage error (unknown command, unreadable `--input`, bad JSON): the same error object, exit code 2.
- Diagnostics go to stderr only. `--help` prints the command list as JSON. `--version` prints the version that
  esbuild `define`s from `package.json` at build time.
- The store root is `REINVENT_SCOUT_HOME` or `~/.reinvent-scout`, through `src/core/paths.ts`. Don't use
  `${CLAUDE_PLUGIN_DATA}`: it isn't in Bash's environment, and the user's existing catalog lives in
  `~/.reinvent-scout`.

**Output budget: 24 KiB of stdout, down from 30 KiB per MCP envelope.**
- **Why the cut.** Claude Code's Bash tool truncates output over its default `BASH_MAX_OUTPUT_LENGTH` of 30,000
  characters. A 30 KiB (30,720-byte) cap could be cut off mid-JSON.
- **Why it barely shrinks real responses.** The old figure measured the MCP envelope, where every `"` of the
  inner JSON is escaped. 24 KiB of raw JSON is about the same content as 30 KiB of envelope.
- **Where the logic lives.** `src/commands/output-budget.ts` holds `OUTPUT_BUDGET_BYTES = 24 * 1024` and
  `outputBytes(value) = Buffer.byteLength(JSON.stringify(value))`. Every budget loop that used `envelopeBytes`,
  `responseBytes` or `RESPONSE_BUDGET_BYTES` moves to it; the loops themselves don't change.
- **Verify before relying on it.** Confirm the 30,000 default in the current Claude Code docs during task 1.8,
  and record the source in the commit body.

**Command registry.** `src/commands/registry.ts` maps each command name to
`{ description, inputSchema, run(input, deps) }`. `run` returns `{ output }` or throws, and
`toCommandError(err)` turns the error into `{ error, reason? }`. The registry:
- holds the handler bodies that today live inside `registerTool` callbacks in `src/mcp/tools.ts`;
- is shared by the script and, during sub-plan 1 only, by the legacy MCP server, so the two can't drift (the
  rule in CLAUDE.md);
- keeps the snake_case MCP tool names as command names, so `workflow.md`'s contracts and the content test's
  identifier scanner keep working.

The thirteen commands are: `status`, `catalog_import`, `catalog_changes`, `lookup_sessions`, `search_sessions`,
`validate_profile`, `match_sessions`, `map_profile`, `list_filters`, `plan_schedule`, `nearby_sessions`,
`get_onsite_preferences` and `set_onsite_preferences`.

**Bundle.**
- `esbuild` is a new devDependency. `npm run bundle` builds `src/script/main.ts` into
  `plugin/skills/reinvent-scout/scripts/reinvent-scout.mjs` with
  `--bundle --platform=node --format=esm --target=node22.13 --legal-comments=none`, and
  `--define:__VERSION__="<package.json version>"`.
- The bundle is **committed**. A plugin install copies files and runs no build, and plugin installs never run
  `npm install`.
- `npm run check` gains `bundle:verify`. It bundles to a temp file and fails if the result differs byte for byte
  from the committed one, so CI catches a stale bundle. esbuild output is deterministic for fixed inputs and
  versions; pin `esbuild` to an exact version.
- The bundle has no runtime dependency outside Node's standard library: zod is inlined. Only `store.ts`,
  `onsite/config.ts` and the store code read files at runtime, and those are user files, so bundling breaks
  nothing.

**Permission allowlist.**
- **Main agent.** Plugins can't ship permission rules: a plugin's `settings.json` only honors `agent` and
  `subagentStatusLine`. So `SKILL.md` sets
  `allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/reinvent-scout.mjs *)`, which pre-approves the script
  for the turn that invokes the skill.
- **Later turns and the sync subagent.** These aren't covered by `allowed-tools`, and a plugin agent's
  `permissionMode` is ignored. The README gives the one rule to add to `~/.claude/settings.json`:
  `"permissions": { "allow": ["Bash(node *reinvent-scout/scripts/reinvent-scout.mjs *)", <each read-only AWS tool under both prefixes>] }`.
  - The read-only AWS tools are `ListEvents`, `GetEvent`, `ListSessions`, `GetSession` and `GetSchedule`.
  - Each is listed as `mcp__plugin_reinvent-scout_awsevents__<Name>` and as `mcp__awsevents__<Name>`.
- **Writes are never allowlisted.** `ReserveSessions`, `CancelReservation`, `AssociateFavorites` and
  `DisassociateFavorite` keep their prompt, which doubles as the confirmation step.
- **Test the wildcard.** Task 1.11 checks the rule's wildcard form against the current permission-rule docs
  and tests it manually.

**The sync subagent.** It is a plugin agent, `plugin/agents/catalog-sync.md`, invoked as
`reinvent-scout:catalog-sync`.
- Frontmatter: `tools: Bash, Read`, plus `GetEvent` and `ListSessions` under both prefixes (see AWS tool names
  above); `model: haiku` (a mechanical loop); `maxTurns: 40`.
- The body is the sync brief from A1, written with the `${CLAUDE_PLUGIN_ROOT}/skills/reinvent-scout/scripts/…`
  path, since the agent body has no `CLAUDE_SKILL_DIR`.
- MCP tools are inherited from the parent session, and a large `ListSessions` result is saved to a file in the
  subagent's context the same way as in the main agent.
- A plugin agent was chosen over a `context: fork` skill because it can restrict its tools and set its model,
  and the main skill can name it directly.

### A1. The `catalog_import` protocol

This is unchanged from the reviewed design. Only the surface is now a script command instead of an MCP tool.

**Actions.** The input is one strict object with `action: "page" | "commit" | "reindex"`, and the domain
function checks which other fields each action needs. `ValidationError` names the missing or disallowed field.

| action | Required | Optional | Not allowed |
|---|---|---|---|
| `page` (first) | `eventId`, `timezone` (string or `null`), exactly one of `path`/`page` | | `syncId`, `allowShrink` |
| `page` (later) | `syncId`, exactly one of `path`/`page` | | `eventId`, `timezone`, `allowShrink` |
| `commit` | `syncId` | `allowShrink` | `path`, `page`, `eventId`, `timezone` |
| `reindex` | | `timezone` | everything else |

**How a sync is identified.**
- A `page` call without `syncId` starts a sync. The new `syncId` comes from an injected
  `randomId?: () => string` that defaults to `crypto.randomUUID`.
- Every `syncId` the command accepts must match `^[a-z0-9-]{8,64}$` **before** it is joined into a path, so it
  can't be used for path traversal.
- An unknown `syncId` gives a `ValidationError` that says to start again.

**Staging.** Pages are staged under `<storeRoot>/catalog/staging/<syncId>/` (directories 0700, files 0600, via
`ensureDirWithMode` and `writeFileAtomic`):
- `manifest.json`: `{ schemaVersion: 1, syncId, eventId, timezone, createdAt, pages: [{ number, count, totalCount, nextToken|null }] }`
- `page-NNNN.json`: the validated `items`, stored verbatim with every field. The issue verified that AWS records
  match the stored raw records field for field.

Nothing else is needed for concurrency. The subagent calls the command sequentially, and a page that is
imported twice is rejected as `overlap`.

**Cleaning up abandoned syncs.** `pruneStaleStaging` runs when a new sync starts and after a successful commit:
- It removes staging directories whose manifest `createdAt` is more than 24 h old, and unreadable ones whose
  directory `mtime` is more than 24 h old.
- It calls `lstat` on `staging/` and on each entry, skips symlinks, and only ever deletes
  `staging/<validated name>`.
- A successful commit removes its own staging directory. A rejected commit keeps it, so an `allowShrink` retry
  doesn't need another nine-page pull.

**Validating a page file** (`src/catalog/import-page.ts`).
- **The file.** `path` must be absolute. After `lstatSync` it must be a regular file: not a symlink, a directory
  or a FIFO. It must be at most `MAX_PAGE_FILE_BYTES = 16 MiB`.
- **Parsing.** The file is parsed with `JSON.parse`. A one-element `[{type:"text", text}]` array is unwrapped
  and parsed again. This is defensive: the file observed on 2026-10-12
  (`~/.claude/projects/<proj>/<session>/tool-results/mcp-awsevents-…-ListSessions-<ts>.txt`, 160 KB for 250
  sessions) is the bare `{"items":[…],"nextToken":"…","totalCount":2227}` object.
- **The schema.**
  `ListSessionsPageSchema = z.object({ items: z.array(SessionItemSchema).max(1000), totalCount: z.number().int().nonnegative(), nextToken: z.string().min(1).max(512).optional() })`,
  where `SessionItemSchema = z.looseObject({ sessionId: z.string().min(1).max(128), title: z.string() })`.
  - Unknown top-level keys are stripped.
  - This rejects `{session}` (GetSession), `{schedule}` (GetSchedule), ListEvents items, error text and anything
    that isn't JSON.
  - A page that repeats a `sessionId` is rejected.
- **Error messages** name the check that failed and the file's basename. They never include file content.
- **No root allowlist.** Claude Code's results directory is configurable (`CLAUDE_CONFIG_DIR`), the script
  already runs with the user's rights, and it never echoes content.
- **The input file is never modified or deleted.**

**An inline `page`.** When a page came back small enough to land in context, it is passed as `page` (the
parsed object), and the same schema validates it. Exactly one of `path` and `page` is allowed.

**Continuity across pages.**
- `overlap`: any of the page's `sessionId`s is already staged.
- `alreadyComplete`: a page after a page without a `nextToken`.
- A skipped page is caught at commit as `partial`.

**Page output:** `{ syncId, pageNumber, stagedCount, totalCount, nextToken?, complete, totalCountChanged? }`.
It carries no session data.

**Commit and the guard.** The checks run in this order. Each rejection is a
`CatalogImportRejectedError(reason) extends ValidationError` and leaves the stored catalog byte-identical:
1. `nothingStaged`.
2. `incomplete`: the last page still has a `nextToken`.
3. `empty`: zero sessions. The wording keeps "…existing local data was left unchanged…" (the #17/#18 guarantee).
4. `partial`: the count is below the **last** page's `totalCount`. A count *above* it is accepted with
   `warnings: ["catalog grew during the import"]`.
5. `shrunk`: a previous catalog exists for the same `eventId` and the new count is below
   `floor(previous.count × 0.9)`. This is rejected unless `allowShrink: true`, which the skill passes only after
   the user says yes.

On success, the order is:
1. Compute the diff (A2).
2. Write `catalog/changes.json` (0600).
3. Call `writeCatalog` (raw, then index, then meta).
4. Remove the staging directory.
5. Prune stale staging.

Meta keeps its current shape, so **there is no schema bump**:
`{ schemaVersion, eventId, syncedAt: now(), totalCount: lastPage.totalCount, count, includedAbstracts: items.some(has abstract), timezone }`.
`changes.json.toSyncedAt === meta.syncedAt`. If the two disagree after a crash, the diff is reported as
`superseded`.

**Switching event.** If the stored catalog belongs to a different event, the commit skips the shrink check and
reports `replacedEventId`.

**Timezone.** The first `page` call **requires** `timezone`: AWS `GetEvent`'s `event.timezone`, or `null`. A
non-null value must pass `isRecognizedTimeZone`.

**The sync brief** lives in the `catalog-sync` agent body and is mirrored in `workflow.md`:
1. `GetEvent`, then note `timezone`.
2. `ListSessions` with `includeAbstracts: true`.
3. For each page, run `catalog_import` with `action: "page"`. If the result was saved to a file, pass that
   path; if it came back inline, pass it as `page`. Follow `nextToken` until `complete`.
4. Run `catalog_import` with `action: "commit"`.
5. On `shrunk`, stop and report both counts. Never pass `allowShrink`.
6. On any other rejection, report it and stop.
7. Return at most about 15 lines: the counts and up to 10 change highlights. Never return session data.

### A2. The bounded diff

`src/catalog/diff.ts`:
- `diffCatalogs(prev, next, { compareAbstracts })` returns
  `{ counts: { added, removed, changed, unchanged }, abstractsCompared, changes: CatalogChange[] }`.
- `CatalogChange` is `{ kind: "added" | "removed" | "changed", sessionId, code: string | null, title, fields?: string[] }`.
- What counts as a change:
  - `VOLATILE_FIELDS = ["seatAvailability"]` are never compared.
  - String arrays are compared regardless of order.
  - Other values are compared by canonical JSON with sorted keys.
  - `abstract` is compared only when both pulls included abstracts.
- Order, most actionable first: `removed`; then `changed` rows touching `sessionTime`, `venue` or `room`; then
  `added`; then the other `changed` rows. Ties break on `code`, then `sessionId`.
- A first import records `{ firstImport: true }` with no rows.
- The commit output carries `summarizeCatalogChanges(diff)`:
  `{ counts, abstractsCompared, highlights (≤ 20, titles ≤ 100 chars), omitted }`. It is budget-checked with
  `outputBytes`. The full diff stays in `changes.json`.
- **`catalog_changes`:** input `{ sessionIds? (1–200), kinds?, offset?, limit? (1–50, default 25) }`.
  - When a diff is available it returns
    `{ available: true, eventId, fromSyncedAt, toSyncedAt, counts, total, changes, offset, nextOffset? }`, with the
    page shortened to fit the budget.
  - Otherwise it returns
    `{ available: false, reason: "noImport" | "firstImport" | "eventReplaced" | "superseded" }`.
  - The main use: AWS `GetSchedule` ids in, "did anything on my schedule move?" out.
- `status` gains `catalog.lastImport: { toSyncedAt, counts }` when the diff matches the meta.

### A3. `lookup_sessions` and `search_sessions`

- **`lookup_sessions`** takes `{ ids (1–100; a session id or a code), includeAbstract? }`. With `includeAbstract`,
  at most 10 ids are allowed and each abstract is cut to 1,500 characters with `…[shortened]`.
  - Each row is
    `{ query, sessionId, code, title (≤ 200), type, level, venue, room, startDate, startTime, endTime, startsAt, endsAt, otherSittings (≤ 5), abstract? }`.
  - The output also has `notFound`, `ambiguous: [{ query, sessionIds ≤ 10 }]`, and `notReturned` for queries cut
    by the budget. A requested id is never silently dropped.
  - `startsAt`/`endsAt` are UTC times via `deriveSessionTimes`. When the timezone is unknown they are `null` and
    the `timezoneWarnings` text is included.
  - Resolution uses a new pure `resolveSessionToken(index, token)`, extracted from `resolveSessionRecord`, so the
    index is read once per call.
  - It replaces `get_schedule`'s id resolution and `catalog show`. The merged, sorted schedule view becomes agent
    work over these rows, since AWS personal time is already UTC.
- **`search_sessions`** takes `{ query?, format?, venue? (enum VENUES), levels?: { min, max }, day?, limit? (1–25, default 15) }`.
  - It is a thin adapter over `queryCatalog`, with rows
    `{ sessionId, code, title (≤ 160), type, level, venue, startDate, startTime, score }`.
  - It is budgeted, with `omitted`.
  - It replaces `catalog search`, which the binding decision keeps.

### A4. `plan_schedule`, `nearby_sessions` and `status` take data instead of making API calls

- **The schedule input** (`src/schedule/schedule-input.ts`) is
  `scheduleInputSchema = z.strictObject({ reserved: id[] ≤ 1000, favorites?: id[] ≤ 1000, personalTime: personalTimeSchema[] ≤ 1000 })`.
  - It matches AWS `Schedule`, so the agent passes `GetSchedule`'s `schedule` object verbatim.
  - `personalTimeSchema` has `startDateTime` and `endDateTime` in `YYYY-MM-DDTHH:MM:SS`, plus capped
    `title`, `description` and `location`. Unknown keys are stripped.
- **`schedule` or `scheduleFile`, exactly one.** Both commands accept `schedule` inline or `scheduleFile`. The
  file is read with the same rules as a page file and may hold either `{schedule}` or the bare object.
- **The skill's rule:** call `GetSchedule` immediately before, and pass the **whole** result.
- **`plan_schedule`** becomes `{ sessionIds, schedule | scheduleFile, event? }`.
  - `planSchedule` is synchronous over `{ storeRoot, schedule, eventId?, now? }`.
  - The event-match and known-timezone checks stay, and `buildSchedulePlan` is unchanged.
- **`nearby_sessions`** keeps all its feasibility, travel and admission logic. The live refresh becomes a
  two-call protocol:
  - **Call 1** returns `refreshIds`: up to 20 eligible candidates without live data, in today's refresh order.
  - **Between the calls** the agent reads each id with AWS `GetSession`, one at a time, skipping any that fail.
  - **Call 2** passes `liveSessions`: up to 20 `session` objects, validated by `SessionItemSchema`.
  - **`observedAt`** is the time the script receives call 2. The default 5-minute freshness absorbs the gap.
  - Unknown or repeated `liveSessions` entries are counted in `coverage.liveIgnored`.
  - Coverage becomes `{ examined, eligible, liveProvided, liveUsed, liveIgnored, unrefreshed, omitted }`.
- **The legacy MCP and CLI adapters** (sub-plan 1 only) still fetch through the API client and pass the result in:
  - `getSchedule` for the schedule;
  - for nearby, the domain function runs twice, with `getSession` reads for the `refreshIds` in between.

  This keeps their behavior until they are deleted in sub-plan 2.
- **`status`** returns `{ catalog, lastImport? }`. The script never reports sign-in. During sub-plan 1 the
  legacy MCP `status` adds `signedIn` on top.

### A5. Reindex

`catalog_import { action: "reindex", timezone? }` calls `reindexCatalog`, ported from `sync.ts`'s
`tryReindexFromStoredRaw` in sub-plan 1:
- It rebuilds the index from stored raw data without any AWS call. This is the remedy for
  `stale: schema-version`, and it works during an outage like the one on 2026-10-03.
- A meta from before schema 5 with no `timezone` key needs the `timezone` argument. Without it, a
  `ValidationError` says to call `GetEvent`.
- No stored raw data gives `CatalogMissingError`.

`catalog_sync` keeps its own reindex until sub-plan 2 deletes it.

### A6. What is deleted (sub-plan 2), with expected LOC

| Removed | src | tests |
|---|---|---|
| `src/mcp/**`: server, tool registrations, the 6 API wrapper tools and the `get_schedule` pager. `response-budget.ts` becomes `src/commands/output-budget.ts` in sub-plan 1 | ~1,000 | `tests/mcp/**` ~3,000. The local-command cases were already ported to `tests/commands/**` in sub-plan 1 |
| `src/cli/**`, `mcp` and `skill` included | ~1,900 | `tests/cli/**` ~3,100, `tests/smoke.test.ts` |
| `src/skill/**` (install and update) | 659 | `tests/skill/{install,update}.test.ts` 1,145 |
| `src/auth/**`, `src/api/client.ts` | 1,260 | `tests/auth/**`, `tests/api/**`, `tests/integration/**`, `tests/helpers/fake-fetch.ts` ~2,100 |
| `src/catalog/sync.ts` | 204 | `tests/catalog/sync.test.ts` 517 (its reindex cases were ported in sub-plan 1) |
| `src/schedule/{favorites,reservations,schedule,write-quota}.ts`; `merge.ts` merge and sort | ~820 | ~1,550 |
| `src/profile/store.ts` | 63 | 81 |
| `core/errors.ts` API errors | ~70 | part of `tests/core/errors.test.ts` |
| **Total** | **~6,000** | **~11,500** |

**Kept, unchanged in behavior:** `match/**`, `profile/{profile,report}.ts`, the `catalog/**` domain,
`onsite/{config,travel}.ts`, `core/{paths,atomic-write}.ts`, and the new `src/commands/**` and
`src/script/**`.

**Dependencies.** `package.json` drops `@modelcontextprotocol/sdk` and `commander`, and loses its `bin` entry.
The package becomes `private: true`: it is distributed as a plugin, not through npm.

### A7. Docs and tests restructure

- **Skill location.** The skill moves to `plugin/skills/reinvent-scout/` in sub-plan 1, as a `git mv`. In the
  same commit, `src/skill/install.ts`'s `DEFAULT_SKILL_SOURCE_DIR` and `package.json` `files` point there, so
  the legacy installer still works.
- **`tests/skill/content.test.ts`:**
  - The registry is now the **command registry**, not the MCP server's `listTools`. Both existing checks keep
    their meaning against it: every snake_case backtick identifier is a command or allow-listed, and every
    command is named in `## The flow`.
  - New: every `reinvent-scout.mjs <command>` invocation in a fenced block names a registry command.
  - New: the **AWS tool allow-list.**
    - **Bare names.** Spans matching `/^(List|Get|Associate|Disassociate|Reserve|Cancel|Create|Update|Delete)[A-Z]\w+$/`
      must be one of the twelve AWS tools.
    - **Prefixed names.** Spans matching `/^mcp__(plugin_reinvent-scout_awsevents|awsevents)__(\w+)$/`, in the
      skill files or in the agent's `tools:`, must name one of the twelve tools after the prefix. Any other
      `mcp__…` span fails the test, which catches a wrong plugin or server name such as `mcp__reinvent-scout__…`.
    - **The either-name sentence.** `SKILL.md`, `agents/catalog-sync.md` and `watch.md` each contain the sentence
      naming both prefixes.
    - **The agent's `tools:` list.** It contains `GetEvent` and `ListSessions` under both prefixes.
  - New: `SKILL.md`'s frontmatter `allowed-tools` is exactly the script rule. The script path in every fenced
    invocation is `${CLAUDE_SKILL_DIR}/scripts/reinvent-scout.mjs`, or `${CLAUDE_PLUGIN_ROOT}/skills/reinvent-scout/scripts/reinvent-scout.mjs`
    in the agent file.
  - The "skill files CLI command names" tests are deleted in sub-plan 1. Replacement: no skill file mentions
    `reinvent-scout <subcommand>` as a CLI.
  - The sign-in tests ("sign-in is not needed to browse", "auth login instructions") are deleted in sub-plan 1.
  - The CLI-flag assertions in the lens-quality, why, preferences and map/focus describes are deleted in
    sub-plan 1. The README CLI assertions go in sub-plan 2.
  - The watch tests are ported to the AWS names.
- **New `tests/plugin/manifest.test.ts`:**
  - `plugin.json` parses, `name` is `reinvent-scout`, and `version` equals `package.json`'s.
  - `marketplace.json` has one entry with source `./plugin`.
  - `.mcp.json` declares exactly one server, `awsevents`, with `type: "http"`, the URL and
    `oauth: { clientId, callbackPort: 8484 }`. No `reinvent-scout` server is declared.
  - `agents/catalog-sync.md` has frontmatter, and its `tools` include `Bash` and the two AWS read tools.
  - No `CLAUDE.md` exists under `plugin/`, which the plugin validator warns about.
  - If `claude` is on `PATH`, `claude plugin validate ./plugin --strict` passes. Otherwise this test is skipped
    with a reason; CI has no `claude`.
- **`tests/docs.test.ts`:**
  - In sub-plan 1 it gains a check for the "Install as a Claude Code plugin" section.
  - In sub-plan 2 it is rewritten:
    - drop command coverage, the match score lines and the PKCE rationale;
    - add: the README's commands are registry commands, it names no `reinvent-scout` CLI, and it shows the
      `/plugin marketplace add jasonwadsworth/reinvent-scout` and `/plugin install reinvent-scout@reinvent-scout`
      steps and the permission rule;
    - keep the example-profile test.
- **watch.md moves to the AWS tools** (`GetSchedule`, `GetSession`, `ReserveSessions`, `CancelReservation`).
  - The `omittedConflicts` rule goes, because AWS returns up to 100 `conflictsWith` ids.
  - "Uncertain" now means a transport error or timeout from a write, or an effect that a following `GetSchedule`
    contradicts.
  - A `CancelReservation` 404 means the reservation is already gone.
  - Write pacing: at most 10 ids per `ReserveSessions` or `AssociateFavorites` call, and on a 429 pause until a
    later wakeup.
- **CLAUDE.md** (sub-plan 2):
  - Commands: `npm run bundle` and `bundle:verify` are added; `check` runs them.
  - "Core vs. adapter": the domain is in `src/catalog|profile|match|schedule|onsite/**`, `src/commands/**` is the
    one adapter layer, and `src/script/main.ts` is only argv and stdin/stdout.
  - "Agentic first": all AWS access goes through the plugin's `awsevents` MCP, and nobody adds an API wrapper.
  - "Injection": the network and PKCE bullets go, and `randomId` is added.
  - A "Plugin" section covers the layout, the committed bundle, and the output budget's reason.
- **README** (sub-plan 2) is rewritten as "a Claude Code plugin: skill plus local scripts, using the AWS Events
  MCP". It covers install, the permission rule, using the skill, how it works, where data lives (including that
  an old `tokens.json` can be deleted), and development (`npm run check` and the bundle). Target about 250
  lines.

### A8. Other decisions

- **`api/types.ts` moves to `src/aws/types.ts`** in sub-plan 2, minus the Bulk* types.
- **`DEFAULT_EVENT_ID` moves to `src/catalog/store.ts`** in sub-plan 1.
- **Named profiles (`profile save`) are dropped** with the CLI; they only existed there. Agents keep profiles as
  files and pass them in through `--input`.
- **No code deletes `tokens.json`.**
- **Error messages:**
  - `CatalogMissingError` becomes "No catalog has been imported yet. Run the catalog sync (the
    reinvent-scout:catalog-sync agent)." The legacy CLI and MCP keep working with that text.
  - `REBUILD_REMEDY` becomes "Rebuild it locally with catalog_import action \"reindex\", or re-import it."
- **`toCommandError`** maps `CatalogImportRejectedError` to `{ error, reason }` and Zod errors through
  `formatZodError`, which moves to `src/core/zod-errors.ts` in sub-plan 1. Everything else becomes
  `{ error: message }`, cut to 512 characters.
- **Lint.** `eslint.config.js` sets `no-console: error` for `src/script/**` and `src/commands/**`: stdout carries
  exactly one JSON document.

---

## B. Shared conventions

- **Commands, from the repo root:**
  - `npm test -- <path>` for one test file;
  - `npm run typecheck`;
  - `npm run bundle`;
  - `npm run check` before every commit. After sub-plan 1's task 1.8 it runs typecheck, lint, test, build and
    `bundle:verify`.
- **Sabotage check (the repo rule).** After a task goes green, defeat the two or three production lines that
  carry the behavior. Confirm that **exactly** the new test or tests fail, then revert, then commit. Each task
  names its target.
- **No real network or home directory in tests.** Tests use `tests/helpers/temp-home.ts`. Script tests spawn the
  built bundle with `REINVENT_SCOUT_HOME` set to the temp home.
- **New test helper** (task 1.6): `tests/helpers/call-command.ts`, `callCommand(name, input, { storeRoot, now?, randomId? })`.
  It runs `registry[name]` and returns `{ text, isError }`, the same shape the MCP tests read, so the ported
  tests change one line each.
- **Commit together.** Every commit that adds a command also edits `SKILL.md`'s `## The flow`, because the
  content test requires every command to be named there.
- **Commit trailer:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

# Skills-only — Sub-plan 1 of 2: the reinvent-scout plugin (skill, scripts, sync agent, AWS MCP)

**Goal:** Ship an installable plugin that does every flow through the AWS `awsevents` MCP plus the bundled local
scripts, including the guarded import with a change diff. The legacy CLI, MCP server and installer keep working,
unused by the skill.
**Merges after:** none (first sub-plan).
**PR title prefix:** `part 1/2:`. The body says `Part 1 of 2 for #22` and does not close it.

**Files:**

Create, in `src/catalog/`:
- `import-page.ts`: page file and inline validation.
- `import.ts`: `stageCatalogPage`, `commitCatalogImport`, `reindexCatalog`, `pruneStaleStaging`,
  `importCatalog`, `CatalogImportRejectedError`, `ImportDeps`.
- `diff.ts`: `diffCatalogs`, `summarizeCatalogChanges`, `writeCatalogChanges`, `readCatalogChanges`,
  `queryCatalogChanges`.
- `lookup.ts`: `lookupSessions`.

Create, in `src/schedule/`:
- `schedule-input.ts`: `scheduleInputSchema`, `personalTimeSchema`, `readScheduleInput`.

Create, in `src/commands/`:
- `registry.ts`: names, schemas and handlers.
- `output-budget.ts`: moved from `src/mcp/response-budget.ts`, with the 24 KiB `outputBytes`.
- `errors.ts`: `toCommandError`.

Create, the script:
- `src/script/main.ts`: argv, `--input`, dispatch, a single stdout write, exit codes.
- `scripts/bundle.mjs` and `scripts/bundle-verify.mjs`: the esbuild build and its byte-compare check.

Move:
- `src/cli/zod-errors.ts` to `src/core/zod-errors.ts`.

Modify:
- `src/catalog/query.ts`: `resolveSessionToken` and the `REBUILD_REMEDY` text.
- `src/catalog/store.ts`: `DEFAULT_EVENT_ID`.
- `src/schedule/plan.ts`: synchronous, takes `schedule`.
- `src/onsite/recommend.ts`: `schedule`, `liveSessions` and `refreshIds`; no `apiClient`.
- `src/mcp/tools.ts`: the local tools register from the registry; the wrapper tools stay. Also `plan_schedule`
  and `nearby_sessions` fetch the schedule and do the `getSession` reads through the API client, then call the
  new domain functions (A4), and `status` composes `signedIn`.
- `src/cli/commands/schedule.ts`: the same adapter change for `plan` and `nearby`.
- `src/skill/install.ts`: the source dir.
- `src/core/errors.ts`: the `CatalogMissingError` text.
- `package.json`: `bundle`, `bundle:verify`, `check`, `files`, and `esbuild` as a devDependency.
- `eslint.config.js`.
- `README.md`: a new "Install as a Claude Code plugin" section at the top; the CLI and MCP sections are marked
  "legacy, removed in the next release".

Create, the plugin:
- `/.claude-plugin/marketplace.json`
- `plugin/.claude-plugin/plugin.json`, `plugin/.mcp.json`, `plugin/agents/catalog-sync.md`
- `plugin/skills/reinvent-scout/scripts/reinvent-scout.mjs` (generated, committed)

Move with `git mv`:
- `skills/reinvent-scout/**` to `plugin/skills/reinvent-scout/**`, then rewrite `SKILL.md`, `workflow.md`,
  `watch.md`, and `profiling.md` where it names tools.

Tests:
- Create: `tests/catalog/{import-page,import,diff,lookup}.test.ts`,
  `tests/schedule/schedule-input.test.ts`, `tests/commands/{registry,import,local}.test.ts`,
  `tests/script/main.test.ts`, `tests/plugin/manifest.test.ts`, `tests/helpers/call-command.ts`.
- Modify: `tests/catalog/query.test.ts`, `tests/schedule/plan.test.ts`, `tests/onsite/recommend.test.ts`,
  `tests/mcp/**` (budget numbers, then the plan, nearby and status adapters), `tests/skill/content.test.ts`,
  `tests/skill/install.test.ts` (source dir), `tests/docs.test.ts`.

### Task 1.1: Validate a ListSessions page (file or inline)
- [ ] Write failing tests in `tests/catalog/import-page.test.ts`:
  - **Accepted:**
    - A real-shaped page file is accepted, and every item round-trips with every field.
    - The same object passed inline is accepted.
    - A one-element `[{type:"text",text}]` wrapper is unwrapped.
  - **Rejected, each with `ValidationError`:**
    - a relative path, a symlink, a directory, or a file over the size cap (inject `maxBytes`)
    - non-JSON text, or a `{session}` or `{schedule}` object
    - an item without `sessionId`, a repeated `sessionId`, or `totalCount: -1`
    - both `path` and `page` given, or neither
  - **Leak check:** for a non-page file containing `SECRET-MARKER`, the error doesn't contain it but does name
    the file's basename.
- [ ] Run `npm test -- tests/catalog/import-page.test.ts`. Expect FAIL.
- [ ] Implement `src/catalog/import-page.ts` per A1. Move `formatZodError` to `src/core/zod-errors.ts` and update
  its two importers, `src/mcp/tools.ts` and `src/skill/update.ts`.
- [ ] Run the file, then `npm run typecheck`. Expect PASS.
- [ ] Sabotage check: remove the symlink rejection, then the duplicate-id check. Each should turn only its own
  test red. Revert.
- [ ] Commit: `feat(catalog): validate AWS ListSessions pages from a saved file or inline`.

### Task 1.2: Stage pages across calls
- [ ] Write failing tests in `tests/catalog/import.test.ts` (`describe("stageCatalogPage")`), with `now` and
  `randomId` injected:
  - **Staging:**
    - The first page creates the manifest and `page-0001.json` with modes 0700 and 0600.
    - The output is `{ syncId, pageNumber: 1, stagedCount, totalCount, nextToken, complete: false }`.
    - The stored catalog doesn't change.
    - The second page with `syncId` is `complete: true`.
  - **Field rules:**
    - The first page needs `timezone`.
    - A bad zone gives `ValidationError`. `null` is accepted.
    - A later page carrying `eventId` or `timezone` is rejected.
  - **Bad syncs:**
    - An unknown `syncId` gives `ValidationError`.
    - `syncId` `"../x"` gives `ValidationError`, and nothing is created outside `staging/`.
    - The same page twice gives `overlap`, with the manifest unchanged.
    - A page after a complete one gives `alreadyComplete`.
  - **Changing totals:** a different `totalCount` gives `totalCountChanged: true`.
- [ ] Run the file. Expect FAIL.
- [ ] Implement `stageCatalogPage`, the manifest I/O and `SYNC_ID_PATTERN`. Add `CatalogImportRejectedError`
  with the reasons `overlap | alreadyComplete | nothingStaged | incomplete | empty | partial | shrunk`.
- [ ] Run the file. Expect PASS.
- [ ] Sabotage check: skip the overlap check, then skip the `SYNC_ID_PATTERN` test. Each should turn only its own
  test red. Revert.
- [ ] Commit: `feat(catalog): stage imported ListSessions pages per sync`.

### Task 1.3: Clean up abandoned syncs
- [ ] Write failing tests (`describe("pruneStaleStaging")`):
  - **Removed:** a manifest 25 h old, and an unreadable manifest whose directory `mtime` is 25 h old (set with
    `utimesSync`).
  - **Kept:** a 1 h old directory, and a symlink inside `staging/` whose target is outside it. Neither the link
    nor the target is touched.
  - **Triggered by:** starting a new sync.
- [ ] Run. Expect FAIL. Implement it, and call it on sync start. Run. Expect PASS.
- [ ] Sabotage check: compare the age with `>= 0`. The "keeps a 1 h old directory" test should fail. Revert.
- [ ] Commit: `feat(catalog): prune abandoned import staging after 24 hours`.

### Task 1.4: Compute the catalog diff
- [ ] Write failing tests in `tests/catalog/diff.test.ts`:
  - **What counts:**
    - added, removed and changed rows with their `fields`
    - order: `removed`, then schedule changes (`sessionTime`, `room`), then `added`, then other changes
    - reordered taxonomy arrays are not a change
    - a `seatAvailability`-only change is not a change
    - with `compareAbstracts: false`, abstract changes are ignored and `abstractsCompared: false`
  - **Tie-breaks:** `code`, then `sessionId`.
  - **`summarizeCatalogChanges`:** at most 20 highlights, with `omitted`; titles of 100+ characters shortened;
    under `OUTPUT_BUDGET_BYTES` for 2,000 changed rows with 300-character titles. Create
    `src/commands/output-budget.ts` in this task with `outputBytes`, `OUTPUT_BUDGET_BYTES` and
    `shortenDescription`. `src/mcp/response-budget.ts` re-exports `shortenDescription` from it for now.
- [ ] Run. Expect FAIL. Implement per A2. Run. Expect PASS.
- [ ] Sabotage check: drop the volatile skip, then the array sort. Each should turn only its own test red. Revert.
- [ ] Commit: `feat(catalog): diff two catalog pulls with a bounded summary`.

### Task 1.5: Commit with the guard, and reindex
- [ ] Write failing tests:
  - **`describe("commitCatalogImport")`, seeded with `writeCatalog` and fixture sessions:**
    - **A successful two-page sync:**
      - raw equals the items field for field, and the index is rebuilt;
      - the meta has the `eventId`, `timezone`, `count`, last `totalCount`, `syncedAt: now()` and
        `includedAbstracts`;
      - `changes.json` is written with `toSyncedAt` equal to the meta's `syncedAt`, and staging is removed;
      - the output has the summary.
    - **Special cases:** the first import gives `firstImport`; a count above the total gives `warnings`; another
      event gives `replacedEventId` and skips the shrink check.
    - **Rejections:** `nothingStaged`, `incomplete`, `empty`, `partial` (3 of 4), `shrunk` (85 of 100).
      - After each, `raw.json`, `index.json` and `meta.json` are byte-identical.
      - After `shrunk`, staging is kept, and an `allowShrink` commit then succeeds.
      - The `empty` text keeps "existing local data was left unchanged".
    - **Crash between writes:** an injected `writeCatalog` that throws after `changes.json` is written leads to
      `readCatalogChanges` reporting `superseded`.
  - **`describe("reindexCatalog")`, ported from `tests/catalog/sync.test.ts`:**
    - A stale schema version is rebuilt with no AWS call, keeping `syncedAt` and `timezone`.
    - A meta with no `timezone` key and no argument gives `ValidationError` naming `GetEvent`. The argument is
      stored when given.
    - An explicit `null` key is preserved.
    - No raw data gives `CatalogMissingError`.
    - A failure leaves meta byte-identical.
  - **`describe("importCatalog")`:** the per-action field rules (the A1 table).
- [ ] Run. Expect FAIL.
- [ ] Implement `commitCatalogImport`, `reindexCatalog` and `importCatalog`. Move `DEFAULT_EVENT_ID` into
  `store.ts` and leave a re-export in `sync.ts` for the legacy importers.
- [ ] Run. Expect PASS, then `npm run typecheck`.
- [ ] Sabotage checks, reverting each before the next. Each should turn only its own test red:
  - delete the partial comparison;
  - set the shrink factor to 0.5;
  - write `changes.json` after `writeCatalog` (the crash test);
  - skip the no-timezone check (the `GetEvent` test).
- [ ] Commit: `feat(catalog): commit an import with the empty/partial/shrink guard and diff; local reindex`.

### Task 1.6: The command registry, with the existing local tools moved in
This is Step 0 for `src/mcp/tools.ts`, which is over 300 LOC: a pure move with no behavior change, committed
alone.
- [ ] Write a failing test in `tests/commands/registry.test.ts`:
  - The registry exports exactly `status`, `validate_profile`, `match_sessions`, `map_profile`, `list_filters`,
    `plan_schedule`, `nearby_sessions`, `get_onsite_preferences` and `set_onsite_preferences`.
  - Each has a `description` and an object `inputSchema`.
  - `callCommand("validate_profile", …)` gives the same text as the MCP tool did for the same input. Compare with
    the existing `tests/mcp/tools-catalog.test.ts` fixture.
- [ ] Run. Expect FAIL.
- [ ] Move the handler bodies from `src/mcp/tools.ts` into `src/commands/registry.ts`:
  - validate, match, map, filters and the on-site preferences now;
  - `plan_schedule` and `nearby_sessions` move in task 1.7, and `status` in task 1.9.
  - Each `run` returns the output value and throws on error. Budget closures use
    `outputBytes(v) <= OUTPUT_BUDGET_BYTES`.
  - `src/mcp/tools.ts` registers those tools by looping over the registry: `textResult(output)` on success,
    `toToolError` on failure. The wrapper tools stay as they are.
- [ ] Add `tests/helpers/call-command.ts`.
- [ ] Update the size assertions in `tests/mcp/**` and `tests/match/response-budget.test.ts` that expected
  `30 * 1024` envelopes to the new budget. List every changed number in the commit body. Truncation thresholds
  move by design (A0).
- [ ] Run `npm test`. Expect PASS.
- [ ] Sabotage check: make the MCP loop skip `map_profile`. The `server.test.ts` tool-list test and
  `registry.test.ts` should fail. Revert.
- [ ] Commit: `refactor(commands): move local tool handlers into a shared command registry`.

### Task 1.7: `plan_schedule` and `nearby_sessions` take data
- [ ] Write failing tests:
  - **`tests/schedule/schedule-input.test.ts`:**
    - accepts a verbatim AWS `Schedule`, including `favorites`, or a `{schedule}` wrapper read from a
      `scheduleFile`;
    - rejects `Z` or milliseconds in times, and more than 1,000 reserved ids;
    - strips unknown `personalTime` keys;
    - `schedule` and `scheduleFile` are mutually exclusive.
  - **`tests/schedule/plan.test.ts`:**
    - `planSchedule(ids, { storeRoot, schedule, eventId })` is synchronous;
    - it still runs the event-match and timezone checks before planning;
    - a personal-time block blocks an overlapping offering.
  - **`tests/onsite/recommend.test.ts`,** rewritten against `{ storeRoot, now }` with `schedule` and
    `liveSessions` in the input. Port every existing case, then add:
    - call 1 gives `refreshIds` capped at 20 and cache/unknown bands;
    - call 2 with `liveSessions` gives live, fresh bands and an empty `refreshIds`;
    - a moved venue or time is re-checked;
    - unknown or repeated ids are counted in `liveIgnored`;
    - `observedAt` is `now()` at entry, and a `now` that advances past freshness gives `unknown`.
  - **`tests/commands/local.test.ts`:** both commands through `callCommand`.
  - **`tests/mcp/tools-schedule.test.ts` and `tests/onsite/adapters.test.ts`:** the legacy MCP and CLI adapters
    still produce the old results through the API client fake.
- [ ] Run. Expect FAIL.
- [ ] Implement `src/schedule/schedule-input.ts`, the changes to `plan.ts` and `recommend.ts`, the registry
  entries, and the legacy adapters (A4).
- [ ] Run `npm test`. Expect PASS.
- [ ] Sabotage checks, reverting each: drop personal time from the hard commitments; ignore `liveSessions`; stamp
  `observedAt` as `0`. Each should turn only its own tests red.
- [ ] Commit: `feat(schedule): plan and nearby take the GetSchedule result and live session reads as input`.

### Task 1.8: The script entry and the bundle
- [ ] Write failing tests in `tests/script/main.test.ts`, which spawn `node <bundle>` with
  `REINVENT_SCOUT_HOME` set to a temp home and a seeded catalog:
  - **Success and errors:**
    - `list_filters` with `--input -` gives one JSON line on stdout, exit 0, and an empty stdout apart from that
      document.
    - `--input <file>` works too.
    - An unknown command gives `{"error":…}` and exit 2.
    - Bad JSON on stdin gives exit 2 with no stack trace on stdout.
    - A handler error, such as `match_sessions` with no catalog, gives exit 1 and an error that names the
      catalog sync.
  - **Help, version and purity:**
    - `--help` lists every registry name.
    - `--version` equals `package.json`'s version.
    - Purity: everything written to stdout parses as a single JSON value, across three different commands.
  - **Bundle:** the bundle has no `import` of anything outside `node:`. Grep the file for `from "` and check that
    every match starts with `node:`.
- [ ] Run. Expect FAIL.
- [ ] Implement `src/script/main.ts`: `node:util` `parseArgs`, `--input` file or stdin, the registry dispatch,
  `toCommandError`, and one `process.stdout.write`.
- [ ] Add `scripts/bundle.mjs` and `scripts/bundle-verify.mjs`. Add the `package.json` scripts, with `check`
  ending in `npm run bundle:verify`, and pin `esbuild`. Set `no-console` in `eslint.config.js`.
- [ ] Run `npm run bundle`, then the tests. Expect PASS.
- [ ] Confirm the Bash output default in the current Claude Code docs, and note the source in the commit.
- [ ] Sabotage checks, reverting each:
  - write a stray `console.log` from inside `run` (bypass lint with an inline disable). The purity test should
    fail.
  - edit the committed bundle by one byte. `bundle:verify` should fail.
- [ ] Commit: `feat(script): bundled reinvent-scout.mjs entry over the command registry`.

### Task 1.9: The `catalog_import`, `catalog_changes`, `lookup_sessions`, `search_sessions` and `status` commands
- [ ] Write failing tests in `tests/catalog/lookup.test.ts`:
  - ids and codes mixed;
  - UTC times for a known fixture sitting, with the expected value computed by hand;
  - `otherSittings` capped at 5;
  - `notFound` and `ambiguous`;
  - the index read once (inject a `readIndexFn` and count the calls);
  - abstracts cut to 1,500 characters, and more than 10 ids with abstracts rejected;
  - an unknown timezone gives `null` times and the warning.
  - Also add the `resolveSessionToken` cases to `tests/catalog/query.test.ts`.
- [ ] Write failing tests in `tests/commands/import.test.ts`, through `callCommand`:
  - **The import flow:** two page files, then a commit, gives counts, `committed` and the summary. The output
    has no titles outside the highlights.
  - **Rejections:** a rejected commit gives `isError`, with text starting `shrunk:` and naming `allowShrink`.
    Unknown keys are a schema error.
  - **`catalog_changes`:** the `sessionIds` filter, the four `available: false` reasons, and `nextOffset`.
  - **`status`:** `lastImport` after an import, absent after a legacy `catalog_sync` (superseded), and no
    `signedIn` key.
  - **`lookup_sessions` budget:** 100 ids with 2,000-character titles stay under budget, and every query shows up
    in exactly one of rows, `notFound`, `ambiguous` or `notReturned`.
  - **`search_sessions`:** every filter narrows the result (compare against `queryCatalog`); an unknown venue is
    a schema error; `limit` is capped at 25; no abstract and no term maps; it stays under budget with
    `omitted`; a missing catalog gives the sync message.
  - The registry list test now expects 13 commands.
- [ ] Run. Expect FAIL.
- [ ] Implement `src/catalog/lookup.ts` and `resolveSessionToken`, and the five registry entries. `status` moves
  in, and the legacy MCP `status` composes `signedIn` on top.
- [ ] Rebuild the bundle.
- [ ] Add each command to `SKILL.md`'s `## The flow` with one placeholder line. Task 1.10 rewrites them.
- [ ] Run `npm test`. Expect PASS.
- [ ] Sabotage checks, reverting each: drop the `notReturned` push; skip the `toSyncedAt` comparison; drop the
  `levelBand` pass-through. Each should turn only its own test red.
- [ ] Commit: `feat(commands): catalog_import, catalog_changes, lookup_sessions, search_sessions; status without sign-in`.

### Task 1.10: Plugin packaging, and the skill rewrite
- [ ] Write failing tests:
  - all of `tests/plugin/manifest.test.ts` (A7);
  - the `tests/skill/content.test.ts` changes listed in A7:
    - registry-based identifier and flow checks;
    - the `reinvent-scout.mjs <command>` and `allowed-tools` checks;
    - the AWS allow-list;
    - delete the CLI-name and sign-in describes and the CLI-flag assertions;
    - port the watch tests to the AWS names: no `omittedConflicts`, up to 100 `conflictsWith`, the "uncertain"
      definition, a 404 cancel meaning already absent;
  - **a new `describe("catalog sync through the plugin agent")`:**
    - `SKILL.md` step 2 names `reinvent-scout:catalog-sync`;
    - says the catalog never enters the main context;
    - relays only the summary and asks before `allowShrink`;
    - `agents/catalog-sync.md`'s body contains the A1 brief, including the saved-file path, `page`, `commit`
      and "never pass allowShrink".
  - **schedule and favorites through AWS:**
    - `SKILL.md` steps 7–9 and 11 name `GetSchedule`, `ReserveSessions`, `CancelReservation`,
      `AssociateFavorites` (at most 10, the 429 pause), `DisassociateFavorite` and `GetSession`;
    - `GetSchedule` ids are resolved with `lookup_sessions`;
    - abstracts come from `lookup_sessions` with `includeAbstract`.
- [ ] Run `npm test -- tests/plugin tests/skill`. Expect FAIL.
- [ ] Packaging:
  - `git mv skills/reinvent-scout plugin/skills/reinvent-scout`;
  - update `src/skill/install.ts`'s `DEFAULT_SKILL_SOURCE_DIR`, `tests/skill/install.test.ts` and
    `package.json` `files`;
  - change `scripts/bundle.mjs`'s output path;
  - create `marketplace.json`, `plugin.json`, `.mcp.json` and `agents/catalog-sync.md` per A0.
- [ ] Rewrite `SKILL.md`:
  - the frontmatter `allowed-tools`;
  - the invocation form;
  - **## The flow:**
    1. `status`.
    2. Sync with the agent, then `catalog_changes`.
    3. Profile.
    4. `validate_profile`, `map_profile`, `list_filters`.
    5. `match_sessions`, with `search_sessions` for direct "sessions about X".
    6. Present, with `lookup_sessions` for abstracts.
    7. `GetSchedule`, then `plan_schedule`, confirm, `ReserveSessions`, and `CancelReservation` only on an
       explicit choice.
    8. `AssociateFavorites`.
    9. `GetSchedule` plus `lookup_sessions` to show the schedule.
    10. On-site: preferences, then `nearby_sessions` with the two-call `GetSession` refresh.
    11. Watch, with watch.md.
  - `## Commands` (local) and `## AWS tools` lists.
- [ ] Rewrite `workflow.md`:
  - each command's input and output contract, with the invocation example;
  - the subagent brief;
  - AWS-tool guidance for schedule writes: batches of at most 10, read every `failed`, stop on 409, pause on
    429, never replay an uncertain write;
  - delete the CLI reference.
- [ ] Port `watch.md`. Update `profiling.md` only where it names tools.
- [ ] Rebuild the bundle. Run `npm test` and `npm run check`. Expect PASS.
- [ ] Sabotage check: delete the agent sentence from `SKILL.md`. Only the plugin-agent test should fail. Revert.
- [ ] Commit: `feat(plugin): package reinvent-scout as a Claude Code plugin with a sync agent and AWS MCP`.

### Task 1.11: README plugin section, and verify end to end
- [ ] Write a failing test in `tests/docs.test.ts`: the README's "Install as a Claude Code plugin" section shows
  `/plugin marketplace add jasonwadsworth/reinvent-scout`, `/plugin install reinvent-scout@reinvent-scout`, the
  permission rule (it must contain `reinvent-scout.mjs` and both AWS tool prefixes), and the existing-`awsevents`
  note. The note says the user may keep their own `awsevents` entry, and that one with the exact URL
  `https://api.awsevents.com/mcp` deduplicates with the plugin's. Any other spelling means two servers and two
  sign-ins.
- [ ] Run. Expect FAIL. Write the section, and mark the CLI and MCP sections legacy. Run. Expect PASS.
- [ ] Check the permission-rule wildcard against the current permissions docs, and adjust the README and the test.
- [ ] Manual end to end:
  1. Run `claude plugin validate ./plugin --strict` and `claude plugin validate . --strict` for the
     marketplace.
  2. Load the plugin with `claude --plugin-dir ./plugin` and a scratch `REINVENT_SCOUT_HOME`.
  3. Run the sync agent against the real `awsevents` MCP: 9 pages, a commit, then `status` fresh with 2,227 or
     more sessions.
  4. Run it again and check the diff is small.
  5. Run `lookup_sessions` on a `GetSchedule` result.
  6. Run `plan_schedule` with a real schedule. Make no writes.
  7. Count the permission prompts with and without the README rule.
  8. Namespacing, in two scenarios. With the user's own user-scope `awsevents`, the tools are `mcp__awsevents__*`,
     the plugin server is suppressed, and the sync agent runs. With a scratch `HOME`/config that has no user
     entry, the tools are `mcp__plugin_reinvent-scout_awsevents__*`, one sign-in on port 8484 works, and the
     sync agent runs. Also confirm that an absent-server entry in the agent's `tools:` is ignored (A0).

  Record all of it in the PR body.
- [ ] Commit: `docs(readme): install as a Claude Code plugin`.
- [ ] Open a PR titled `part 1/2: reinvent-scout as a Claude Code plugin (AWS MCP sync with diff, local scripts)`.
  The body says `Part 1 of 2 for #22` and has a "Decisions made during implementation" section.

---

# Skills-only — Sub-plan 2 of 2: remove the legacy CLI, MCP server, installer, sign-in and API client

**Goal:** Only the plugin remains. All AWS access goes through `awsevents`, all local work goes through the
bundled script, and there is no `bin`.
**Merges after:** sub-plan 1, and after the manual end-to-end in task 1.11 has passed on the user's machine.
**PR title prefix:** `part 2/2:`. The body says `Part 2 of 2 for #22. Closes #22.`

**Files:**
- Delete every file in A6.
- Modify:
  - `src/core/errors.ts`: remove the API errors.
  - `src/catalog/sync.ts`: delete it, and remove the `DEFAULT_EVENT_ID` re-export.
  - `src/schedule/merge.ts`: keep `deriveSessionTimes` and `timezoneWarnings` (reworded), delete the rest.
  - `src/api/types.ts` moves to `src/aws/types.ts`.
  - `package.json`: no `bin`, no MCP SDK, no commander, `private: true`, and the description.
  - `eslint.config.js`.
  - `CLAUDE.md`, `README.md`, `tests/docs.test.ts`, `tests/ci.test.ts` if needed, and
    `tests/fixtures/fixture.test.ts` and other importers of `api/types`.

### Task 2.1: Delete the local MCP server
- [ ] Write a failing test in `tests/commands/registry.test.ts`: no file under `src/` imports
  `@modelcontextprotocol/sdk` (read the files with `readdirSync`/`readFileSync`).
- [ ] Run. Expect FAIL.
- [ ] Delete `src/mcp/**` and `tests/mcp/**`. First check that every local-command case in `tests/mcp/**` has a
  counterpart in `tests/commands/**` or a domain test. Port any that doesn't, list them in the commit body, and
  sabotage-check each one.
- [ ] Delete the stdout-purity subprocess test. `tests/script/main.test.ts` covers purity.
- [ ] Remove the dependency. Run `npm run check`. Expect PASS.
- [ ] Sabotage check: put back a file that imports the SDK. The guard should fail. Revert.
- [ ] Commit: `refactor: remove the local MCP server; the plugin's scripts are the only local surface`.

### Task 2.2: Delete the CLI and the skill installer
- [ ] Write failing tests:
  - `package.json` has no `bin` and no `commander`;
  - `tests/docs.test.ts` finds no `reinvent-scout <subcommand>` CLI invocation in the README. Delete its
    command-coverage and match-output describes.
- [ ] Run. Expect FAIL.
- [ ] Delete `src/cli/**`, `src/skill/**`, `src/profile/store.ts` and their tests, and `tests/smoke.test.ts`.
  `--version` coverage lives in `tests/script/main.test.ts`.
- [ ] Before deleting each CLI test file, check its domain assertions against `tests/match/**` and
  `tests/commands/**`. Port any gaps, list them, and sabotage-check each.
- [ ] Remove the README's legacy CLI sections, keeping it consistent until task 2.5's rewrite.
- [ ] Run `npm run check`. Expect PASS.
- [ ] Sabotage check: put the `bin` entry back. The `package.json` test should fail. Revert.
- [ ] Commit: `refactor: remove the reinvent-scout CLI and skill installer; install through the plugin`.

### Task 2.3: Delete sign-in, the API client and the wrapper domain
- [ ] Write a failing test in `tests/commands/registry.test.ts`: no file under `src/` imports `auth/`, `api/`,
  `schedule/favorites`, `schedule/reservations`, `schedule/schedule`, `schedule/write-quota` or `catalog/sync`.
- [ ] Run. Expect FAIL.
- [ ] Delete those modules and their tests (A6), `tests/integration/**` and `tests/helpers/fake-fetch.ts`.
- [ ] Move `src/api/types.ts` to `src/aws/types.ts` without the `Bulk*` types, and update every importer: grep
  `api/types` in `src` and `tests`, including the fixture test.
- [ ] Trim `merge.ts` and its test to `deriveSessionTimes` and `timezoneWarnings`. The warning text says
  "re-import with the catalog-sync agent".
- [ ] Remove from `core/errors.ts`: `AuthRequiredError`, `NotRegisteredError`, `ThrottledError`,
  `OperationUnavailableError`, `NotFoundError`, `ServiceError`, `EmptyCatalogError` and the request-not-sent
  tagging, together with their tests.
- [ ] Run `npm run check`. Expect PASS.
- [ ] Sabotage check: add `import "../auth/oauth.js"` in a new src file. The guard should fail. Revert.
- [ ] Commit: `refactor: remove PKCE sign-in, the API client and the schedule wrappers`.

### Task 2.4: CLAUDE.md
- [ ] Update `CLAUDE.md` per A7. There's no test; the reviewer checks it.
- [ ] Commit: `docs: CLAUDE.md for the plugin architecture`.

### Task 2.5: README rewrite, and the final sweep
- [ ] Write failing tests in `tests/docs.test.ts`:
  - the sections `## Install`, `## Permissions`, `## Use the skill`, `## How it works`, `## Where your data lives`
    and `## Development`;
  - "How it works" says the catalog is never passed through agent context, that sync runs in the
    `catalog-sync` agent, and names `api.awsevents.com/mcp`;
  - every backtick snake_case name is a registry command;
  - `tokens.json` can be deleted;
  - keep the example-profile test.
- [ ] Run. Expect FAIL. Rewrite `README.md` (A7). Run. Expect PASS.
- [ ] Dead-code sweep. Run separate greps over `src`, `tests`, `plugin` and `README.md` for:
  - `catalog_sync`, `get_schedule`, `get_session`, `favorite_sessions`, `unfavorite_session`,
    `reserve_sessions`, `cancel_reservation`
  - `auth login`, `buildApiClient`, `ApiClient`, `McpServer`, `registerTool`, `skill install`, `fake-fetch`
  - `profile save`, `catalog show`, `schedule show`, `--json`, `--verbose`
  Expect zero hits, apart from the `docs/plans/**` history and deliberate negative samples in tests.
- [ ] Find now-unused exports such as `formatEventLocalTime` with `grep -rn "<name>" src tests`, and delete them.
- [ ] Run `npm run check`. Expect PASS.
- [ ] Commit: `docs(readme): rewrite as a Claude Code plugin; remove dead exports`.
- [ ] Open a PR titled `part 2/2: plugin only — remove CLI, local MCP server, installer and API client`. The
  body says `Part 2 of 2 for #22. Closes #22.`, gives the deleted LOC and has "Decisions made".

---

## C. Self-review

- **Coverage of the issue and the redirect:**
  - The import protocol, the guard, the diff and reading it back: 1.1–1.5, 1.9.
  - The sync subagent and the timezone from `GetEvent`: 1.2, 1.10.
  - Every AWS call through the AWS MCP: 1.7, 1.10, 2.3.
  - `lookup_sessions`: 1.9.
  - Search and match kept: 1.6, 1.9.
  - `plan_schedule` and `nearby_sessions` with inputs: 1.7.
  - The on-site preferences: 1.6.
  - watch.md: 1.10.
  - The plugin manifest, `.mcp.json`, the agent and the marketplace: 1.10.
  - The bundle, built locally, committed and verified in CI: 1.8.
  - The permission allowlist: 1.10, 1.11.
  - Removing the MCP server, the CLI, the installer and auth/api: 2.1–2.3.
  - The README and CLAUDE.md: 1.11, 2.4, 2.5.
  - The docs and content tests: 1.10, 2.2, 2.5.
- **Edge cases with a task:**
  - empty, partial, shrunk and growing catalogs, a changed event, the first import;
  - a duplicate page, a page after the last, an unknown or traversal `syncId`;
  - symlinks, oversized files, wrong JSON, inline pages, abandoned staging, a crash between writes;
  - timezone `null`, missing or unrecognized;
  - the budget in every command, unknown or duplicate live sessions;
  - stdout purity, a stale bundle, and Bash output truncation.
- **Merge safety.** Sub-plan 1 removes nothing user-visible: the legacy surfaces keep their behavior through API
  adapters. Sub-plan 2 removes what nothing in the plugin uses. Each commit stays green.
- **Consistent names:** `importCatalog`, `stageCatalogPage`, `commitCatalogImport`, `reindexCatalog`,
  `pruneStaleStaging`, `CatalogImportRejectedError`, `diffCatalogs`, `summarizeCatalogChanges`,
  `queryCatalogChanges`, `lookupSessions`, `resolveSessionToken`, `scheduleInputSchema`, `OUTPUT_BUDGET_BYTES`,
  `outputBytes`, `toCommandError` and `callCommand`.

## D. Open questions for the user

**(a) The shrink guard.** A pull that is more than 10% smaller than the previous catalog is rejected. The sync
agent never passes `allowShrink`; the main agent passes it only after the user sees both counts and says yes. Is
that the right threshold and policy?

**(c) Named profiles.** `profile save` and `--profile <name>` only ever existed in the CLI. Is it OK to drop them?
Agents would keep profiles as files and pass them through `--input`.

**Resolved, not user questions:**
- **(b) The OAuth client id.** `.mcp.json` sets the public, shared `clientId` and `callbackPort: 8484` (AWS
  docs; A0).
- **(d) The output budget.** It is 24 KiB of raw JSON stdout. This is a technical call: Bash truncates output at
  30,000 characters (A0).
- **Old `tokens.json`.** No code deletes it. The README says it can be removed.

**Outside this repo (not a question).** The planning repo's CLAUDE.md still names the `reinvent-scout` CLI
(`catalog sync`, `schedule show`) as a fallback. It needs a separate edit after sub-plan 2. Its
`mcp__awsevents__*` usage keeps working, because the skill accepts that name.

## User decisions (2026-10-12), binding
- (a) **Shrink guard:** approved. A commit below 90% of the previous count is refused unless `allowShrink` is passed, and the skill passes it only after the user explicitly approves the drop.
- (c) **Drop `profile save`:** approved. `validate_profile`, `map_profile` and `match_sessions` stay; named profile storage goes.
- **Plan approved by the user for implementation.** The script name stays `reinvent-scout.mjs --input`.
