# Phase 2: lens precision

## Why

An evaluation on 7 real profiles found that most `fix` and `next-level` candidates are off-target:

| Lens | Genuine / total | Precision |
|---|---|---|
| Fix | 9 / 47 | 19% |
| Next-level | 19 / 53 | 36% |

The profiles are hallway-track, KiroCrew, adaptative-http, conformity, policy-tracker, tracking.jwadsworth.com and career-ops. The scorecard, the profiles and the raw outputs are in the lead's scratchpad (`lens-eval/`) and are not committed, because the profiles cite private repos.

## Targets (all must hold)

**Precision.** Measured separately on the tuning set and on the holdout.
- Tuning set: hallway, kirocrew, adaptative-http, policy-tracker, career-ops.
- Holdout: conformity, tracking.
- Fix precision must be at least 60% on each set.
- Next-level precision must be at least 60% on each set.
- Every candidate that was not already graded is graded fresh.

**Recall.** At least 8 of the 9 genuine Fix candidates and at least 16 of the 19 genuine Next-level candidates must still appear. API311 must still rank #1 for gap-no-dlq.

**gap-no-alarms admits no NOISE.** An empty result for this rule is acceptable. Noise is not.

**Correct empties stay empty.**
- career-ops returns nothing under either lens.
- KiroCrew's Next-level still skips both paths and reports them in `skippedRules`.
- ecs→EKS may return 0: the catalog has no ECS-to-EKS migration talk, so 0 is the right answer.

**Rules for the mechanisms.**
- They must be general textual or structural rules.
- No session codes or ids in the source.
- No per-profile special cases.
- A mechanism that only fixes one named example is a review rejection.

## Tasks

Each task is TDD with synthetic IndexRecords in tests: red, then green, then sabotage confirms red. The real catalog is never used in tests.

1. **List co-mentions don't count.**
   - A match that sits inside an enumeration of three or more service or product names counts as a listing, not a signal. For example, "Lambda, EC2, ECS and EKS" separated by commas and/or "and"/"or".
   - A listing satisfies neither the phrase, nor the source side, nor the booster.
   - A service in `record.services` no longer satisfies the Next-level source side on its own. The source must appear in the title or abstract text, outside a listing.
   - Known symptoms: OPN201-S, COM328, STG309, HMC206-S, SEC225-S, STG414.

2. **genai-single-call → agentic stops flooding.**
   - "Bedrock" and "prompts" alone are not evidence of the single-call source. The source text has to describe the starting point: single-shot or basic prompting, a chatbot or RAG baseline, first GenAI app, InvokeModel/Converse, or the move "from ... to agents".
   - One "agentic" mention plus the Agentic AI tag must not reach admission strength. A tag still never admits.
   - Include a test with a session that lists Bedrock and says "agentic" once in passing. It must be rejected.

3. **The stack-fit gate counts real stack.**
   - Platform services never count toward the two-core-services condition or the rare-service condition: CloudWatch, VPC, S3, Route 53, ACM, CDK, CloudFormation, IAM, STS, KMS, Secrets Manager, Systems Manager, CloudTrail. Name the list once, in stack-fit.ts.
   - An unresolved profile service name is never "rare". Today `stack-fit.ts:117` gives it frequency 0.
   - Resolve common spellings that fail today, but only where the catalog vocabulary really has the service: "Amazon SES", "Amazon Simple Email Service", "Amazon SNS", "AWS X-Ray", "Powertools for AWS Lambda". Check against `tests/fixtures/catalog-vocabulary.json` and add aliases only for names that exist.

4. **Fix rule phrases are specific.**
   - gap-no-alarms: match only operational alarm or alerting language, for example "CloudWatch alarms", "alarms on/for <metric>", "alerting strategy", "on-call", "paging", "SLO/SLI alerting". Bare "alerts" or "alarms" does not match. The Monitoring & Observability tag must not lift a single weak mention to admission.
   - Gap cue: drop bare "no". Keep missing, without, lacking, absent and forgotten. Symptoms: "no IAM policy catches" (ARC330) and "no exception, no alarm" (OPN401).
   - gap-no-dlq: a session that uses a DLQ only as one scenario among many must not reach admission (SVS322, CON337). API311 still ranks #1.
   - gap-no-tests: also match "test-driven", "test coverage" and "testing infrastructure" (misses: ARC313).

5. **Remediation-tool gate path.**
   - A Fix rule may name remedy services, the tools that close its gap: IAM and IAM Access Analyzer for gap-broad-iam; AWS Budgets, Cost Explorer and billing for gap-no-cost-monitoring.
   - When the rule's phrase is in the session title, or appears twice or more in the abstract, a remedy service on the session satisfies the stack-fit gate in place of the profile's services.
   - Misses this fixes: SEC404 for 4 profiles, COP311 for policy-tracker.

