# Phase 2: make two profiling runs agree on gaps

## Why

Two agents profiled policy-tracker from the profiling guide and disagreed on three of the five gaps. One profile recorded gap-no-dlq, gap-no-alarms and gap-broad-iam. The other claimed "DLQs and alarms are all in place" after checking a couple of examples. Checked against the repo, the first profile is right:

- **gap-no-dlq**: 34 of 37 EventBridge rules have a DLQ. The 3 Step Functions targets don't.
- **gap-no-alarms**: no state machine has an alarm.
- **gap-broad-iam**: a production Lambda grants `AdminResetUserPassword` on `'*'`.

The guide caused this:

- It only asks profilers to record gaps "you notice while reading".
- It never requires enumerating the relevant resources.
- It forbids inferring a system-wide *absence* from one file, but it doesn't forbid inferring a system-wide *presence* from a sample.

Tracing, CI and Graviton have exact recipes, and the two runs agreed on all three. The full findings are in `<scratchpad>/profile-variance/summary.md`.

The recommendations depend on this. The Fix lens returned 1 session from the wrong profile and 5 from the right one.

## Changes (guide: `skills/reinvent-scout/reference/profiling.md`)

1. **Search recipes for gap-no-dlq, gap-no-alarms and gap-broad-iam**, written in the same style as the tracing, CI and Graviton recipes.
   - **dlq**: list every asynchronous target and event source, including EventBridge rule targets (Lambda, SQS, `SfnStateMachine`, `EventBus`, API destinations), SQS-triggered and stream-triggered Lambdas (`onFailure`), SNS subscriptions, and async Lambda invokes (destinations). For each one, check for a DLQ or failure destination.
   - **alarms**: for each resource kind present (functions, queues, streams, state machines, APIs, containers), check whether an alarm on that resource reaches a person through an SNS topic with a subscription, PagerDuty, Chatbot or similar.
   - **broad-iam**:
     - Grep every IAM statement for a `'*'` resource or a `service:*` action.
     - Ignore actions that can't be scoped (e.g. `cloudwatch:PutMetricData`, `xray:PutTraceSegments`, `sts:GetCallerIdentity`, `logs:CreateLogGroup` on its own).
     - When there are both production and test roles, cite a production one first.
   - Each recipe names file kinds and search terms for CDK (TS, Python), CloudFormation/SAM YAML, Terraform and Serverless Framework, the same way the existing recipes do.
2. **Count, don't sample.** Before recording a gap, or claiming that a practice is in place, count the resources of that kind. Put the count in the note, e.g. "34 of 37 EventBridge rules have a DLQ; the 3 Step Functions targets do not".
   - Add the explicit rule: never claim a practice is present everywhere based on a sample. This mirrors the existing rule against inferring absence from one file.
3. **Absent vs. partial.** If even one resource of the kind lacks the practice, record the gap. Coverage elsewhere goes in the note and never cancels the gap. The citation points to the lacking resource or resources.
4. **Platform services.** Always list platform services you find, as `role: "supporting"`. The gates ignore them, but relevance doesn't.
   - Remove the wording that invites leaving them out.
   - CloudFormation called at runtime (`cloudformation:CreateStack`, SDK clients) is a real service, not CDK's synthesis target.
5. **Every gap note names what was inspected**: the files, or the glob and search used. Add a small code check: `validate_profile` returns a non-blocking **warning** when a `gap-*` pattern's note names no file, path or glob.
   - Warnings are a new optional field on the report.
   - Existing reports without warnings stay byte-identical.
6. **Vocabulary and coverage.**
   - Add `multi-tenant` and `dead-code` to the starting pattern vocabulary.
   - Add Dockerfiles, CI workflow files and IaC directories to "what to read".
   - Check with the e2e-fixes branch first: `concepts.ts` already has a phrase for `multi-tenant`, and the e2e-fixes PR adds a test that every recommended pattern is matchable.

Update the pinned content tests so that each new rule is pinned and goes red if the rule is removed.

## Verification (this is the real test)

After the guide changes, run **three fresh, independent profiling agents** with only the updated guide:

