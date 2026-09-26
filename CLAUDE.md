# reinvent-scout

## Commands

- `npm test` -- `vitest run`, the whole suite.
- `npm run typecheck` -- `tsc --noEmit` against `src/`, then again against `tests/` via
  `tsconfig.tests.json`. Both must pass; a type error in a test file is still a failure.
- `npm run lint` -- `eslint .`.
- `npm run build` -- `tsc`, emitting to `dist/`.
- `npm run check` -- all four, in that order. Run this before every commit; it's what CI runs.

## Core vs. adapter

Domain logic lives in `src/auth/**`, `src/api/**`, and `src/catalog/**` (and, as later phases
land, `src/profile/**`, `src/match/**`, `src/schedule/**`). `src/cli/commands/**` and (phase 3)
`src/mcp/**` are thin adapters over these modules: they parse input, call one domain function, and
format the result. If a CLI command or MCP tool is doing anything more interesting than that --
branching on business rules, computing something, deciding what's valid -- that logic belongs in
the domain module it's adapting, not the adapter. Business logic in an adapter is a review
rejection, because it lets the CLI and the (future) MCP server drift apart from each other.

## Injection

Every module that touches time, randomness, the filesystem root, the network, or the process
takes it by injection, with a real default:

- Time: a `now?: () => number` parameter, defaulting to `Date.now`.
- Randomness: PKCE's `crypto` dependency is injectable (see `src/auth/pkce.ts`).
- The store root: never hardcoded or read from `process.env` directly inside a domain module --
  resolved once via `src/core/paths.ts` and passed down as `storeRoot`.
- The network: a `fetchFn?: typeof fetch` parameter, defaulting to the global `fetch`.
- The process: a spawner, a browser launcher (`src/auth/browser.ts`), etc.

No test may hit the real network or the real home directory. Use `tests/helpers/temp-home.ts` for
a per-test store root (respects `REINVENT_SCOUT_HOME`) and `tests/helpers/fake-fetch.ts` for
anything that would otherwise call `fetch`.

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
another (the API client's pagination options, `syncCatalog`'s deps, `login`'s deps). It's verbose,
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
