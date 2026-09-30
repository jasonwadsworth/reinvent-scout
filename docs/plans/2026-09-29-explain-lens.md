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
3. **Introductory first.** Keep level 100/200. When a concept has no 100/200 session that
   qualifies, allow one 300 session for it, marked in the reason. Keep the Breakout/Chalk talk
   preference as a tiebreak, not a gate.
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

(implementer appends)