6. **Reverse direction.** Exclude Kubernetes/EKS → serverless or AgentCore sessions from serverless→containers (MAM413).

7. **Profiling guide (`reference/profiling.md`).**
   - Mark platform services as `role: "supporting"` by default, using the same list as task 3.
   - Add `ecs` and `eks` to the naming-patterns starting vocabulary.
   - Say that an unresolved name is fine, but give the resolvable spellings for the aliases in task 3.
   - Say that gap-no-alarms means no alarm that notifies a person. An alarm that only drives automation doesn't count.
   - Resolve the IAM conflict: IAM stays out of `services`. The remedy path in task 5 is how broad-IAM sessions get in.
   - Update the skill content tests if they pin any of this text.

## Measurement

- The implementer re-runs the lenses on all 7 profiles against the catalog-only copy in `lens-home`, grades every new candidate, and reports the precision table (tuning and holdout separately), the recall check and the top remaining noise.
- The implementer tunes against the tuning set only and looks at the holdout at the end. If a holdout miss leads to a further change, say so.
- The PR reviewer re-grades independently.

## Out of scope

- New rules or paths.
- Ranking weights beyond what the tasks need.
- The reservations and on-site code.

## Results

Measured with the built CLI against `lens-home` (2043 index records), `--limit 100`, on `phase-2/lens-precision` at the last commit below. Precision is genuine / returned; W (weak) counts as not genuine. Scripts and per-run outputs are in the lead's scratchpad (`prec/`), not committed.

### Precision (before -> after)

| Set | Lens | Before | After |
|---|---|---|---|
| Tuning (hallway, kirocrew, adaptative-http, policy-tracker, career-ops) | Fix | 8 / 37 = 22% | 12 / 14 = 86% (+2 W) |
| Tuning | Next-level | 13 / 110+ = 12% (policy-tracker capped at 100) | 13 / 18 = 72% (+2 W) |
| Holdout (conformity, tracking) | Fix | 1 / 10 = 10% | 3 / 3 = 100% |
| Holdout | Next-level | 6 / 13 = 46% | 6 / 6 = 100% |

Per profile after: hallway Fix 4/4, Next-level 3/3; kirocrew Fix 1/1, Next-level 0 (both paths skipped); adaptative-http Fix 4/4, Next-level 0/1; policy-tracker Fix 3/5 (+2 W), Next-level 10/14 (+2 W); career-ops 0 and 0; conformity Fix 3/3, Next-level 3/3; tracking Fix 0, Next-level 3/3.

The holdout was looked at once after tasks 1 to 7 were done and before the final gate change (a remedy service counts as one of the two distinct services, instead of standing in for the whole gate). That change was motivated by the tuning set (Fix precision was exactly 60% there, with SEC424 and SEC429 as the noise) and by SVS314 dropping out; it also lifted the holdout from 60% to 100%.

### Recall

- Fix: 8 / 9 genuine still appear. Missing: adaptative-http CON337, whose one dead-letter-queue mention is exactly the "DLQ as one scenario" case task 4 removes on purpose.
- Next-level: 17 / 19. Missing: policy-tracker MAM336 (its only other core service is API Gateway) and SVS401 (only Lambda); both are agents-on-your-stack talks that name a single core service beyond Bedrock.
- API311 ranks #1 for gap-no-dlq on hallway, kirocrew, adaptative-http and policy-tracker (the only admitted DLQ session on each).

### Correct empties and gap-no-alarms

- gap-no-alarms admits nothing on any of the 7 profiles (0 of 28 admitted before, all noise).
- career-ops: 0 under both lenses; Next-level reports `genai-single-call` as skipped.
- KiroCrew Next-level: 0, `skippedRules` lists both `serverless` and `genai-single-call`.
- ecs -> EKS on adaptative-http returns 1 (STG414), not 0; the plan allows either.
- tracking Fix returns 0 (it had 4 noise before); the catalog has no alarms-on-serverless-API talk that the phrase accepts.

### Newly graded candidates

Candidates that were not in the scorecard and now appear, graded from their titles and abstracts:

| Code | Lens / profile | Grade | Why |
|---|---|---|---|
| SEC404 | Fix, all four profiles with gap-broad-iam (hallway, adaptative-http, policy-tracker, conformity) | G | IAM policy tooling in CI, listed as a miss before |
| SVS314 | Fix, adaptative-http and conformity | G | least-privilege Lambda hardening; the `*` policies are on Lambda roles (policy-tracker stays W as before) |
| COP311 | Fix, policy-tracker | G | Bedrock cost allocation and budgets, listed as a miss before |
| SVS317 | Next-level, policy-tracker | G | agents coordinated with EventBridge on Lambda, the same class as SVS306 |
| API319 | Next-level, policy-tracker | G | Step Functions and Lambda durable functions for agents |
| AIM454 | Next-level, policy-tracker | W | single prompt versus agentic inference tuning; right topic, but tuning rather than the move |

