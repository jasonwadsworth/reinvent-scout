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

Grades after: the lead's calls for the two disputed sessions (ARC203 "What SOA taught us about building agents in production" is a lessons-learned talk, WEAK; CON202 "Launch a production container app in under 5 minutes" is a hands-on introduction, GENUINE). The range is the honest spread: the lower bound also grades CON202 WEAK (the reviewer's earlier call), and tracking's AIM212 WEAK (AgentCore-specific); the upper bound is my earlier grade of ARC203 as GENUINE.

| Profile | Before (reviewer, a828a6d) | After (lead's grades) |
|---|---|---|
| hallway | 3/5 | 2/2 |
| kirocrew | 4/10 | 6/9 |
| adaptative-http | 6/8 | 5/5 |
| policy-tracker | 3/5 | 2/2 |
| career-ops | 1/8 | 0/3 |
| **Tuning** | **17/36 = 47%** | **15/21 = 71%** (range 13/21 = 62% to 17/21 = 81%) |
| conformity | 3/5 | 2/2 |
| tracking | 2/4 | 4/5 |
| **Holdout** | **5/9 = 56%** | **6/7 = 86%** (lower bound 5/7 = 71%) |

career-ops is 0 to 1 of 3: ARC204 (agent cost) and AIM212 (AgentCore-specific) are weak, and ARC203 is a lessons-learned talk; it is the profile the lens serves worst, because its concepts are non-AWS tools the conference does not cover. The original baseline (before any change on this plan) was 28% tuning and 35% holdout under my looser grading. The holdout is not blind: I printed all seven profiles while tuning. Lists got shorter (36 to 21 returned on tuning) and `uncovered` grew; that is deliberate.

### Coverage (top 5 concepts; a genuine introduction, or in `uncovered`)

5/5 on hallway, adaptative-http, policy-tracker, career-ops, conformity and tracking; kirocrew 5/5 (agentic has ARC203; genai-single-call and Lambda are uncovered). A concept is uncovered when every session that names it was excluded by a rule (news, modernization, story, certification, game, sponsored, partner) or is not level 100/200. Lambda is now uncovered on five profiles because its only two level-200 sessions are a new-features talk (SVS207) and a customer story (SVS208); that is the reviewer's own grading.

### Other lenses

`all`, `fix` and `next-level` at `--limit 100` are byte-identical to a build of origin/main (PR 8 included) on all 7 profiles (21/21 `cmp`).

### Ceiling

The catalog has about 399 level 100/200 sessions. After the rubric's exclusions, no introductory session names DynamoDB, EventBridge, API Gateway, Cognito, CloudFront, AppSync, SES, Bedrock or Lambda as its subject, so those concepts are uncovered by design. career-ops (0 to 1 of 3) cannot go higher: the three sessions left are agent talks and none is a clean introduction. Excluding "a different product applied to the concept" for a broad pattern would need the catalog service list inside `matchConcepts`, which the session `services` field cannot supply (it is empty for AIM212 and ARC203), so I stopped there.

### Sabotage list

Each applied alone, the suite run, the named test went red, reverted. Concepts: platform exclusion; gap and dead-code filter; distinct-file centrality; supporting weight; unmapped pattern report; citation merge across spellings; pattern-first tie-break; ecs/eks merge into the service (merge, phrase, citations). Matching: abstract 2 to 1 mentions; listing detection off; vocabulary off; overlap dedupe; ampersand normalization; abstract corroboration; boost; camel-case last word ("AgentCore") and its ordinary-word guard; prefix shared across a list of known catalog services ("Amazon Polly and Transcribe"), including the title-case rejection ("Amazon Bedrock and Connect Your Data") and the unknown-service rejection; the camel-case tail refused behind for/on/with ("RDS for PostgreSQL", ADOT); the "in under N minutes" cue pinned absent; each curated phrase (API Gateway). Skips: sponsored; feature news is matched only in its news sense ("what's new", "X's new", new features, capabilities, instances, models, execution, silicon, releases, services; launches), so "New to X?" and "Learn new ... skills" survive; partner; story and its explainer exemption; news (`new`, launch); modernization, migration, transform; certification, certified, certify, proficiency, exam (not "certificates"); customer story in the abstract (and the `[Customer]` marker); Gamified learning and Exam prep types; broad-term title-only, build cue and the `agents?` plural. Selection: round-robin loop, first-round covered skip, taken-queue shift, position order; lexicographic order (strength, then boost, then introduction cue, then format, then relevance), each key removed in turn; level filter; 300 title gate and 300 band gate in the uncovered reason. Output: response `uncovered` (full and truncated), unmapped append, limit slice, score sum, repeat grouping, other lenses without `uncovered`, abstract read, human `Uncovered:` line, `kind` on uncovered entries.

### Decisions made during implementation

- **300-level sessions are reported, not listed** (approved by the lead; the listing path was deleted). `uncovered` names the closest 300-level session only when its title names the concept.
- **Abstract-only matches need corroboration** (listed service or matching tag); **broad terms** (`agentic`, `genai-single-call`) need a title that names them and says how to build or design them.
- **Skipped in this lens** (title or type markers, no session codes): sponsored; feature news in its news sense and launches (a bare "new" is not enough); modernization, migration and transformation; certification, certified, certify, proficiency, exam (not "certificates"); "How X ..." customer stories except "how to", "how it works" and questions; customer stories told in the abstract ("how a customer", "[Customer]"); "AWS Partner:" bootcamps (attendance is restricted to AWS Partners); Gamified learning and Exam prep types.
- **Ranking is lexicographic**, not additive: strength, boost, introduction cue, format, relevance. Introduction cues are general markers only (getting started, introduction, intro to, fundamentals, basics, 101, beginners, from scratch, your first); "in under N minutes", "where do" and "first N application" were removed as fitted to single titles.
- **Service names** also match the camel-case last word of a multi-word name that has no for/on/with/of/in/and in it (AgentCore; not PostgreSQL for "RDS for PostgreSQL", which removes 79 distinct catalog sessions from that rule: PostgreSQL 39, OpenTelemetry 37, OpenZFS 3), and a prefix shared across a coordinated list whose earlier items are all known services (the catalog vocabulary, the profile's own service names because the catalog does not list Polly, and the ordinary-word names such as Glue and Backup) and whose last item is followed by the end, punctuation, "and" or "or" (so "Connect to Your Data" and "Connect Your Data" do not match).
- **`ecs` and `eks` patterns merge into the ECS and EKS service** of the same short name: one reason line, one turn.
- **`uncovered` entries carry `kind`** (`service` or `pattern`) so a service and a pattern with the same name are distinguishable.
- `uncovered` exists only under `explain`; `serviceNamePatterns` is exported from `stack-fit.ts`; `lens-signals.ts` is untouched.

### Commits

See `git log origin/main..HEAD`. `npm run check` is green at the last commit: 1199 tests.
