# Phase 2 lenses — Sub-plan 1 of 1: Fix, then Next-level

**Why single PR:** Both lenses are bounded extensions of the existing matcher and share the same reason contract, adapter plumbing, and documentation; expect under 1,000 substantive lines. Implement Fix first, then Next-level, with task 0 included.

**Goal:** Recommend sessions addressing evidenced architecture gaps or named migration options, with checkable source citations and session signals.
**Merges after:** none — first sub-plan
**PR title prefix:** none (single PR); proposed title: `Add evidence-based Fix and Next-level session lenses`

## Decisions made

- Keep profile schema version 1. The agent authors evidence-bearing patterns; no repository walker, detector, profile generator, or inferred absence in deterministic code.
- Add public lens names `fix` and `next-level`; preserve `all` as the default and preserve `all`/`explain` ranking, level restrictions, and reason output for existing inputs.
- New lenses do not impose level or format preferences. A candidate must match an activated rule's actual destination/remediation signals. Existing source-service matches, prose in an intent, preferred formats, and broad tags alone cannot admit candidates.
- Use a small shared, typed rule table with exact case-insensitive pattern-name activation (no prefix matching). Unknown gap names, prototype keys, unsupported architecture patterns, or no active rules yield no candidates under the new lenses. Unknown patterns remain valid profile data.
- Fix initially supports `gap-no-dlq` (Reliability), `gap-no-alarms` and `gap-no-tests` (Operational Excellence), `gap-broad-iam` (Security), `gap-no-load-tests` (Performance Efficiency), `gap-no-cost-monitoring` (Cost Optimization), and `gap-no-resource-rightsizing` (Sustainability). These are a curated vocabulary, not claims that every repo has those gaps or a complete Well-Architected assessment. Pillar names follow the [official six-pillar framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/the-pillars-of-the-framework.html), verified by the lead. Each rule has narrowly scoped catalog phrases/areas, not merely a broad pillar topic.
- Next-level initially supports exactly three named paths: `serverless` → containers, `ecs` → EKS, and `genai-single-call` → agentic. Require the corresponding evidence-bearing positive architecture pattern. A Bedrock service, a Lambda dependency, a Kubernetes interest, or prose mentioning a migration does not substitute for agent judgment of the current architecture. Existing destination patterns do not globally suppress the path: multi-repo and mixed architectures can legitimately include both ends.
- Every migration explanation states a concrete gain and cost: container/runtime control vs operational ownership; Kubernetes portability/ecosystem vs cluster/platform complexity; multi-step tool use vs latency, cost, evaluation, and control requirements. Label paths as exploration options, never upgrades or recommendations to migrate automatically.
- Preserve `Reason.evidence` as the actual matched catalog signal string. Add optional `profileEvidence: Evidence[]` only to `pillarGap` and `migrationPath` reasons; copy citations from the activating pattern. `detail` names the rule/path and pillar or trade-off. Fix absence language says “not evident in the cited scope”; broad IAM is an evidenced scope concern rather than an absence.
- Deduplicate activated rules and source citations. Score each activated rule at most once per session even when several selectors match. Use weight 30 per matched rule, then add the existing profile score only after a candidate passes the lens-specific signal gate, so sessions addressing the same gap/path rank by relevance to the repository rather than alphabetically. Keep all contributing reasons and additive score accounting. Reuse existing repeat grouping, ranking, limits, rounding, and MCP budget handling.
- Intent remains agent-interpreted context, including open GitHub issues as intent. Skill guidance connects a relevant issue to the cited gap/path during presentation; the matcher does not classify freeform issues or invent evidence from them.
- All verification uses injected fixture catalogs and temporary roots. Never read the real store, make network calls, change the attendee's account, push, or publish as part of this plan. Local commits are allowed after checks. Publishing/PR creation awaits explicit user approval.

## Files

