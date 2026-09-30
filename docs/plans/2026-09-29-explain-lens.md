# Phase 2: an Explain lens that explains the codebase

## Why

`--lens explain` should answer this question from someone new to a codebase: "Which introductory
sessions would teach me the technologies and architecture this code is built on?"

Today it is the `all` lens (BM25+IDF over the profile's services and patterns) with two changes:
it is restricted to level 100/200, and breakouts and chalk talks get a bonus. It has never been
measured, and it inherits the weaknesses the Fix/Next-level work found:

- listing co-mentions count as signals;
- tags count as signals;
- IDF favors a codebase's rarest service over its central concepts;
- nothing ensures coverage, so five talks on one service can fill the list;
- no reason ties a session to the part of the code it explains.

## Target behavior

1. **Concepts, ranked by centrality.** The profile's concepts are its core services and non-gap
   patterns. Exclude `PLATFORM_SERVICES`, gap patterns and `dead-code`. Supporting services
   count at half weight. Centrality = the number of distinct evidence citations (files) behind the
   concept. More cited = more central to understanding the code.
2. **A session explains a concept only if it is about that concept.** It must name the concept in
   its title, or at least twice in its abstract, outside a listing. Reuse `unlistedMatches` /
   `onlyListed` from lens-signals. A tag or listed service can boost a session but never admits it.
   Service matching needs name variants: the full catalog name, the short form ("Amazon DynamoDB"
   → "DynamoDB"), and common abbreviations the catalog vocabulary actually uses. Pattern concepts
   need a small curated phrase map: `serverless`, `event-driven`, `api`, `multi-tenant`,
   `multi-account`, `iac-cdk`, `containers`, `ecs`, `eks`, `agentic`, `genai-single-call`,
   `streaming`, `data-lake`. A pattern with no phrase entry is skipped and reported.
3. **Introductory first.** Only level 100/200 sessions are listed. A 300-level talk does not
   introduce anything, so it is never a candidate. When a concept has no 100/200 session that
   qualifies but a 300 session names it in its title, the concept goes in `uncovered` and the
   reason names that session (code and title). Keep the Breakout/Chalk talk preference as a
   tiebreak, not a gate.
4. **Coverage over repetition.** Select round-robin across concepts in centrality order, with the
   best session per concept each round, so the top N covers as many distinct concepts as
   possible. Repeat sittings are already grouped.
5. **The reason names the code.** Each candidate carries the concept, the session phrase that
   matched, and the profile's evidence citations for that concept, e.g. "explains DynamoDB, which
   this code uses at src/db/table.ts:14". Use a new `Reason` kind (`explainsConcept`). Keep CLI
   `--json` byte-identical to the MCP object.
6. **Honest gaps.** Concepts with no qualifying session come back as `uncovered: [{concept,
   reason}]`, alongside `skippedRules`. Always present, empty when nothing is uncovered.

## Targets (measured on the 7 eval profiles)

Tuning set: hallway, kirocrew, adaptative-http, policy-tracker, career-ops. Holdout: conformity,
tracking. Measure and report both sets separately, before and after.

- **Precision:** at least 70% of the top 10 are GENUINE. GENUINE means an introductory session
  primarily about a concept the profile evidences, which would help a new team member understand
  that part of this code.
- **Coverage:** among the top 5 concepts by centrality, at least 4 have a GENUINE session in the
  top 10, or are honestly reported in `uncovered`.
- **No regressions:** career-ops (no AWS) returns only sessions about its evidenced non-AWS
  concepts, or nothing, plus `uncovered`. The `all`, `fix` and `next-level` outputs are unchanged
  on all 7 profiles (diff them).

## Rules

- TDD with synthetic `IndexRecord`s. Sabotage each mechanism and confirm a named test goes red.
- No session codes or profile special cases in `src`.
- Put domain logic in `src/match/**`. The CLI and MCP only pass `--lens explain` through; update the
  tool description and `workflow.md` if the output shape changes.
- Update `reference/profiling.md` "The explain lens" and `taxonomy.md` to match. Update any pinned
  content tests.

## Out of scope

- Changes to the `all` lens.
- New profile fields.

## Results

Measured with the built CLI against `lens-home` (2043 index records), `--lens explain --limit 10 --json`. Precision is GENUINE / returned in the top 10; weak (W) counts as not genuine. A 300-level session is never GENUINE (not introductory). Scripts and outputs are in the scratchpad (`explain/`), not committed.

### Precision (before -> after)

| Set | Before | After |
|---|---|---|
| Tuning (hallway, kirocrew, adaptative-http, policy-tracker, career-ops) | 14 / 50 = 28% | 28 / 36 = 78% |
| Holdout (conformity, tracking) | 7 / 20 = 35% | 9 / 9 = 100% |

Per profile after (genuine / returned): hallway 5/5, kirocrew 7/10, adaptative-http 8/8, policy-tracker 5/5, career-ops 3/8; conformity 5/5, tracking 4/4. Before: hallway 4/10, kirocrew 3/10, adaptative-http 5/10, policy-tracker 2/10, career-ops 0/10; conformity 3/10, tracking 4/10.

Honesty note on the holdout: I printed all seven profiles' outputs at every step, so I saw conformity and tracking while tuning. No rule was written for a holdout-only candidate, and the mechanisms were motivated by tuning-set noise, but it is not a blind holdout.

### Coverage (top 5 concepts by centrality; GENUINE in the top 10, or listed in `uncovered`)

hallway 5/5 (api, iac-cdk, CloudFront uncovered; event-driven, serverless genuine). kirocrew 4/5 (agentic has only weak sessions MAM204 and ARC204; genai-single-call uncovered). adaptative-http 5/5. policy-tracker 4/5 (Bedrock: only TNC210 remained and is not genuine; then SES, DynamoDB, EventBridge uncovered). career-ops 5/5 (agentic genuine; Playwright, genai-single-call, Claude Code, Gemini uncovered). conformity 5/5. tracking 5/5.

### Other lenses

`all`, `fix` and `next-level` outputs (`--limit 100`) are byte-identical to the baseline on all 7 profiles (`cmp`), at the first and at the last commit.

### Remaining noise

- career-ops (3/8): ARC204 and GHJ212 are about agents but not introductions (W); MAM204, TNC217 and TNC105 apply agents to another subject (N). agentic is a broad term and a title cue is the only handle regex has.
- kirocrew: MAM204 (N), ARC204 (W), CMP202 "New silicon, new instances" (W, news-like).
- policy-tracker: TNC210 is dropped only because AWS Partner sessions are skipped; before that it was a Bedrock false positive.
- Most of the catalog's introductory pool is small (about 399 sessions at level 100/200): no introductory session names DynamoDB, EventBridge, API Gateway, Cognito, CloudFront, AppSync or SES in the title, so those come back in `uncovered`.

### Sabotage list

Each applied alone, the suite run, the named tests went red, reverted: platform exclusion; gap/dead-code filter; abstract 2 -> 1 mention; listing detection off; vocabulary off (lowercase list); overlap dedupe ("Amazon DynamoDB" counted twice); supporting weight; distinct-file centrality; unmapped pattern report; citation merge across spellings; boost; ampersand normalization; API phrase; sponsored filter; partner filter; story filter and its explainer exemption; news filter; broad-term title-only and build cue; `agents?` plural; intro-cue bonus; abstract corroboration; pattern-first tie-break; title-only 300 fallback; one 300 per concept; 300 gating on introductory coverage; fallback after introductory picks; first-round covered skip; format, boost, strength and relevance ordering; taxonomy of level filter; queue shift on taken; match position order; round-robin loop; response `uncovered` (full and truncated); unmapped append; limit slice; score sum; repeat grouping; other lenses without `uncovered`; abstract read; human `Uncovered:` line; the closest-session reason (title gate, 300 band gate).

### Decisions made during implementation

- **300-level sessions are reported, not listed.** As specified, a concept with no 100/200 session took one 300-level session. Graded strictly they were all weak (for example "Origin management for multi-region applications with Amazon CloudFront"), which put precision at 52% (tuning) and 45% (holdout) and left top-5 coverage at 1 to 3 of 5. Now such a concept is in `uncovered` with the reason `no introductory (100/200) session is about it; the closest is a 300-level one: CODE "title"`. The lead approved this; the listing path was removed rather than kept unused.
- **Abstract-only matches need corroboration** (the session lists the service or has a matching tag), a tightening of "at least twice in its abstract". It removed Bedrock false positives on AI-agent security talks.
- **agentic and genai-single-call are broad**: only a title that names the term and says how to build or design it admits.
- **Skipped for this lens** (title markers, no session codes): sponsored, news/recap ("What's new", "year in review"), customer stories ("How X ..." unless "how to", "how it works", questions), and "AWS Partner:" training.
- **Ordering**: centrality ties go to patterns before services, then citation count, then name. Session ties: title over abstract, listed service or tag, introduction-style title, format (Breakout, Chalk talk), profile relevance.
- **Only explain has `uncovered`**; it is absent from the other lenses so their output stays byte-identical.
- The unmapped-pattern report lives in `uncovered` (reason: no phrase entry), not `skippedRules`.
- `serviceNamePatterns` was exported from `stack-fit.ts` for name matching; `lens-signals.ts` is untouched.

### Commits

9de4deb, 60f658d, 019c91c, 7498390, 190f805, c3b3cc4, d5338b5, 88d4ef4, 4206269, 2a0fe7c, d01bbea, plus the Results commit. `npm run check` is green on each: 1104 tests at the last code commit.

