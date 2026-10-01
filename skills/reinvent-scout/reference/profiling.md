# Profiling a repository

There is no deterministic profiler in this tool. You (the agent) read the repository and write the
profile yourself, then hand it to `validate_profile` and `match_sessions`. This file is how to do
that well. It exists because an earlier, code-based profiler was tried and removed: every review
round found another false-positive shape (a service named only in a comment, a prefix that
happened to collide with an unrelated word, a mention in a README that was never actually wired
up). Reading the code and judging it in context does a better job than pattern-matching its text --
but only if you follow the discipline below, since the same mistakes a bad detector makes are just
as easy for you to make by skimming instead of checking.

## What to read

Work outward from the files that declare what the project actually depends on and runs as, not
from prose that describes what it's supposed to do:

- **Manifests**: `package.json`, `requirements.txt`/`pyproject.toml`, `go.mod`, `pom.xml`/
  `build.gradle`, `Gemfile`, `*.csproj`. These name the real dependencies.
- **Infrastructure as code**: CDK (`*.ts`/`*.py`/`*.java` under a `cdk`/`infra`/`stacks` directory,
  or wherever `Stack` subclasses live), CloudFormation/SAM templates (`template.yaml`,
  `*.template.json`), Terraform (`*.tf`).
  Read every directory that holds infrastructure as code, not the first stack you find: a monorepo
  has one per service, and a gap or a service can sit in any of them.
- **SDK imports and client construction**: `import`/`require` of an AWS SDK package, or the
  language-specific client construction call (`new DynamoDBClient(...)`, `boto3.client("s3")`,
  `dynamodb.New(cfg)`).
- **Handlers and entry points**: Lambda handler files, container entry points, request handlers --
  where a service is actually called, not just imported.
- **Dockerfiles and container manifests**: a base image or installed package can name a service or
  runtime the manifests alone don't (e.g. a self-hosted database image implies no managed database
  service is in use at all, which is itself worth recording).
- **CI configuration**: `.github/workflows/*.yml`, `buildspec.yml`, `.gitlab-ci.yml` -- these often
  name a deploy target or a service client the application code doesn't import directly (a
  CodeBuild project deploying to ECS, for instance).
- **The README**: useful for the story, for stated goals (see "Interests" below), and for open
  issues, but never as the source of truth for what services are actually used -- see "prose"
  below.

## Evidence: the one rule with no exceptions

Every service and every pattern in the profile must carry at least one evidence citation -- a
`repo`, a `file`, and ideally a `line`. `validate_profile` rejects an entry with none. This isn't
just a schema rule to satisfy: the whole reason the profile is agent-authored rather than generated
by rules over text is that a person reviewing a match's reasons has to be able to open the cited
file and line and see the claim for themselves. Never assert a service from memory of "repos like
this usually use X" -- if you can't point at the line, don't include it.

A citation looks like:

```json
{ "repo": "api", "file": "src/handlers/create-order.ts", "line": 12, "snippet": "new DynamoDBClient({})" }
```

`snippet` must be copied verbatim from the cited line -- never paraphrased or cleaned up. If you
want to explain *why* the line counts as evidence, or the snippet alone doesn't make it obvious,
say that in `note` instead of editing the snippet. Before you finish, re-check every `line` number
against the file as it exists right now: a line shifts easily while you're still reading and citing
other parts of the same file, and a citation that points at the wrong line is worse than no citation
at all -- it looks verified when it isn't.

## What doesn't count as evidence

- **Commented-out infrastructure.** A `// new SnsClient(...)` left behind after a migration is not
  a service the repository uses today. Skip it, or note the absence if it's relevant (see below).
- **Prose mentions.** A README that says "we plan to add caching with ElastiCache" or an
  architecture doc that describes a target state is not evidence the code does that today. A
  service named only in a comment, docstring, or description string is the same case -- it has to
  be called, provisioned, or declared as infrastructure, not just talked about. Design docs and
  specs (an `adr/` or `docs/decisions/` directory, `.kiro/specs`, an RFC) are prose for this
  purpose too, exactly like the README -- useful context, never a citation for a service or
  pattern. They can inform `intents` instead (see "Fold in issues and other context" below).
- **Code nothing reachable invokes.** A Lambda handler file, a client class, or a module that
  nothing else actually calls into is not evidence the repository uses that service -- the same
  treatment as commented-out code, just at the file level instead of the line level. "Reachable"
  covers more than a stack construct wiring up a Lambda: a registered CLI command, a UI route, a
  built-in app entry point, or a packaged script that itself runs something like `aws
  cloudformation deploy` all count as real invocation, not just an infrastructure-as-code
  construct. If it's a real, notable piece of code nothing reaches, record it as its own
  `dead-code` pattern (see "Naming patterns" below) rather than as a service.

## Distinguish SDK generations