- Modify: `src/skill/install.ts` — truthful symlink-refusal text and duplicate-comment cleanup.
- Modify: `tests/skill/install.test.ts` — discriminate preflight atomicity from later write guards.
- Modify: `tests/skill/content.test.ts` — fix command extraction coverage and verify lens documentation contracts.
- Modify: `src/match/lens.ts` — shared lens literal list and new neutral lens profiles.
- Create: `src/match/lens-signals.ts` — curated gap/path rules, activation, catalog matching, and cited reasons.
- Modify: `src/match/score.ts` — extend `Reason` with two kinds and optional source citations.
- Modify: `src/match/match.ts` — dispatch new lenses through rule scoring without altering old scoring.
- Create: `tests/match/lens-signals.test.ts` — source activation, selector specificity, deduplication, and reason tests.
- Modify: `tests/match/match.test.ts` — end-to-end new-lens eligibility and compatibility tests.
- Modify: `src/cli/commands/match.ts` — accept new lenses and render cited reasons.
- Modify: `src/mcp/tools.ts` — share lens validation and forward intact cited reasons.
- Modify: `tests/cli/match-command.test.ts` — JSON and human-readable lens output and validation.
- Modify: `tests/mcp/tools-catalog.test.ts` — new lens contracts, citations, and budget behavior.
- Modify: `skills/reinvent-scout/SKILL.md` — explain both available lenses and evidence/trade-off presentation.
- Modify: `skills/reinvent-scout/reference/profiling.md` — exact supported source vocabulary and scope-limited gap evidence.
- Modify: `skills/reinvent-scout/reference/workflow.md` — executable lens contracts and example outputs.
- Modify: `README.md` — availability, lens semantics, examples, and limitations.

## Implementation checklist

Each task is a small test/change cycle; split parameterized cases into individual 2–5 minute cycles when needed. Run `npm run check` before each local commit. Targeted runs below use the repository's `npm test -- <paths>` interface. Prefix commands that could resolve a default store with an inline `REINVENT_SCOUT_HOME` pointing to a newly created temporary directory; never export it globally. Stage named files only. Follow session attribution guidance for commit trailers.

### Task 0a: Make installer preflight tests discriminating

- [ ] In `tests/skill/install.test.ts`, add a dangling manifest symlink on an otherwise empty install and assert that no content files were created; an outside-target assertion alone is insufficient. Add a symlinked `reference` directory with a source file sorted before it and assert that earlier file is absent after refusal. Cover inside-root directory targets as well as outside ones; retain existing leaf/live/dangling/conflict coverage.
- [ ] Run `npm test -- tests/skill/install.test.ts` with each relevant preflight temporarily removed — expect the corresponding atomicity assertion to FAIL; restore and require PASS. These existing-behavior tests may initially pass, so mutation is the required red step.
- [ ] Add an inside-root symlink diagnostic assertion — expect FAIL for the misleading “resolves outside” claim.
- [ ] In `src/skill/install.ts`, retain refusal of symlinks, use truthful wording that does not assert every symlink escapes, and remove the duplicate preflight comment.
- [ ] Run `npm test -- tests/skill/install.test.ts tests/skill/update.test.ts`, then `npm run check` — expect PASS; commit `fix: clarify installer symlink refusals and prove atomic preflight`.

### Task 0b: Close fenced-command validation gaps

- [ ] In `tests/skill/content.test.ts`, add command extraction cases for `text` fences and `npx reinvent-scout` commands, with optional shell prompt and options after the command; include an invalid command so the actual registry check must reject it. Keep JSON prose ignored.
- [ ] Run `npm test -- tests/skill/content.test.ts` — expect FAIL on newly recognized commands.
- [ ] Update the extraction helper in `tests/skill/content.test.ts` to scan those forms without loosening unrelated prose matching. Remove each change in turn and require the new cases to fail.
- [ ] Run `npm test -- tests/skill/content.test.ts`, then `npm run check` — expect PASS; commit `test: validate text-fenced and npx skill commands`.

### Task 1: Define cited Fix rules