- two on policy-tracker;
- one on conformity, which has known partial gaps (alarms without actions, broad-iam narrowed by a session policy).

Each run writes `<scratchpad>/consistency/<repo>-run<N>.json` and must not read other profiles.

Then compare:

- **Gap agreement:** do both policy-tracker runs record the same gap set, and does it match the ground truth above?
- **Counts in notes:** are they present, and close between the runs (within about 10%)?
- **Services:** is the service set within 2 of the other run, and are the platform services listed?
- **conformity:** do the gaps match the known truth? Check against `<scratchpad>/gaps/conformity-profile-gaps.json` and the repo.
- **Effect:** the Fix lens output under each run.

**Target:** both policy-tracker runs record gap-no-dlq, gap-no-alarms and gap-broad-iam, and the two runs agree on every gap.

## Results

One round, three fresh general-purpose agents given only the updated guide and the repo. Runs are in `<scratchpad>/consistency/`.

| | policy-tracker run 1 | policy-tracker run 2 | conformity run 1 |
| --- | --- | --- | --- |
| Gaps | dlq, alarms, broad-iam, load-tests, cost-monitoring | same five | alarms, broad-iam, tracing, graviton, load-tests, cost-monitoring |
| DLQ count in note | 37 of 40 rule targets, 3 Step Functions lack one | 32+5+8 of 40 targets; 3 of 3 SfnStateMachine lack one | n/a |
| Services (core + supporting) | 23 (14 core) | 24 (16 core) | 20 |
| Platform services listed as supporting | yes (CloudWatch, S3, Route 53, ACM, KMS, Secrets Manager, SSM, CloudFormation, CDK) | yes (same minus KMS, which it marked core) | yes |
| `validate` warnings | none | none | none |
| Fix lens | 5 sessions | the same 5 (SEC429, COP311, API311, SEC404, SVS314) | 4 (SVS334, SVS315, SEC404, SVS314) |

Target met: both policy-tracker runs record gap-no-dlq, gap-no-alarms and gap-broad-iam, agree on every gap, cite the 3 Step Functions targets for the DLQ gap and the production user-api Lambdas for broad-iam. Service sets differ by 1 (Powertools in run 2).

Differences worth knowing:
- gap-no-alarms: run 1 found every alarm gated by `alarmsEnabled: false` in both environments (true, `environments.ts:50,115`) and also cited the unalarmed state machines; run 2 counted alarms as present and cited only the state machines. Same gap, different evidence.
- conformity: matches the known gaps for alarms (no actions), broad-iam (session policy named), tracing and graviton. It missed `gap-no-tests` (audit and company services have 0 test files, 17 in the repo) and `gap-no-waf` (not in the guide's vocabulary). It added load-tests and cost-monitoring, which the guide's rules allow (production via CDK Pipelines).
- Not done: a gap-no-tests recipe. Left for a follow-up since the target did not need a second round.

### Round 2

Guide additions (commit 0c5a814): a practice switched off in every deployed environment counts as absent (the note names the switch and where it is set), and a `gap-no-tests` per-unit recipe (`--passWithNoTests` is not a test). `gap-no-waf` deliberately not added. Runs are in `<scratchpad>/consistency/round2/`.

| | policy-tracker run 1 | policy-tracker run 2 | conformity |
| --- | --- | --- | --- |
| Gaps | dlq, alarms, broad-iam, load-tests, cost | the same five | alarms, tests, broad-iam, tracing, graviton, cost, load-tests |
| alarms evidence | `alarmsEnabled` false in both environments; state machines also unalarmed | `alarmsEnabled` false in both environments | alarms without actions |
| DLQ count | 37 of 40 targets | 37 of 40 targets | n/a |
| tests | n/a | n/a | 3 of 8 units have tests; audit, company, global, both UIs none; notes `--passWithNoTests` |
| Services | 25 | 25 | 20 |
| Warnings | none | none | none |
| Fix lens | SEC429, COP311, API311, SEC404, SVS314 | identical | SVS334, ARC313, SVS315, SEC404, SVS329, SVS314 |

Targets met: both policy-tracker runs agree on every gap and both find the `alarmsEnabled` switch; conformity records gap-no-tests with a per-unit count.
