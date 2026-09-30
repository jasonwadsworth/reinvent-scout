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

Measured with the built CLI against `lens-home` (2043 index records), `--lens explain --limit 10 --json`, on the branch after merging PR 8. Precision is GENUINE / returned in the top 10, under the pr-reviewer's rubric:

- GENUINE: a level 100/200 session whose PRIMARY subject is the concept and which teaches how it works or how to design and build with it.
- WEAK or NOISE: feature-news and launch talks, modernization or migration tooling, certification or training sessions, customer stories, a different product applied to the concept, and 300-level sessions.

I first graded these outputs with a looser rubric (78% tuning, 100% holdout); that number is retired. The "before" column below is the reviewer's independent grade of the previous commit.

### Precision (before -> after)

| Profile | Before (reviewer, a828a6d) | After |
|---|---|---|
| hallway | 3/5 | 2/2 |
| kirocrew | 4/10 | 6/8 |
| adaptative-http | 6/8 | 4/4 |
| policy-tracker | 3/5 | 2/2 |
| career-ops | 1/8 | 1/3 |
| **Tuning** | **17/36 = 47%** | **15/19 = 79%** |
| conformity | 3/5 | 2/2 |
| tracking | 2/4 | 4/5 |
| **Holdout** | **5/9 = 56%** | **6/7 = 86%** |

The original baseline (before any change on this plan) was 28% tuning and 35% holdout under my looser grading; the reviewer's rubric would only lower those. The holdout is not blind: I printed all seven profiles while tuning. The list got shorter (36 to 19 returned on tuning) and `uncovered` grew; that is deliberate.

Grades that carry the result: WEAK are ARC204 (agents cost, kirocrew and career-ops), AIM212 (AgentCore-specific, graded weak for the `agentic` pattern but genuine for tracking, where AgentCore is an evidenced service) and NET219 (VPC Lattice networking). GENUINE include SVS202, SVS203, CON202, CMP203, AIM217, TNC201, ARC203, TNC216, TNC220. SVS207, API201, SVS206, SVS208, DVT202, DVT204 and DVT206 no longer appear.

### Coverage (top 5 concepts; a genuine introduction, or in `uncovered`)

5/5 on hallway, adaptative-http, policy-tracker, career-ops, conformity and tracking; kirocrew 5/5 (agentic has ARC203; genai-single-call and Lambda are uncovered). A concept is uncovered when every session that names it was excluded by a rule (news, modernization, story, certification, game, sponsored, partner) or is not level 100/200. Lambda is now uncovered on five profiles because its only two level-200 sessions are a new-features talk (SVS207) and a customer story (SVS208); that is the reviewer's own grading.

### Other lenses

`all`, `fix` and `next-level` at `--limit 100` are byte-identical to a build of origin/main (PR 8 included) on all 7 profiles (21/21 `cmp`).

### Ceiling

The catalog has about 399 level 100/200 sessions. After the rubric's exclusions, no introductory session names DynamoDB, EventBridge, API Gateway, Cognito, CloudFront, AppSync, SES, Bedrock or Lambda as its subject, so those concepts are uncovered by design. career-ops (1/3) cannot go higher: the three sessions left are agent-building talks and only ARC203 is not product- or cost-specific. Excluding "a different product applied to the concept" for a broad pattern would need the catalog service list inside `matchConcepts`, which the session `services` field cannot supply (it is empty for AIM212 and ARC203), so I stopped there.

### Sabotage list

Each applied alone, the suite run, the named test went red, reverted. Concepts: platform exclusion; gap and dead-code filter; distinct-file centrality; supporting weight; unmapped pattern report; citation merge across spellings; pattern-first tie-break; ecs/eks merge into the service (merge, phrase, citations). Matching: abstract 2 to 1 mentions; listing detection off; vocabulary off; overlap dedupe; ampersand normalization; abstract corroboration; boost; camel-case last word ("AgentCore") and its ordinary-word guard; prefix shared across a list ("Amazon Polly and Transcribe"); each curated phrase (API Gateway). Skips: sponsored; partner; story and its explainer exemption; news (`new`, launch); modernization, migration, transform; certification, proficiency, exam; customer story in the abstract (and the `[Customer]` marker); Gamified learning and Exam prep types; broad-term title-only, build cue and the `agents?` plural. Selection: round-robin loop, first-round covered skip, taken-queue shift, position order; lexicographic order (strength, then boost, then introduction cue, then format, then relevance), each key removed in turn; level filter; 300 title gate and 300 band gate in the uncovered reason. Output: response `uncovered` (full and truncated), unmapped append, limit slice, score sum, repeat grouping, other lenses without `uncovered`, abstract read, human `Uncovered:` line, `kind` on uncovered entries.

### Decisions made during implementation

- **300-level sessions are reported, not listed** (approved by the lead; the listing path was deleted). `uncovered` names the closest 300-level session only when its title names the concept.
- **Abstract-only matches need corroboration** (listed service or matching tag); **broad terms** (`agentic`, `genai-single-call`) need a title that names them and says how to build or design them.
- **Skipped in this lens** (title or type markers, no session codes): sponsored; feature news and launches (any title with "new", "launches"); modernization, migration and transformation; certification, proficiency, exam; "How X ..." customer stories except "how to", "how it works" and questions; customer stories told in the abstract ("how a customer", "[Customer]"); "AWS Partner:" bootcamps (attendance is restricted to AWS Partners); Gamified learning and Exam prep types.
- **Ranking is lexicographic**, not additive: strength, boost, introduction cue, format, relevance. Introduction cues are general markers only (getting started, introduction, intro to, fundamentals, basics, 101, beginners, from scratch, your first); "in under N minutes", "where do" and "first N application" were removed as fitted to single titles.
- **Service names** also match the camel-case last word of a multi-word name (AgentCore) and a prefix shared across a coordinated list.
- **`ecs` and `eks` patterns merge into the ECS and EKS service** of the same short name: one reason line, one turn.
- **`uncovered` entries carry `kind`** (`service` or `pattern`) so a service and a pattern with the same name are distinguishable.
- `uncovered` exists only under `explain`; `serviceNamePatterns` is exported from `stack-fit.ts`; `lens-signals.ts` is untouched.

### Commits

See `git log origin/main..HEAD`. `npm run check` is green at the last commit: 1194 tests.