- [ ] Create `tests/match/lens-signals.test.ts` with one positive and one close-negative session per supported gap: DLQ/redrive vs generic queue use; alarms/observability vs generic operations; testing vs generic development; least privilege/IAM policy scope vs generic security; load/performance testing vs generic compute; cost monitoring vs generic cost marketing; rightsizing vs generic sustainability. Use exact controlled area matches or explicit whole-token phrases, never one incidental word such as “no,” “resource,” or “test” embedded inside another word.
- [ ] Assert exact activation, case handling, unknown `gap-*`, `constructor`, empty patterns, merged citations for duplicate patterns, and “not evident” wording with the original repo/file/line intact.
- [ ] Run `npm test -- tests/match/lens-signals.test.ts` — expect FAIL.
- [ ] Create `src/match/lens-signals.ts` exposing `scoreLensSignals(record: IndexRecord, profile: ResolvedProfile, lens: "fix" | "next-level"): ScoredSession`; initially implement Fix and return no signals for Next-level. Extend `Reason` in `src/match/score.ts` with `pillarGap`, `migrationPath`, and optional `profileEvidence: Evidence[]`. Store definitions in readonly arrays/Maps, not externally indexed plain objects.
- [ ] Require positive matches to report actual catalog selectors and source citations; scores equal reason weights. Sabotage exact activation, selector gate, and citation propagation separately — each must produce a named failing test.
- [ ] Run `npm test -- tests/match/lens-signals.test.ts tests/match/score.test.ts` — expect PASS. Hold the local commit until Task 2 wires the useful behavior.

### Task 2: Integrate Fix without leaking ordinary profile matches

- [ ] In `tests/match/match.test.ts`, add Fix fixtures where a strongly matching source-service session must be excluded but a narrowly relevant remediation session is included; absent and unknown gaps yield zero results. Assert duplicate patterns cannot inflate score; repeat group reasons/citations belong to its winning sitting and existing sorting/limits still apply. Pin old `all`/`explain` results for the same existing fixture profile.
- [ ] Run `npm test -- tests/match/match.test.ts` — expect FAIL.
- [ ] In `src/match/lens.ts`, export `LENSES = ["all", "explain", "fix", "next-level"] as const`, derive `Lens`, and give new lenses neutral profiles. In `src/match/match.ts`, choose `scoreLensSignals` only for new lenses; reuse the existing positive-score gate and candidate pipeline.
- [ ] Sabotage dispatch by restoring ordinary scoring for Fix — the generic-source exclusion must fail. Run `npm test -- tests/match`, then `npm run check` — expect PASS; commit `feat: match evidenced architecture gaps to sessions`.

### Task 3: Add three named migration trade-offs

- [ ] In `tests/match/lens-signals.test.ts` and `tests/match/match.test.ts`, parameterize the three source patterns against destination-specific sessions: Containers topic or ECS/EKS coverage; EKS service or Kubernetes area; Agentic AI area or explicit agentic/tool-use phrasing. Exclude source-only sessions, mere Bedrock service use without `genai-single-call`, near-spelled source names, unknown patterns, and alien catalog vocabulary. Assert path names, costs and benefits, exact source citations, and actual destination evidence.
- [ ] Run `npm test -- tests/match/lens-signals.test.ts tests/match/match.test.ts` — expect FAIL for Next-level.
- [ ] Add the three rules to `src/match/lens-signals.ts`; do not infer a source pattern from a service or parse intentions as selectors. Reuse deduplication and score accounting.
- [ ] Sabotage each source gate and destination gate in turn and require the relevant negative to fail. Run `npm test -- tests/match`, then `npm run check` — expect PASS; commit `feat: surface named migration paths with trade-offs`.

### Task 4: Expose lenses consistently through CLI and MCP

- [ ] In `tests/cli/match-command.test.ts` and `tests/mcp/tools-catalog.test.ts`, call both new lenses with the same fixture profiles and assert matching codes, reason kinds, actual catalog evidence, and complete citations; invalid lens names still fail and omitted lens stays `all`. Test human CLI output includes the source location and trade-off, not only JSON. Test a large cited reason still respects MCP whole-candidate truncation and byte budget.
- [ ] Run `npm test -- tests/cli/match-command.test.ts tests/mcp/tools-catalog.test.ts` — expect FAIL.
- [ ] In `src/cli/commands/match.ts` and `src/mcp/tools.ts`, consume shared `LENSES`, update help/schema, retain domain-only policy, preserve citations in lean output, and format new source citations in human CLI reasons. Keep current JSON fields and budget semantics.
- [ ] Sabotage one adapter's lens acceptance and separately citation forwarding; require targeted failures. Run targeted tests, then `npm run check` — expect PASS; commit `feat: expose Fix and Next-level in CLI and MCP`.