This distinction is JavaScript/TypeScript-specific. `aws-sdk` (v2, a single monolithic package) and
`@aws-sdk/client-*` (v3, one package per service) are different signals there, not interchangeable
spellings of "uses the AWS SDK." Note which generation a repository is on when it's relevant --
it can matter for how current the codebase is, but the Fix lens does not infer gaps from version numbers.

Python has no equivalent split to track: `boto3` and the AWS CLI (invoked from a script) are
equivalent evidence of using whatever service they call, with no generation distinction to note.

## What counts as a service

A service is any AWS service, or AWS-published developer tool the code starts or installs (CDK,
Amplify, Kiro), the code or infrastructure actually uses -- not just the services a tool like CDK
or Amplify goes on to provision or call, but the tool itself. It does not include:

- **Ubiquitous plumbing that's implied by everything else**, not a deliberate choice worth
  surfacing on its own: IAM (used by virtually every AWS repository to grant permissions), STS
  (any use, including runtime AssumeRole), CloudFormation *specifically when it's only there
  because CDK synthesizes to it*, and the *default* AWS-managed KMS key. A hand-written
  CloudFormation or SAM template the repository deploys directly is a real, deliberate choice and
  counts as a service, exactly like Terraform would; so does CloudFormation called at runtime
  (`cloudformation:CreateStack`, a CloudFormation SDK client), which is not CDK's synthesis target. A dedicated (customer-managed) key the code actually uses
  to sign or encrypt something is a real choice and counts; only the default key, present whether
  or not anyone thought about it, doesn't. Only these four are left out; every other platform service
  you find is listed (see "Supporting components and mixed usage"). If IAM policies are unusually broad rather than scoped to what the
  code needs, that's still worth recording -- as a `gap-broad-iam` pattern (see "Naming patterns"
  below), not a service. IAM stays out of `services`: sessions about IAM tooling reach a
  `gap-broad-iam` profile through the remedy services path (see "Supported evidence lenses"), not
  through a listed service.
- **A feature of a service, cited as if it were a separate service.** DynamoDB Streams is DynamoDB,
  not a separate entry; CloudWatch Logs is CloudWatch, not a separate entry. Fold the feature into
  its parent service's own `usage` or evidence instead of listing it twice under two different
  names.

A service used only optionally, or only in CI (a test suite that spins up a local DynamoDB, a
deploy pipeline that calls a service the running application never does), still counts -- say so
plainly in `usage` rather than dropping it or presenting it as core to the running application:
`"Optional: enabled via a feature flag, off by default."` or `"CI only: used by the deploy
pipeline, not by the running application."`

## Prefer the specific service over its parent

When a repository calls a more specific product under a broader service family, name the specific
one:

- Amazon ElastiCache Serverless, not plain ElastiCache, for a repository provisioning the
  serverless variant specifically.
- A runtime client implies its parent service, not a separate entry: `bedrock-runtime` means
  Amazon Bedrock; `sagemaker-runtime` means Amazon SageMaker. Name the parent service either way --
  the catalog groups sessions under the product name, not the runtime API name.

## Naming services

Prefer the service's own name over an SDK package or resource-type spelling when you can -- write
what you'd say out loud ("DynamoDB", "Step Functions", "Amazon Bedrock"), not
`@aws-sdk/client-dynamodb` or `aws_dynamodb_table`, though the CLI will resolve either: it strips
known wrapper affixes (`@aws-sdk/client-`, `aws-sdk-`, `aws_`, `aws-cdk-lib/aws-`, an SDK's own
module path) and, for a Terraform-style compound resource name left over after stripping (like
`aws_elasticache_serverless_cache`), resolves it by longest matching prefix against the catalog so
the more specific product wins over its parent. Capitalize acronyms the way AWS does: AI, ML, S3 --
not Ai, Ml, S3 with an inconsistent case, and not spelled out unless that's genuinely clearer.

A name that doesn't resolve against the current catalog is not an error -- `validate_profile`
reports it in `unresolvedServices` and keeps it in the profile. Include it anyway if the evidence
is real; an unresolved name still contributes to text matching even though it can't produce an
exact-match reason, and it counts toward the number of distinct services a Fix session must share.
It never counts as rare, so one unresolved name alone never lets a Fix session through.

The catalog has no entry for Amazon SES, Amazon SNS, AWS X-Ray, Amazon CloudWatch RUM, Powertools
for AWS Lambda or Amazon Bedrock AgentCore, whatever the spelling ("Amazon Simple Email Service"
does not help): write the name AWS uses and expect it to stay unresolved. Names that do resolve
include "Amazon SQS", "Amazon ECS" or "ECS", "Amazon EKS" or "EKS", "AWS Lambda", "AWS Step
Functions", "Amazon EventBridge", "Amazon API Gateway" and "Amazon Bedrock".

## Skip anything that isn't the project's own code

