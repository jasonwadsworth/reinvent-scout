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

### What was built

- **Schema.** `footprint` on services and patterns: an optional non-negative integer (`src/profile/profile.ts`), no schema version bump (like `role`). A profile without one parses unchanged.
- **Centrality.** `log2(1 + n) * weight`, where `n` is the footprint, else the distinct cited files. One decision the plan leaves open: the log is applied only when the profile carries at least one footprint; a profile with none keeps the raw cited-file count. Applying the log to a cited count changes every centrality sum and so the order, which would break the plan's "exactly today's output" rule. Among several spellings of one service, or a service and its pattern twin (ecs), the largest footprint is taken. Interests stay at 1.
- **Rare listed services.** A profile service a session names (listed or not) that fewer than 3% of catalog sessions name (`RARE_SERVICE_FRACTION`, counted by text, so "Claude Code" works) adds a strength-1 match to a session already admitted; it never admits one. Lambda in a setup list adds none. Like the log, it applies only to a profile with footprints, for the same backward-compatibility reason.
- **Profiling guide.** "Footprint" section in `reference/profiling.md` (what to count, what to exclude, a search recipe per kind, that it is an estimate, an example), the example profile, the README, and pinned content tests.

### Footprints measured

From the repos alone, before any match output, with one search per concept (`<scratchpad>/rank/fp.mjs`, the guide's recipes): the project's tracked files, minus tests, fixtures, docs, generated code, lockfiles and `package.json`, then one regex per service (SDK client import, CDK construct, CloudFormation or Terraform type, CLI call, IAM action) and per pattern (handler files for `serverless`, publish/route/consume files for `event-driven`, Dockerfiles and task definitions for `containers`, and so on). The profiles are `<scratchpad>/rank/<name>-profile-fp.json`; counts in `footprints.json`. Largest counts:

- **hallway** (133 source files after exclusions): api 23, AWS AppSync 20, AWS Amplify 20, AWS Lambda 15, serverless 15, Amazon DynamoDB 12, Amazon Cognito 7, Amazon EventBridge 5
- **kirocrew** (1951 source files after exclusions): Kiro 334, agentic 251, AWS Systems Manager 79, containers 60, Amazon CloudFront 25, AWS CloudFormation 16, Amazon S3 16, iac-cloudformation 16
- **adaptative-http** (14 source files after exclusions): AWS CDK 7, iac-cdk 7, Elastic Load Balancing 5, Amazon VPC 5, AWS Lambda 4, AWS Fargate 4, serverless 4, Amazon ECS 3
- **policy-tracker** (1898 source files after exclusions): multi-account 471, Security & Identity 372, AWS Lambda 278, serverless 278, Amazon Cognito 234, Amazon CloudWatch 226, AWS CDK 219, iac-cdk 219
- **career-ops** (62 source files after exclusions): GitHub Actions 8, Playwright 7, Claude Code 5, Google Gemini API 2, genai-single-call 2, agentic 1
- **conformity** (330 source files after exclusions): AWS Lambda 78, serverless 78, Amazon DynamoDB 75, Powertools for AWS Lambda 74, Security & Identity 49, api 38, AWS CDK 36, iac-cdk 36
- **tracking** (181 source files after exclusions): Security & Identity 21, Amazon DynamoDB 20, Amazon Cognito 20, api 20, single-table-design 17, scheduled-jobs 15, AWS Lambda 11, serverless 11

Two recipes were tightened after a first pass that applied the guide too loosely (and before any match output): "Polly" and "Transcribe" as bare words counted every speech file (20 and 50; the SDK-client recipe gives 2 and 3), and `\bagent\b` and `FROM [a-z]` counted every file (768 and 1382; now 251 and 60).

### Backward compatibility

The original `gaps/` profiles at `--limit 100`: `all`, `explain`, `fix` and `next-level` are byte-identical to main (b3007c7) on all 7 profiles, 28/28. `fix` and `next-level` on the `-fp` profiles are also byte-identical to main (14/14), so a footprint changes neither.

### Precision (GENUINE of the top 10, graded strictly like the reviewer)

| Profile | main, gaps profile | footprints |
|---|---|---|
| hallway | 8 | 7 |
| kirocrew | 3 | 5 |
| adaptative-http | 4 | 3 |
| policy-tracker | 7 | 5 |
| career-ops | 1 | 3 |
| **Tuning** | **23/50 = 46%** | **23/50 = 46%** |
| conformity | not graded here | 6 |
| tracking | not graded here | 4 |
| **Holdout** | | **10/20 = 50%** |

**The 70% target is not met.** Footprints fix what they were meant to fix and leave precision where it was:

- **kirocrew:** its Kiro sessions reach the top 10 (IND420, OPN314 "Kiro Crew: Architecture of an open source AI coding agent built on Kiro", DVT320, DVT406, SVS318, MAM324), from #20-33. 3/10 to 5/10. The other five are MAM313 and MAM324 (migration and a customer story told with Kiro in the abstract), SVS302, CMP319 and SVS332.
- **career-ops:** AIM307 and AIM416 are back (ranks 4 and 5), with OPN310 at 1: 3/10. The rest are agent talks that list Claude Code (COP319, CON303, CMP302, CMP349, ANT410) and two generic AI sessions.
- **BIZ302:** out of kirocrew's top 10.
- **hallway, adaptative-http, policy-tracker:** slightly worse. With real centralities the generic serverless sessions that match Lambda, serverless, EventBridge and DynamoDB together sum highest, and those are the pattern the reviewer grades weak (SVS302 Terraform, SVS321 Kafka, SVS333 MicroVMs, SVS332 Lambda Managed Instances, SVS318 Kiro): every one of these profiles really is a serverless profile, so the ranking is right about the stack and wrong about the content.

### Ranking variants tried (not kept)

All four were scored against the same grades with the footprint profiles; none beat the plan's order (23/50):

- centrality = the largest centrality among the concepts named in the title, then the sum: 15/50;
- summing only the concepts matched in the title or twice in the abstract: 12/50;
- the largest centrality of any matched concept, then the sum: 23/50, no change;
- each concept's centrality times its inverse frequency in the catalog (how many sessions name it): 23/50, no change.

The difference between a genuine and a weak pick for these profiles is not how central the matched concepts are; it is what else the session is about (Terraform, Kafka, MicroVMs, Kiro), which no concept weight sees.

### Explain

Explain uses the same centrality. With footprints it returns the same sessions in a different order: hallway, policy-tracker, conformity swap SVS202 and SVS203; kirocrew and adaptative-http reorder their lists (kirocrew's first five are now TNC201, ARC204, CON202, CMP203, SVS203); career-ops and tracking are unchanged. Without footprints explain is byte-identical.

### Regressions and budget

`fix` and `next-level` byte-identical; `match_sessions` `lens: "all"`, `limit: 100` on the `-fp` profiles is 29.6 to 30.6 KB (limit 30720), `isError` false; the MCP candidates are an exact prefix of the CLI's 50 once the dropped ranking reasons are ignored (kirocrew, career-ops, hallway checked).

### Sabotage

Each alone, a named test went red: each schema field and its integer and non-negative checks; the log; the legacy raw count for an unmeasured profile; the footprint over the cited count and the cited-count fallback; the supporting half; the maximum across spellings, through the service merge, the pattern twin and a pattern's own footprint; a pattern footprint alone making a profile measured; the rare set applying only to a measured profile and being passed to `matchAllConcepts`; the 3% fraction; listed mentions counting toward rarity; a rare service not added twice, nor a common one added; strength one; never admitting a session alone.

### Commits

See `git log origin/main..HEAD`. `npm run check` is green: 1372 tests.

## Round 2: off-stack primary subject

### What was built

An admitted session is demoted when its title names a technology the profile does not use, with the reason "about Terraform, which this code does not use" (shown in `why` as "ranked lower: ..."). `all` only; explain, fix and next-level are byte-identical to main on the `gaps/` profiles (21/21), and `all` on a profile without footprints is no longer byte-identical (this demotion changes it, as intended).

- **Technology** = a catalog service the profile does not name, matched only by unmistakable forms (the full name and its parenthesized short form in any case; the name without "Amazon"/"AWS" only when it is a product word such as DynamoDB or ElastiCache, never an ordinary word or acronym: a first version matched "CLI" and "Transform" and demoted OPN310), plus a curated list `OFF_STACK_TOOLS` next to `PREFIX_REQUIRED_SERVICE_NAMES` in `stack-fit.ts`, built from catalog titles (Terraform, Kafka, Kubernetes, Spark, Snowflake, Databricks, MicroVMs, OpenTelemetry, Datadog, Splunk, Redis, PostgreSQL, MongoDB, Iceberg, PyTorch, SAP, Oracle, VMware, OpenAI, Strands, Salesforce, ServiceNow, CrowdStrike, Vercel, Karpenter; Pulumi and Flink are in the lead's list but in no title). A tool is used when a profile service's name or catalog name contains it (Terraform; the EKS catalog name for Kubernetes) or a pattern's wording matches it (`eks` for Kubernetes).
- **Not demoted:** a title that compares or moves between technologies ("vs", "versus", "compare", "between", "from ... to", "instead of").
- **Why the exemption is narrow.** The brief says not to demote when the title also names a profile concept more strongly. Taken literally that spares SVS302: "Building serverless applications with Terraform" also names serverless in the title. Only comparisons are exempt.

### Precision (GENUINE of the top 10, strict and consistent)

My earlier round graded some generic Lambda talks differently per profile; from here one rule applies: a generic serverless or Lambda-at-scale talk is genuine only when Lambda or serverless is among the profile's top three concepts by footprint. The table re-grades the earlier outputs by the same rule.

| Profile | main, no footprint | footprint only | + off-stack (no footprint) | + off-stack, with footprint |
|---|---|---|---|---|
| hallway | 8 | 7 | 9 | 9 |
| kirocrew | 3 | 5 | 4 | 5 |
| adaptative-http | 4 | 3 | 4 | 4 |
| policy-tracker | 7 | 5 | 8 | 9 |
| career-ops | 1 | 3 | 1 | 3 |
| **Tuning** | **23/50 = 46%** | **23/50 = 46%** | **26/50 = 52%** | **30/50 = 60%** |
| conformity | | | 9 | 9 |
| tracking | | | 4 | 5 |
| **Holdout** | | | 13/20 = 65% | **14/20 = 70%** |

**Tuning is 60%, not 70%.** Off-stack adds 3 to 7 points over either alone, and footprint plus the rare-listed-service rule add 4 more on top of it, so both are kept.

### Ablations

- **Footprint in the ranking, with off-stack on:** 30/50 against 26/50 without footprints. Net positive, kept.
- **Rare listed services alone:** with footprints but without the rule 28/50 (hallway 8, policy 9, career-ops 1); with it 30/50. The rule restores AIM307 and AIM416 and is net positive, kept.
- **Other ranking changes tried on top, none better:** capping a concept at three of the top ten counting every concept named in the title (25/50, no better).

### Remaining weak picks and their cause (fp, top 10)

- **adaptative-http (4):** SVS318 (Kiro generating serverless apps; Kiro is a supporting service with footprint 0), SVS344 (.NET modernizing), SVS335, SVS332 (generic Lambda-at-scale; Lambda has 4 of the repo's 14 files), API302, TNC338 (a certification bootcamp). The stack is ECS and a load balancer, but the catalog has far more serverless content than ECS content, and sessions matching serverless, Lambda and EventBridge together sum highest.
- **kirocrew (5):** MAM313 and MAM324 are migration and a customer story (Nissan) that mention Kiro in the abstract; CMP319, SVS332 and NET319 match on a side concept. The catalog's own topic "Migration & Modernization" would demote MAM313 and MAM324, but also MAM331 (landing zones), which the review said to keep, so no rule was added.
- **career-ops (3):** OPN310, AIM307 and AIM416 are genuine; the rest list Claude Code among several agent CLIs or are generic agent or LLM talks.
- **hallway (9), policy-tracker (9):** API401 ("Modernize with Event-Driven Architecture", a modernization talk) on both.

### Regressions and budget

`explain`, `fix`, `next-level` byte-identical to main on the `gaps/` profiles (21/21), `fix` and `next-level` on the `-fp` profiles too. `match_sessions` `lens: "all"`, `limit: 100` on the `-fp` profiles: 30.1 to 30.7 KB (limit 30720), `isError` false; MCP candidates are an exact prefix of the CLI's 50 ignoring dropped ranking reasons (kirocrew, career-ops checked).

### Sabotage (round 2)

Each alone, a named test went red: the used-service filter, a tool named by a service, a tool worded by a pattern, the curated list, the catalog services, the comparison exemption (and its "vs" and "from ... to" forms), the reason text, product-word bare names, the parenthesized short form, and the wiring in `matchAll`.