### Task 5: Make documented flows executable and evidence-bound

- [ ] In `tests/skill/content.test.ts`, add tests that the workflow advertises the same lens enum as the real MCP tool, that profile examples validate and activate each intended rule, and that documented lens calls return the expected new reason kinds against temporary synthetic catalog fixtures. Count parsed examples to avoid vacuous checks. Execute original profile objects, never `validate_profile` reports.
- [ ] Run `npm test -- tests/skill/content.test.ts` — expect FAIL.
- [ ] Update `skills/reinvent-scout/SKILL.md`, `skills/reinvent-scout/reference/profiling.md`, `skills/reinvent-scout/reference/workflow.md`, and `README.md`. Document exact supported gap/source vocabulary, pillar mapping, scoped absence language, unknown-pattern/no-result behavior, optional cited reasons, and migration costs/benefits. Remove “not available” language. Explain that gaps require nearest relevant code citations and notes, source architecture patterns require real usage, and issue intent is not proof of an absence or authorization for a migration.
- [ ] Run `npm test -- tests/skill/content.test.ts tests/docs.test.ts`, then `npm run check` — expect PASS. Walk built CLI profile validation and both matching commands using temporary fixture catalogs and only identifiers emitted by previous steps; inspect composed reasons. Commit `docs: guide evidence-based lens profiling and recommendations`.

## Review gate

- Reconcile expected test counts and inspect human output, not just candidate ordering.
- Batch findings in one review round; keep any sabotage temporary, verify it actually changed the intended implementation, then restore before the final full check.
- Confirm no new code reads repositories or accesses the real attendee store/network. Empty profiles, unsupported names, malformed profiles through existing validation, missing catalog, prototype keys, duplicate citations, mixed architectures, and budget truncation have explicit coverage.
- After local implementation and review, report changed behavior and validation. PR creation, publishing, and any real-account write remain pending explicit user authorization. If a PR is later authorized, run the required fresh independent PR review before merge.

## Lead approval

Approved 2026-09-28 with these amendments: retain the existing `genai-single-call` source pattern; treat the seven pillar mappings as curated starting guidance, not a complete architecture audit. Batch task 0 into one local commit and tasks 1–5 into one coherent lens commit. Run targeted red/green and mutation checks within each batch, and the full `npm run check` before each of the two commits rather than at every intermediate checklist step. No publishing without user approval.

Ranking amendment: a strict gap/path signal is necessary for admission, then existing profile relevance ranks the admitted sessions. Add a discriminating test where two sessions match the same lens rule but the one covering a cited source service must rank higher. Ordinary overlap alone must still return no candidate.

## Implementation and verification

Completed both batches on `codex/phase2-lenses`. Task 0 is commit `76275e5`.
New lenses read cached abstracts once per match to check contiguous phrases; no index schema change.
Lens signals are required for admission, then ordinary profile scoring ranks eligible sessions.
The existing `all` and `explain` outputs matched the saved 2,043-session-catalog baseline exactly
for the 20-candidate regression probe. Both new built CLI flows and all three migration sources
worked against that snapshot; alien vocabulary returned zero candidates under all four lenses.
The exact ten-pattern teaching profile also passed the built CLI validation/match/catalog-show flow.

Full check: 702 tests in 50 files, typecheck, lint, build. Test count: 647 baseline + 2 cleanup +
34 lens-signal + 8 matcher + 6 CLI + 3 MCP + 2 documentation tests. Twenty implementation mutation
probes were killed (four cleanup, sixteen lenses), with applied-edit assertions and restoration.
Independent review approved without blockers or should-fix findings: 172 targeted tests plus lint,
typecheck, exact-name and manifest-preflight mutations, and 62 post-restoration tests passed.
The review's literal-matching limitation is documented: subject coverage does not establish migration
direction; the skill must inspect the abstract and explain reverse-direction or comparison talks.

No real attendee store access, account writes, push, or publication performed.