Dependency directories (`node_modules`, `vendor`, `.venv`, `site-packages`), build output (`dist`,
`build`, `target`), and tool caches are not the repository being profiled -- a manifest or an SDK
import found inside one of these belongs to a dependency, not to this project, and citing it would
misattribute someone else's stack as this repository's own.

## Naming patterns

A pattern's `name` is a short, kebab-case, architectural noun -- reused across
repositories with the same shape, not a one-off phrase invented per repository (`"event driven"`
and `"event-driven-architecture"` should both just be `event-driven`). Use this starting vocabulary:

`serverless`, `event-driven`, `containers`, `ecs`, `eks`, `api`, `streaming`, `iac-cdk`,
`genai-single-call`, `agentic`, `multi-account`, `multi-tenant`, `data-lake`.

These are the names `match_sessions` and `map_profile` know how to match to sessions. A pattern with any other name is
recorded in the profile but cannot be matched, and comes back as `uncovered`, so do not invent names for a shape that fits none of
these: leave it out. A user's topical interests belong in `interests`, not in a pattern; you do not invent them. (Terraform and
CloudFormation have no pattern name because no session wording is defined for them; cite the services instead.)

A gap (see "Say what's missing, too" below) is always kebab-case with a `gap-` prefix, so it's never confused with a positive, present-tense pattern: `gap-no-dlq`,
`gap-no-alarms`, `gap-broad-iam`, `gap-no-tests`, `gap-no-tracing`. Code nothing reaches is `dead-code` (no `gap-`
prefix -- it isn't an absence, it's a presence that doesn't count).

## Say what's missing, too

Record real absences -- no test suite, no alarm that notifies a person on the
infrastructure you found, no dead-letter queues on an async pipeline, IAM policies that are broad
rather than scoped to what the code actually needs. Search for them (see "Search recipes for the
common gaps" below) instead of waiting to notice one while reading. These aren't services in the `services` sense
(they have nothing to cite a positive line for), so record them as `patterns` entries named with the
`gap-` prefix (see "Naming patterns" above). The citation rule is the same as for anything else,
applied to the nearest relevant line: cite the resource that *lacks* the thing -- the queue
declaration with no redrive policy, the stack with no alarm construct, the IAM statement with a
wildcard resource -- and explain what's absent and why it matters in `note`; there's no line of
code for an absence itself to point at. The Fix lens consumes these agent-authored judgments;
it does not scan repositories or infer an absence from missing service entries.

**Count, do not sample.** Before you record a gap, or say a practice is in place, count the
resources of that kind and put the count in the `note`: "34 of 37 EventBridge rules have a DLQ; the 3
Step Functions targets do not". Checking two or three examples and finding them fine proves nothing about
the rest: never claim a practice is present everywhere from a sample, exactly as you never infer a
system-wide absence from one file.

**Absent versus partial.** If even one resource of the kind lacks the practice, record the gap.
Coverage elsewhere goes in the `note` as the count and never cancels the gap. The citation points at
the resources that lack it: cite the lacking resource or resources, not one that has the practice.

A practice that is wired in but switched off in every deployed environment counts as absent: a
feature flag that is false, `enabled: false`, a commented-out association, an env-gated construct
whose condition is false in each environment you can see. Check the environment configuration, not
only the construct. The note names the switch and where it is set ("every alarm is gated by
`alarmsEnabled`, false in both environments in `environments.ts`"), and the citation can be the line
that sets it.

**Every gap note names what was inspected**: the files, or the glob and the search term you used. A
note that names no file, path or glob cannot be checked by whoever reads it, and `validate_profile`
returns a warning for it (the profile is still valid).

Record `gap-no-load-tests` and `gap-no-cost-monitoring` only when the repository deploys production
infrastructure (IaC with a real environment, or a pipeline to one) and has none of the named
practices; otherwise leave them out, since they are true of almost any repository. A gap may apply
to a clearly cited part of the system: record it and say which part in the `note`. A wildcard
permission narrowed by a condition or session policy is still recordable as `gap-broad-iam`, with
the narrowing mentioned in the `note`.

## Search recipes for the common gaps

Four gaps are easy to get wrong by sampling, so each has a search that enumerates the resources
first. Run it over every package, service directory and stack in the repository (a monorepo has one
per service), skipping dependency and build directories. Each recipe names where to look for CDK
(TypeScript, Python), CloudFormation/SAM YAML or JSON, Terraform and the Serverless Framework.

- **`gap-no-dlq`** recipe. List every asynchronous target and event source, then check each for a
  dead-letter queue or failure destination. The list: every EventBridge rule target (a Lambda, an SQS
  queue, an `SfnStateMachine` or Step Functions target, an event bus, an API destination), every
  SQS-triggered or stream-triggered Lambda (an event source mapping, with `onFailure` or a
  dead-letter queue on the source queue), every SNS subscription, and every Lambda invoked
  asynchronously (a `destination` or `onFailure`, or a function-level dead-letter queue). The check:
  CDK (`.ts`, `.py`) looks for `deadLetterQueue`, `deadLetterQueueEnabled`, `onFailure`, `DeadLetterQueue`
  and `dead_letter_queue` on each target, queue or subscription; CloudFormation/SAM looks for
  `DeadLetterConfig`, `RedrivePolicy`, `OnFailure` and `EventInvokeConfig`; Terraform looks for
  `dead_letter_config`, `redrive_policy`, `destination_config` on `aws_cloudwatch_event_target`,
  `aws_sqs_queue`, `aws_sns_topic_subscription` and `aws_lambda_function_event_invoke_config`; the
  Serverless Framework looks for `onError`, `destinations` and `redrivePolicy` under `functions` and
  `resources`. Record the gap for the target kinds that lack one, naming the count.
- **`gap-no-alarms`** recipe. List the resource kinds present (functions, queues, streams, state
  machines, tables, APIs, containers), then for each kind check whether an alarm on it reaches a person:
  the alarm has an action that publishes to an SNS topic with a subscription, or to PagerDuty, an
  AWS Chatbot channel or similar. CDK looks for `cloudwatch.Alarm`, `addAlarmAction`, `SnsAction`,
  `alarmActions` and `.metric...createAlarm`; CloudFormation/SAM for `AWS::CloudWatch::Alarm` with
  `AlarmActions`; Terraform for `aws_cloudwatch_metric_alarm` with `alarm_actions`; the Serverless
  Framework for the alerts plugin (`alerts:`) or alarm resources. An alarm with no action, or one
  that only drives scaling or rollback, does not reach a person. Record the gap for each resource
  kind (a state machine, a queue) that has no alarm reaching a person, and say which kinds do.
- **`gap-broad-iam`** recipe. Grep every IAM statement (policy documents, `PolicyStatement`, `Effect:
  Allow`, `aws_iam_policy_document`, `iamRoleStatements`) for a resource of `'*'` (also `"*"` and
  `Resource: '*'`) or a `service:*` action. Ignore actions that cannot be scoped to a resource:
  `cloudwatch:PutMetricData`, `xray:PutTraceSegments`, `sts:GetCallerIdentity`, `logs:CreateLogGroup` on
  its own, and the like. Of the rest, judge whether the code needs that much. When the repository has
  both production and test roles, cite a production one first and name the test roles in the `note`.
  A wildcard narrowed by a condition or session policy is still recordable (see above). Look in CDK
  (`.ts`, `.py`), CloudFormation/SAM, Terraform (`.tf`, including `.json` policy files) and the
  Serverless Framework (`serverless.yml`).
- **`gap-no-tests`** recipe. Enumerate the deployable units: each service, package or function that
  has its own handler directory, manifest or stack. For each, count the test files (`*.test.ts`,
  `*.spec.ts`, `test_*.py`, `*_test.go`, a `tests/` or `__tests__` directory) and note the runner
  (`jest`, `vitest`, `pytest`, `go test`). Record the gap for every unit with none, with "N of M units
  have tests" in the `note`, and cite a unit that has none. A pipeline flag such as
  `--passWithNoTests` does not count as tests, and neither does a test script that runs nothing.
  Infrastructure-only units (CDK, CloudFormation/SAM, Terraform, Serverless Framework definitions)
  count when they hold logic worth testing, such as a custom resource, but not when they only declare
  resources. A test directory shared by every unit counts for the units it exercises.

## What counts as each newer gap

Three more gaps have a fixed definition, so two people profiling the same repository record the same
ones. Each needs a code citation of the thing that *lacks* the practice. A gap that is only partly
true is still recordable: cite the part that lacks it and say which part in the `note`. A practice
that is wired in but switched off (`Disabled`, `false`, a tracing mode of `PassThrough`) is the gap, and you cite the line that switches it off. A practice that
is present but weak (tracing sampled at a low rate, a pipeline that runs one test) is not this
gap.

- **`gap-no-tracing`** (Operational Excellence). The repository deploys a request path that crosses
  two or more components (an API to a function to a queue or table, a service calling another
  service) and a function or service on it has no tracing enabled: no X-Ray active tracing
  (`tracing: Active`, `TracingConfig`), no OpenTelemetry SDK, collector or Lambda layer, no
  Powertools Tracer. Tracing on the API alone (an AppSync `xrayEnabled`) does not trace the
  functions behind it; cite an untraced function or service declaration and name the others in the
  `note`. Logs and metrics are not tracing. A single function that calls nothing else is not this
  gap.
- **`gap-no-ci`** (Operational Excellence). The repository deploys infrastructure or services to a
  real environment and holds no pipeline that builds or tests it on change: no
  `.github/workflows`, `buildspec`, CodePipeline or CDK Pipelines stack, `.gitlab-ci.yml`,
  CircleCI or Jenkins file. Cite the IaC entry point. A pipeline that only runs tests still counts
  as CI, so it is not this gap. If the pipeline could live in a different repository, say so in the
  `note` and record it only when the repository is the deployable unit.
- **`gap-no-graviton`** (Sustainability). The repository deploys production compute and every
  resource in the cited scope runs on x86: Lambda functions with no `architecture` (the default
  is x86_64), ECS task definitions with `X86_64` or no `runtimePlatform`, EC2 instance types with no
  Graviton family (the ones ending in `g`, such as `m7g`). Cite the function or task declaration.
  A resource pinned to x86 by a dependency you can see (an x86-only native layer, an image built
  `--platform=linux/amd64`) is not this gap; mention it in the `note` of the gap you do record, if
  any. Custom resources and placeholder functions (reserved concurrency 0, an inline stub) are not
  production compute, so x86 there is not this gap.

## Interests

`interests` comes from the repository's own stated goals -- what the README says the team is
working toward -- or, when you're running interactively, from asking the attendee one short
question about what they're hoping to get out of the conference. Never invent an interest purely
from the architecture you found; an interest is what someone *wants*, not a restatement of a
service or pattern you already recorded elsewhere.

For each interest, look for the nearest match in `reference/taxonomy.md`'s "Areas of interest" list
and spell it exactly as the catalog does -- `"Event-Driven Architecture"`, `"Kubernetes"`, `"Cost
Optimization"`, not a paraphrase of any of them. This matters mechanically, not just stylistically:
under the `all` lens an interest is a concept of its own (centrality 1, no code cited). A session whose title
names it, or that carries a topic or area-of-interest tag equal to it, is returned with a `matchesConcept`
reason "Matches your interest in X"; an interest spelled any other way is admitted only by a title that names it.
"Exact" here means spelling and punctuation, not case -- the comparison is case-insensitive -- so there's no
need to match the catalog's capitalization, only its wording. Sessions about an interest rank after sessions
about the services and patterns you evidenced. An interest that names a broad topic ("Agentic AI") also stops
sessions about it being ranked lower as off-topic. Shared wording and `intents` only break ties. Keep an
interest as free text only when nothing in the real list is a good fit -- a title mention still admits it.

## Fold in issues and other context

If you have access to the repository's open GitHub issues, fold ones that describe a real technical
problem or goal into `intents`:

```json
{ "kind": "issue", "text": "Cold starts on the ingest Lambda are too slow under load", "ref": "https://github.com/org/repo/issues/142" }
```

Use `"goal"` instead of `"issue"` for something you learned isn't tracked as an issue at all -- a
stated roadmap item from the README, something the user told you directly, an RFC or spec
describing something not yet built, or a gap the README states outright ("we don't have alarms on
this yet"). `ref` is optional and is the right place for an issue URL or number; leave it off for a
goal with no such reference. A design doc or spec (see "What doesn't count as evidence" above) can
inform an `intent` the same way -- a documented future direction is a legitimate goal -- but never
a service or pattern citation.

## The profile shape

`validate_profile` and `match_sessions` both take this object as their `profile` argument
(`schemaVersion` is currently always `1`; `services` and `patterns` are required arrays -- write
them as `[]` when there's genuinely nothing to report, never omit them). `repos[].languages` is
lowercase, as shown below (`"typescript"`, not `"TypeScript"`) -- list every language with real
code in the repository, not just the primary one: a TypeScript API with a deploy script in `bash`
and a build step in plain `javascript` lists all three, not just `typescript`. `repos[].summary` is
one or two sentences on what the repository *does* -- "Order-processing API on Lambda," not a
restatement of the `services` list as prose.

```json
{
  "schemaVersion": 1,
  "repos": [
    {
      "root": "api",
      "languages": ["typescript", "bash", "javascript"],
      "summary": "Order-processing API on Lambda."
    }
  ],
  "services": [
    {
      "name": "Amazon DynamoDB",
      "usage": "Stores orders and their line items.",
      "evidence": [
        { "repo": "api", "file": "src/handlers/create-order.ts", "line": 12, "snippet": "new DynamoDBClient({})" }
      ]
    }
  ],
  "patterns": [
    {
      "name": "event-driven",
      "note": "Order creation publishes to EventBridge.",
      "evidence": [
        { "repo": "api", "file": "infra/stack.ts", "line": 44, "snippet": "new events.EventBus(this, \"OrderEvents\")" }
      ]
    },
    {
      "name": "api",
      "note": "REST APIs on API Gateway, every route fronted by a Lambda request authorizer.",
      "evidence": [
        { "repo": "api", "file": "infra/stack.ts", "line": 20, "snippet": "new apigateway.RequestAuthorizer(this, \"OrderAuthorizer\")" }
      ]
    },
    {
      "name": "gap-no-dlq",
      "note": "Searched infra/*.ts for every sqs.Queue and Rule target: 1 of 2 queues has a dead-letter queue. The order-created consumer queue has none and no redrive policy, so a repeatedly-failing message is retried forever instead of being set aside for inspection.",
      "evidence": [
        { "repo": "api", "file": "infra/stack.ts", "line": 61, "snippet": "new sqs.Queue(this, \"OrderCreatedQueue\")" }
      ]
    }
  ],
  "interests": ["Event-Driven Architecture", "Cost Optimization", "serverless"],
  "intents": [
    { "kind": "issue", "text": "Cold starts on the ingest Lambda are too slow under load", "ref": "https://github.com/org/repo/issues/142" }
  ]
}
```

`"Event-Driven Architecture"` and `"Cost Optimization"` here are exact `reference/taxonomy.md`
"Areas of interest" tags -- the first mapped from a README line like "we're moving toward an
event-driven architecture to cut coupling between services," the second from "we're trying to
reduce our AWS bill." `"serverless"` is kept as free text because there's no "Serverless" entry in
the Areas of interest list (it's a *topic*, not an area of interest) -- forcing it onto an unrelated
tag would be a worse match than leaving it as text.

For a multi-repository profile, add one entry per repository to `repos` and use its `root` as the
`repo` value in every citation that belongs to it.

## Supporting components and mixed usage

A service entry may carry `"role": "supporting"` (the default is `"core"`). Use it for components the
product does not run on: deploy templates, example apps, CI-only tooling, and code the product
generates for users. Supporting services count for half in ranking, never satisfy the Fix and
Next-level stack-fit gate, and their names stay out of the free-text relevance. Without it, a
product whose templates deploy Lambda and API Gateway ranks as if it ran on them.

Always list the platform services you find, as `"role": "supporting"`: CloudWatch, VPC, S3, Route 53,
ACM, CDK, CloudFormation, KMS, Secrets Manager, Systems Manager and CloudTrail. Do not leave one out
because it is common: the profile is the record of what the repository uses, and two profiles of the
same repository should list the same ones. IAM and STS are never listed; if present they are ignored.
Nearly every AWS workload runs on them, so the ranking and the gates discount them rather than your
leaving them out: sharing one with a session says nothing about your stack. The stack-fit
gate ignores them whatever role you give, so a profile whose only services are platform services
has no stack to fit: list the services the product is actually built from.

Also mark as supporting: a service that is wired in but switched off (a WAF behind a false flag)
and a service used only at deploy time (Secrets Manager passing values between stacks). The
repository's own IaC tool (CDK, CloudFormation) is supporting, whether or not it also appears as a
pattern.

`genai-single-call` applies to any model API, not only Bedrock: Gemini, OpenAI, Anthropic, or
Bedrock InvokeModel and Converse.

A tool-free utility call inside an agentic app (a one-shot summarize or classify next to the agent
loop) is not a reason to hide the agent: tag both `agentic` and `genai-single-call`. The path is
then skipped as already there, which is the correct outcome.

An absence that holds for only some components ("not evident in the cited scope") should say which components lack it
and which have it; cite the ones you inspected.

## The explain lens

`lens: "explain"` answers "which introductory sessions would teach me what this code is built on?".
It needs no gap or path patterns; it works from the services and patterns you already recorded.

**Concepts.** Each core service and each pattern that is not a gap (`gap-*`) or `dead-code` is a
concept to explain. A supporting service counts at half weight. Platform services (CloudWatch, S3,
IAM and the rest of the platform list) are not concepts. Concepts are ranked by centrality, the
number of distinct files you cited for them, so cite the files that really use each one; a concept
you cite once ranks below one you cite in five places.

**Admission.** A session explains a concept only if it names the concept in its title, or
at least twice in its abstract outside an enumeration (three or more names in a row), and an abstract-only
match also needs the session to list the service or carry a matching tag. A tag or a listed service
alone never admits a session. Services match by catalog name and short form ("Amazon DynamoDB",
"DynamoDB", "ECS"). Patterns match through a curated phrase list: `serverless`, `event-driven`,
`api`, `multi-tenant`, `multi-account`, `iac-cdk`, `containers`, `ecs`, `eks`, `agentic`,
`genai-single-call`, `streaming`, `data-lake`. `agentic` and `genai-single-call` are so widespread
that only a title that says how to build or design them admits (for example "Building agents in
production"). A pattern with any other name cannot be matched and comes back in `uncovered`; prefer
the names above where they fit. A sponsored session, a feature-news or launch session ("What's new", "new features", "new instances"),
a modernization or migration session, a certification or exam session, a customer story ("How X
scaled Y", or an abstract that says "how a customer ..."), a game or exam-prep session and an "AWS
Partner:" bootcamp (attendance is restricted to AWS Partners) are never used to explain a concept.

**Selection.** Only level 100 and 200 sessions are listed. They are picked round-robin across the
concepts in centrality order, the best session per concept each round, so the top of the list covers
as many concepts as possible before any concept repeats. Ties prefer a session that lists the
service or has a matching tag, then an introduction-style title, then a Breakout session or Chalk
talk. Each candidate's `explainsConcept` reason names the concept, the phrase that matched and the
files in your profile that use it, so the file citations you record are what the user reads.

**`uncovered`.** The response always carries `uncovered`, `[]` when nothing is missing. Each entry is
`{ "concept", "reason" }` for a concept no introductory session is about. When a 300-level
session names the concept in its title, the reason names that session (a 300-level session that only
mentions the concept in its abstract is not named), so you can offer it while saying it is not an
introduction. Each entry has a `kind` (`service` or `pattern`) because a service and a pattern can
share a name. Tell the user which parts of their code the catalog has no introduction for instead of
padding the list with weaker sessions; an empty `candidates` with a full `uncovered` is a valid
answer (a codebase built on tools the conference does not cover).

## The all lens

`lens: "all"` (the default) answers "which sessions are about the technologies and architecture this code
is built on?". It works from the same concepts as the explain lens (core services, supporting ones at half
weight, and non-gap patterns; platform services are not concepts) and needs no gap or path patterns. It lists
sessions of any level and format, so it does not ask for an introduction.

**Admission.** A session is about a concept when its title names it, or its abstract names it at least twice
outside an enumeration of names, or once outside one when the session also lists the service or carries a
matching tag. A tag or a listed service alone never admits a session. A session matched only through
patterns (no service of yours among them) needs a pattern named in its title. `agentic` and
`genai-single-call` are too widespread to count on a bare title: alone, a title that names them admits a session only
if it also says how to build or design it ("Building ...", "Best practices for ...") or the session names one of your
services (even in a list, which admits it but adds no weight to it; outside a list the service counts as a second
concept). A profile whose only concepts are those two therefore gets a short list of such sessions, not every agent talk. Each entry of the
profile's `interests` is a concept too (centrality 1, nothing cited): a title that names it, or a topic or
area-of-interest tag equal to it, admits a session, and those rank after sessions about your evidenced concepts.
`intents` and shared wording are not used. An "AWS Partner:" bootcamp and a certification or exam session are
never returned.

**Demotion.** A sponsored session, a feature-news or launch session, a customer story (including a named company's migration or scaling told in the abstract, "Honeycomb spends ..."), a modernization or
migration session, a session made for an industry, a session titled about agents or generative AI when
your profile has no `agentic` or `genai-single-call` pattern, and a session whose title names a specific technology your
profile does not use (a catalog service such as AWS Fargate, or a common tool such as Terraform, Kafka, Kubernetes, Spark,
MicroVMs or OpenTelemetry; "ranked lower: about Terraform, which this code does not use") are returned after every other
session, except a comparison ("X vs Y", "from X to Y"), each
with a `demoted` reason, because an experienced reader may still want them.

**Order.** A title that names a concept comes before an abstract that only does; a session about your evidenced
concepts comes before one about only a stated interest; then the summed centrality of
the concepts (the distinct files you cited, so cite the files that really use each one), then the number of
concepts, then relevance to the whole profile. No concept is the main subject of more than three of the first ten
while four or more concepts have sessions; what that holds back follows the ten in order. Each candidate's
`why` names the concepts it was admitted for and quotes the sentence that says so.

## Supported evidence lenses

Fix is a curated starting vocabulary spanning the [six Well-Architected pillars](https://docs.aws.amazon.com/wellarchitected/latest/framework/the-pillars-of-the-framework.html).
The pillar names come from AWS; the pattern-to-session mappings below are our own guidance,
not a complete assessment or a claim that every repository has these gaps.

| Exact pattern | Pillar | Session signal examples |
| --- | --- | --- |
| `gap-no-dlq` | Reliability | Dead-letter queues, DLQ, redrive |
| `gap-no-alarms` | Operational Excellence | CloudWatch alarms, alarms on or for a metric, alerting strategy, on-call, paging, SLO/SLI alerting (bare "alerts", "alarms" and "observability" do not count) |
| `gap-no-tests` | Operational Excellence | Unit, integration, automated, end-to-end tests; test-driven, test coverage, testing infrastructure |
| `gap-broad-iam` | Security | Least privilege, IAM policy scope |
| `gap-no-load-tests` | Performance Efficiency | Load, performance, stress testing |
| `gap-no-cost-monitoring` | Cost Optimization | Cost monitoring, allocation, anomalies, AWS Budgets |
| `gap-no-resource-rightsizing` | Sustainability | Resource rightsizing |
| `gap-no-tracing` | Operational Excellence | Distributed or end-to-end tracing, AWS X-Ray, OpenTelemetry (bare "tracing" does not count) |
| `gap-no-ci` | Operational Excellence | CI/CD, continuous integration, delivery or deployment, release and delivery pipelines (bare "pipelines" and deployment strategies do not count) |
| `gap-no-graviton` | Sustainability | Graviton, arm64 |

`gap-no-alarms` means no alarm that notifies a person. An alarm that only drives automation
(scaling, rollback) does not count as one, so an application with only those still has the gap.

Use “not evident in the cited scope” for an absence. Cite the nearest relevant resource or
workflow and explain what you inspected in `note`; never infer a system-wide absence from one
file. Broad IAM is a positive scope concern: cite the permissive statement. An open GitHub issue
is intent, not proof of an absence; relate it to independently cited evidence in the presentation.

Next-level recognizes exactly these source patterns (case-insensitively):

| Source pattern → destination | Gain to explore | Cost to discuss |
| --- | --- | --- |
| `serverless` → containers | runtime control | operational ownership |
| `ecs` → EKS | Kubernetes portability and ecosystem | cluster/platform complexity |
| `genai-single-call` → agentic | multi-step tool use | latency, cost, evaluation, control requirements |

These are exploration options, not automatic upgrades. Cite real architecture usage: an SDK
import, a Bedrock service entry, or an interest in Kubernetes alone cannot establish a source
pattern. Mixed architectures may have both source and destination patterns. A relevant issue
helps explain why the option matters, but is not authorization to migrate.

Each lens requires an exact supported source name and an actual remediation/destination signal in
the session's own title or abstract. Unknown names remain valid profile data but activate no rule;
no active rule or no matching signal returns zero candidates. Generic source services, interests,
issue prose and catalog tags never admit a session on their own. Strength comes from the text: the
phrase in the title is 3, at least twice in the abstract 2, once 1 (a Fix abstract that describes it
as missing, without, lacking, absent or forgotten, such as "missing dead-letter queues", adds 1, and
so does a matching tag, topic or service; a bare "no" is not a cue); admission needs 2, so a phrase
named once in passing, such as a dead-letter queue as one scenario among many, is not enough. The
`genai-single-call` path needs 2 from the text alone, so a tag never lifts a single "agentic"
mention. A phrase that sits inside an enumeration of three or more names ("Lambda, EC2, ECS and
EKS") counts for nothing, whatever it names. Each rule adds `20 + 10 x strength` points once, with deduplicated source
citations in `profileEvidence`; `evidence` remains the matched catalog signal. Rules are ranked
separately (strength, then profile relevance) and interleaved, and `lensRules` names each admitting
rule. Titles and abstracts match contiguous whole phrases. Neither lens restricts level or boosts
format.

Two more gates apply to both lenses. Stack fit: a Fix session must list or name at least two of
your core services, or one core service that fewer than 3% of catalog sessions list; a Next-level
session needs one. Supporting and platform services never count. A session whose title names
`gap-broad-iam` or `gap-no-cost-monitoring`'s phrase (or whose abstract does so twice) and that
lists that rule's remedy services (IAM and IAM Access Analyzer; AWS Billing and Cost Management,
which covers Budgets and Cost Explorer) needs fewer of your services: each remedy service it lists
counts as one of the two, so IAM alone, which is on almost every security talk, is not enough, but
IAM with Access Analyzer, or IAM with one of your core services, is. A session about the fix is not
about the stack the gap sits in. The newer gaps use the same path with their own remedy services:
`gap-no-tracing` (AWS Distro for OpenTelemetry), `gap-no-ci` (CodePipeline, CodeBuild, CodeDeploy)
and `gap-no-graviton` (EC2 - Graviton). The three newer gaps also skip a session tagged Agentic AI or Generative AI unless your profile has an
`agentic` or `genai-single-call` pattern: a talk about securing or observing agents is not about the
gap in an ordinary application. A `gap-no-tests` session about testing infrastructure code with a
tool your profile lists (CDK, even as a supporting service) fits the same way. A profile with no core service (none listed, or
every one marked supporting) has no stack to fit, so both lenses admit nothing and `skippedRules`
names each activated rule with "profile has no core services to check stack fit": list the
product's real services before expecting Fix or Next-level results. Direction and source: a Next-level session must
mention the source side in its own title or abstract, outside an enumeration of three or more names
(Lambda, serverless or functions; ECS; for a single call: single-shot or basic prompting, a
baseline chatbot or RAG app, InvokeModel or Converse, or a move from a GenAI baseline to agents; a
listed service tag or Bedrock and prompts alone do not count, but a session about agents built on
two of your other core services does), and a session about the reverse move (containers to Lambda
or MicroVMs, Kubernetes or EKS to serverless or AgentCore, EKS to ECS) is excluded. A path whose destination pattern the profile already has (`containers`, `eks`,
`agentic`) is skipped and reported in `skippedRules`.

Fix picks are leads, not verdicts. Even with these gates a session can name your services and a gap
phrase in passing, so read each pick's abstract before presenting it.

See `workflow.md` for an executable synthetic profile covering every rule.
