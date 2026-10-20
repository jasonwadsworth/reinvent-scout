# reinvent-scout

A Claude Code plugin: a skill, one bundled script (the local catalog index, search and matching), a
catalog-sync agent and the AWS Events MCP, which makes every call to AWS.

## Commands

- `npm test` -- `vitest run`, the whole suite.
- `npm run typecheck` -- `tsc --noEmit` against `src/`, then again against `tests/` via
  `tsconfig.tests.json`. Both must pass; a type error in a test file is still a failure.
- `npm run lint` -- `eslint .`.
- `npm run bundle` -- rebuilds the plugin script from `src/`. Run it after any change under `src/`:
  the bundle (`plugin/skills/reinvent-scout/scripts/reinvent-scout.mjs`) is committed.
- `npm run bundle:verify` -- fails when the committed bundle is stale.
- `npm run check` -- typecheck, lint, test and bundle:verify, in that order. Run this before every
  commit; it's what CI runs.

## Core vs. adapter

The domain is `src/catalog/**`, `src/match/**`, `src/profile/**`, `src/schedule/**` and
`src/onsite/**`, plus `src/core/**`. `src/commands/registry.ts` is the one adapter layer: it parses
input with the command's schema, calls one domain function, and bounds the output. `src/script/main.ts`
is only argv, stdin and stdout. If a command or the script is doing anything more interesting than
that -- branching on business rules, computing something, deciding what's valid -- that logic belongs
in the domain module it's adapting. Business logic in `src/commands` or `src/script` is a review
rejection.

## Agentic first

Favor agentic work for everything the skill does. Every AWS call goes through the plugin's `awsevents`
MCP; nobody adds an API wrapper. Code earns its place only for:
- **the local catalog import, index, search and match**, which keep 2,000+ sessions out of the agent's context;
- **keeping session data out of context** in any other way (bounded, already-ranked output).

Loops, decisions, failure handling, swaps and scheduling belong in skill guidance
(`plugin/skills/reinvent-scout/**`) that the agent carries out through MCP calls. Don't add domain
logic for them. When planning a feature, first ask whether it can be skill guidance over existing
tools. Add code only when keeping session data out of context requires it.

## Plugin

- Layout: `.claude-plugin/marketplace.json` at the root; `plugin/` holds the manifest
  (`.claude-plugin/plugin.json`), `.mcp.json` (the `awsevents` server), the `catalog-sync` agent, and
  the skill with its references and the committed bundle.
- The script prints exactly one JSON document on stdout and exits 0 (ok), 1 (the command failed) or 2
  (usage error). Nothing in `src` may print, so `no-console` is an error everywhere outside `tests/`.
- Every output is held to 24 KiB (`OUTPUT_BUDGET_BYTES`), because Claude Code's Bash output cap is
  30,000 characters. Shorten with explicit counts, never cut silently.
- `tests/plugin-only.test.ts` asserts that every `src/` module is in the bundle's import graph (the
  `KNOWN_DEAD` list is empty and stays empty: delete a dead module, never list it; `TYPE_ONLY` is for
  modules that only export types), that nothing imports a removed directory, and that no source file, config or doc
  names a removed command or path.

## Injection

Every module that touches time, randomness, the filesystem root or the process takes it by
injection, with a real default:

- Time: a `now?: () => number` parameter, defaulting to `Date.now`.
- Randomness: a `randomId?: () => string` parameter (`CommandDeps`), defaulting to `crypto.randomUUID`.
- The store root: never hardcoded or read from `process.env` directly inside a domain module --
  resolved once via `src/core/paths.ts` and passed down as `storeRoot`.

There is no network code to inject: AWS is reached only through the MCP.

No test may hit the real network or the real home directory. Use `tests/helpers/temp-home.ts` for
a per-test store root (respects `REINVENT_SCOUT_HOME`) and `tests/helpers/call-command.ts` to run a
registry command the way the script does.

## `exactOptionalPropertyTypes`

`tsconfig.json` sets `exactOptionalPropertyTypes: true`. This means `{ foo?: string }` and
`{ foo?: string | undefined }` are genuinely different types: the first forbids ever writing
`{ foo: undefined }`, even though `foo` is optional. Spreading an object that might contain
`{ foo: undefined }` into one typed with a plain optional property is a compile error, not a
runtime surprise.

The pattern this forces, used throughout the codebase, is a conditional spread instead of a
possibly-`undefined` value:

```ts
// Not this -- fails to typecheck if `includeAbstracts` is `boolean | undefined` and the target
// type's `includeAbstracts` is a plain optional `boolean`:
{ includeAbstracts: options.includeAbstracts }

// This instead:
{ ...(options.includeAbstracts === undefined ? {} : { includeAbstracts: options.includeAbstracts }) }
```

It shows up constantly at call sites that forward an optional field from one options object into
another (`importCatalog`'s deps, `CommandDeps`). It's verbose,
but it's what `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` together buy: a key that
genuinely was never set can't be confused with one explicitly set to `undefined`.

## Verify a test by deleting the implementation

Before trusting a new or changed test, delete (or otherwise defeat) the two or three lines of
production code that carry the behavior it claims to check, and confirm the suite goes red on
exactly that test -- not zero tests, not a different one. Revert the sabotage before committing.
A test that stays green after its own subject is removed is proving nothing, whatever it's named.

This caught real gaps repeatedly on this branch: a leak test that only worked because of an
adversarial fixture value, a single-flight test that would have passed under a weaker assertion, a
CI-matrix test whose positive assertion alone would have missed a regression a second assertion
was needed to catch. Do this for your own tests as you write them, not only when reviewing someone
else's.
