# Phase 2: rank `all` by how much the code actually uses each concept

## Why

PR #11 shipped `all` with its 70% precision target waived. Under the reviewer's grades, tuning is 56% and holdout 70%. The root cause is recorded in `2026-09-30-all-lens.md` → Waiver:

- A concept's centrality is the number of distinct files the profile cites for it.
- Profiles cite sparsely, because the profiling guide asks for a few strong citations, not a census. Every hallway concept has centrality 1, and kirocrew's Kiro has 1.
- So the profile's central technologies rank no higher than incidental ones. Kirocrew's own Kiro sessions sit at #20–33, and generic serverless talks fill the top 10.

The fix changes the input to ranking: give each concept a real measure of how much the code uses it.

A second, smaller regression comes from PR #11. career-ops lost AIM307 and AIM416 (genuine) because a service named only in a list no longer adds rank weight. That rule was right for Lambda in a setup list (BIZ302). It is wrong for a distinctive, rarely mentioned name like Claude Code.

## Target behavior

### 1. `footprint` on profile services and patterns

- Add an optional integer `footprint` to profile services and patterns: the number of distinct source files in the cited repos that use the service or exhibit the pattern.
- Exclude tests, generated code, lockfiles and docs.
- It's a count, not citations. The profiler measures it by search (SDK imports, construct/resource types, client constructors, config keys), and the guide says how.
- Schema: optional, a non-negative integer, validated.
- Bump the profile schema version only if the existing migration rules require it (check `profile.ts`). An old profile without `footprint` must keep working.

### 2. Centrality

- Centrality = `footprint` when present, otherwise the distinct cited-file count, as today. Supporting services stay at half weight.
- Compress with `log2(1 + n)`, so a 200-file service doesn't drown everything else. Use the same formula for both sources.
- Interests keep centrality 1.

### 3. Rank order for `all`

- The lexicographic order stays as it is (strength, centrality sum, concept count, BM25). With real centrality, the central concepts should now lead.
- Check that the 3-per-concept cap still produces coverage.

### 4. Listed mentions of rare services carry weight

- A profile service named only inside a list adds rank weight when the service is rare in the catalog: named, listed or not, in fewer than `RARE_SERVICE_FRACTION` (3%) of sessions.
- Unresolved non-catalog names such as "Claude Code" count by their text occurrences.
- A common service in a list (Lambda) still adds none.
- Goal: restore AIM307 and AIM416 on career-ops, and keep BIZ302 out of kirocrew's top 10.

### 5. Explain

- Explain orders concepts by the same centrality. It should improve too, but it isn't the target here.
- Report explain's changes. Don't require it to be byte-identical.
- Fix and next-level must be byte-identical to main.

### 6. Profiling guide

Add a "Footprint" section to `reference/profiling.md` covering:
- what to count and what to exclude;
- a search recipe per service kind (SDK import, IaC resource or construct type, CLI or config use);
- that it's an estimate and that's fine;
- an example.

Update the example profile and the pinned content tests.

## Evaluation

- Add `footprint` to the 7 eval profiles in `<scratchpad>/gaps/` by following the new guide section (read the repos; don't modify them). Save the results as `<name>-profile-fp.json`, and record the counts and how you got them.
- Grade the `all` top 10 per profile with the PR #11 rubric (in `2026-09-30-all-lens.md`), graded strictly. The reviewer re-grades independently.
- Tuning set: hallway, kirocrew, adaptative-http, policy-tracker, career-ops. Holdout: conformity, tracking.

## Targets

- **Precision:** `all` at ≥70% GENUINE on tuning (all 50 slots) on the reviewer's grades. Report the holdout separately.
- **Kirocrew:** its Kiro sessions reach the top 10.
- **career-ops:** AIM307 and AIM416 are back in its top 10.
- **BIZ302:** stays out of kirocrew's top 10.
- **No regressions:** fix and next-level are byte-identical, MCP stays within its 30 KB budget, and CLI `--json` equals MCP.
- **Backward compatibility:** a profile without any `footprint` gives exactly today's `all` and explain output. Prove it with the original `gaps/` profiles, byte-identical to main.

## Rules

- TDD with sabotage.
- No session codes or profile special cases in `src`.
- Put the domain logic in `src/profile/**` and `src/match/**`.

## Out of scope

- New lenses.
- Fix-lens ranking (SEC429).

## Results

(implementer appends)