Graded and then removed by later changes: SEC424 (IAM policy evaluation, W on 3 profiles), SEC429 (agent memory ABAC, N on hallway and adaptative-http, W on policy-tracker and conformity), COP311 on hallway (W, no Bedrock). SEC429 still appears on policy-tracker (W).

### Remaining noise

- Next-level: STG414 (adaptative-http, "EKS and ECS deployments" for file storage), AIM224-S and DAT410 (policy-tracker; a sponsored assistants-to-agents talk and a RAG-to-agentic data talk), plus weak ARC312 and AIM454.
- Fix: SEC429 and SVS314 on policy-tracker (W).
- A two-name coordination such as "EKS and ECS" is still not a listing (three names are needed); a rule for it would also reject genuine "ECS or EKS" decision talks.

### Sabotage list

Each was applied to the new mechanism alone, the suite run, and the named tests went red; every sabotage was reverted.

1. Listing detection off (`listingSpans` empty): 5 tests in "Next-level list co-mentions".
2. Listed service tag as the source side restored: the three "requires ... to mention the source side" tests.
3. Bedrock and `prompts?` restored in the single-call source: "does not take Bedrock or prompts alone".
4. `minTextStrength` 2 -> 1: "needs two agentic mentions, tag or not".
5. Platform filter removed from `isCore`: 3 stack-fit tests. Unresolved frequency 1 -> 0: "never treats an unresolved service name as rare".
6. Source-stack path disabled: "takes agents built on two of the profile's other services". `minDistinct` query ignored: "lets a caller raise the number of distinct services" and "does not take one other service". `without` ignored: 2 stack-fit tests.
7. Gap cue `no` restored: "does not read a bare no as a gap cue". Bare `alarms?` added: 4 "does not match bare alerts or alarms" cases. `test-driven|test coverage|testing infrastructure` removed: 3 tests. gap-no-dlq `minStrength: 1` restored: "admits a DLQ mentioned once only when ...". Monitoring tag booster restored on gap-no-alarms: "never lets the Monitoring tag lift one weak alarm mention".
8. Remedy path: `text >= 2` -> `>= 1`: "admits it when the abstract names the phrase twice, not once"; remedy check removed: 3 tests; remedy dedupe removed: "counts a remedy service that is also a core service once"; remedy count of one service alone: 2 tests; empty-list guard removed: "treats an empty remedy list as no remedy".
9. Kubernetes/EKS-to-serverless branch removed from `reverse`: 3 "excludes a Kubernetes-to-serverless move" cases.
10. The docs (task 7) are pinned by 6 new tests in `tests/skill/content.test.ts`; no code sabotage applies.

### Decisions made during implementation

- **Single-call source (task 2).** Taken literally (starting-point text only) Next-level recall was 13 / 19: six genuine "agents on Lambda and Step Functions" talks have no starting-point wording. The source side is therefore satisfied by the starting-point text, or, without it, by a session that lists or names at least two of the profile's core services other than Bedrock (the source's own service). Bedrock and prompts alone still admit nothing. "from ... to agents" only counts when the "from" side is a GenAI baseline (chatbot, assistant, copilot, prompt, RAG, LLM, GenAI, single-...); a bare "from on-premises to agentic" admitted a dozen industry talks. A bare "chatbot" or "RAG" also no longer counts: they need a qualifier (basic, simple, existing, standalone, first, starter, or "baseline").
- **Remedy path (task 5).** One remedy service standing in for the whole gate let in IAM-evaluation and agent-memory talks (SEC424, SEC429). Each remedy service the session lists now counts as one of the two distinct services, so IAM plus Access Analyzer admits (SEC404), IAM plus a core service admits (SVS314), and IAM alone does not.
- **Platform services (task 3)** are dropped from the core set for both lenses and for `hasCoreService`, not only from the two Fix conditions: a profile of only platform services has no stack to fit. A few existing tests used S3 as a core service and now use SQS.
- **No aliases (task 3).** The catalog vocabulary (fixture and the real catalog) has none of Amazon SES, SNS, AWS X-Ray or Powertools, so none was added; the profiling guide says so.
- **Booster (task 1).** A tag booster only ever applies on top of an unlisted text hit, so a listing cannot reach it. Fix rules no longer have a booster: the Monitoring tag was removed from gap-no-alarms instead of gated.
- **gap-no-dlq (task 4)** now needs strength 2 (title, two mentions, or a missing/without/lacking cue), which drops SVS322 and CON337 as the plan intends.
- **Test and doc fixtures** that relied on one unresolved service being "rare", on "one prompt" as the single-call source, or on the alarms phrase were updated; the executable example profile in `workflow.md` gains a second core service (AWS Lambda).

### Commits

345a52e, b64e5cb, 122b972, cb159da, 3cb5bdf, 125ae39, 5c2908c, 6c12ffe. `npm run check` is green on each: 1014 tests.
