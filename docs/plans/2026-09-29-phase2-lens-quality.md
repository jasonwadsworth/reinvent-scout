# Phase 2 lens quality: make Fix and Next-level recommendations worth presenting

Written 2026-09-29 by the lead after two real-repo skill tests (hallway-track, KiroCrew) run by
fresh agents that had only the skill docs. Builds on `docs/plans/2026-09-28-phase2-lenses.md`
(commits 76275e5, de83815). Single PR on branch `phase-2/lenses`.

## Evidence that drives this plan

- About half of each lens's top 10 were weak fits or false positives once checked against the
  real abstracts.
- Ranking: after admission, general profile relevance ranks everything, so sessions that mention
  "observability" or "least privilege" in passing (and share the repo's services) bury precise
  fixes. API311 ("How event driven architectures go wrong", covers missing dead-letter queues)
  ranks below 50 for hallway-track's cited `gap-no-dlq`, but 3rd with a DLQ-only profile.
- Selectivity against the 2,043-session catalog: DLQ 0.3%, tests 0.6%, load 0.5%, cost 0.6%,
  rightsizing 1.6%, IAM 2.1% (all fine); alarms 9.5% (the bare word "observability");
  serverless->containers 12.4% (185 by tags alone); ecs->eks 8.3%; genai->agentic 52% (892 by
  the "Agentic AI" area tag alone, e.g. IND3320, an Android build talk).
- Dead selector: the alarms rule checks area "Observability"; the real tag is
  "Monitoring & Observability" (157 sessions). Tests passed on an invented fixture tag.
- Direction: Next-level admitted reverse migrations (COM340 and SVS207: containers to Lambda
  MicroVMs) and suggested "go agentic" to KiroCrew, which is already agentic.
- Contract drift: CLI `match --json` returns a bare array while workflow.md and SKILL.md step 6
  describe `{ candidates, truncated, returned, requested, omitted, hint }`; CLI `profile validate`
  prints a one-line summary instead of the documented report; human `match` output omits level;
  `profileEvidence` drops the citation's `note`; workflow.md lists six reason kinds, then eight.
- KiroCrew's default ranking is dominated by services that come only from its deploy templates,
  not from how the product runs; profiles cannot mark a component as supporting.

## Decisions

1. **Rank within each activated rule, then interleave.** For Fix and Next-level, build one ranked
   list per activated rule (gap or path), then merge round-robin in rule order (rules ordered by
   their best candidate's score). A session matched by several rules appears once, at its earliest
   position, carrying every matching reason. The overall `limit` applies after interleaving. Each
   candidate gets `lensRules: string[]` (the source pattern names that admitted it). Every cited
   rule with any admitted session is therefore represented near the top.
2. **Signal strength, and tags never admit alone.** Per rule and session compute strength from the
   session's own text: phrase in title = 3; phrase at least twice in abstract = 2; phrase once in
   abstract = 1; a matching tag/topic/service adds +1 but cannot admit on its own. Admission needs
   strength >= 2. Within a rule's list, rank by strength first, then profile relevance. Reason
   weight becomes `20 + 10 * strength` so scores stay explainable.
3. **Tighter selectors.**
   - Alarms: phrase `alarms?|alerting|alerts|anomaly detection|CloudWatch alarms?`; the bare word
     "observability" is not a phrase match; tag `Monitoring & Observability` is a +1 booster only.
   - Agentic: phrase `agentic|agents?\b with tools|tool[- ](?:use|calling)|multi[- ]agent|agent
     orchestration`; the "Agentic AI" area is a booster only.
   - Containers and EKS: phrase-based as today; the Containers topic and ECS/EKS services are
     boosters only.
   - Every tag, topic and service named in a rule must exist in the real catalog vocabulary. Extend
     `tests/fixtures/catalog-vocabulary.json` with a `services` list derived from the snapshot at
     ~/reinvent-scout-snapshots/catalog-2026-09-25.json (throwaway script, not committed), and add
     a test asserting every rule selector is in that vocabulary.
4. **Direction.** Each migration path has a reverse-direction regex applied to title and abstract.
   Serverless->containers reverse: `(?:from|replac\w*|migrat\w*|mov\w*) (?:\w+ ){0,3}containers?
   (?:\w+ ){0,4}(?:to|with|into) (?:\w+ ){0,2}(?:Lambda|serverless|functions?)|MicroVMs?`.
   ECS->EKS reverse: `from (?:Amazon )?EKS (?:\w+ ){0,3}to (?:Amazon )?ECS`. Agentic has none. A
   reverse match excludes the session for that rule. Tune these against the real sessions named
   above; they are starting points, not requirements.
5. **Already there.** A migration path is skipped when the profile also has the destination
   pattern (`containers` for serverless->containers; `eks` for ecs->eks; `agentic` for
   genai-single-call->agentic), compared case-insensitively. The match result reports
   `skippedRules: [{ rule, reason }]` so the agent can explain why, e.g. "profile already has
   agentic". This supersedes the previous plan's "existing destination patterns do not suppress".
6. **Supporting components.** Profile service entries accept an optional
   `role: "core" | "supporting"` (default core; schema version stays 1). Supporting services
   contribute half weight to service reasons and relevance. profiling.md explains when to use it
   (deploy templates, example apps, CI-only tooling, code the product generates for users).
7. **One contract for CLI and MCP.**
   - CLI `match --json` prints the same object the MCP tool returns (`candidates`, `truncated`,
     `returned`, `requested`, `omitted`, `hint`, plus `skippedRules`). Human output shows level
     and, for lens candidates, the rule names.
   - CLI `profile validate --json` prints the documented report; human output shows each service
     with its catalog name or "unresolved", and the pattern names.
   - `profileEvidence` preserves every citation field, including `note`.
8. **Docs.** workflow.md lists all eight reason kinds once; documents `lensRules`, `skippedRules`,
   "unscheduled" offerings, and the CLI/MCP shape being identical. profiling.md covers the explain
   lens, partial gaps ("not evident in the cited scope" applies when some components lack it; say
   which), tool-free utility calls inside an agentic app (tag both `agentic` and
   `genai-single-call`; the path is then skipped as already there), and `role`. taxonomy.md stops
   citing the repo test fixture path. SKILL.md still requires the agent to check direction and
   passing mentions before presenting.

## Tests

- Carve a lens fixture from the real snapshot with real titles and abstracts (synthetic speaker
  names): API311, SVS329, SVS314, COM326, SVS322, SVS317, COM324, SVS336, COM201, ARC410, SVS320,
  COM320, ARC325, CON337, COM340, SVS207, COM303, AMZ401, IND3320, SVS324, SVS326, plus 10
  unrelated sessions. Add it as a separate fixture file with a provenance note; do not change the
  existing 60-session fixture.
- Acceptance on that fixture, using profiles shaped like the saved real ones:
  - hallway-shaped Fix: API311 is in the top 5; SVS329 and SVS314 are in the top 10; SVS317,
    SVS325, COM324, SVS336, COM201 are not admitted for gap-no-alarms or gap-broad-iam on a
    passing mention.
  - Next-level serverless: SVS320 and COM320 admitted; COM340 and SVS207 excluded as reverse;
    COM303 and AMZ401 excluded (tag-only or single passing mention).
  - genai-single-call with `agentic` present: path skipped with a skippedRules entry; without
    `agentic`: IND3320 not admitted, SVS324 admitted.
- Rule-vocabulary test against the real vocabulary file; interleave test (two rules each get a
  session in the top 2); `role: "supporting"` halves the service weight; `note` survives into
  profileEvidence; CLI JSON equals the MCP object shape for the same input; `profile validate`
  JSON matches the documented report keys.
- Sabotage each new mechanism (interleave, strength gate, tag-only admission, reverse regex,
  already-there skip, role weighting, note propagation) and require a named failing test.
- `all` and `explain` output unchanged for existing tests.

## Acceptance by the lead

After the reviewer approves, the lead reruns the saved real profiles
(/private/tmp/reinvent-skill-test/{hallway,kirocrew}-profile.json) against the real catalog with
the built CLI and checks each top-10 pick's abstract. Target: at least 8 of 10 genuine fits per
lens, API311 in hallway's Fix top 5, and no reverse-direction migrations.

## Constraints

Usage is near the weekly limit: one implementer and one reviewer, one fix round, findings batched.
Never touch ~/.reinvent-scout except read-only use by the lead; teammates set REINVENT_SCOUT_HOME
inline to temp directories. No account writes. Commits end with the attribution trailer.
