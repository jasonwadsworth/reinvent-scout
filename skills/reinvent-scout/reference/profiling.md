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
  counts as a service, exactly like Terraform would. A dedicated (customer-managed) key the code actually uses
  to sign or encrypt something is a real choice and counts; only the default key, present whether
  or not anyone thought about it, doesn't. Listing the excluded items as services would swamp a
  profile with noise that's true of almost any AWS repository and therefore matches almost nothing
  distinctive about *this* one. If IAM policies are unusually broad rather than scoped to what the
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

A pattern's `name` is usually a short, kebab-case, architectural noun -- reused across
repositories with the same shape, not a one-off phrase invented per repository (`"event driven"`
and `"event-driven-architecture"` should both just be `event-driven`). A starting vocabulary,
extend it when a repository's shape genuinely doesn't fit any of these:

`serverless`, `event-driven`, `containers`, `ecs`, `eks`, `api`, `streaming`, `iac-cdk`, `iac-terraform`,
`iac-cloudformation`, `genai-single-call`, `agentic`, `multi-account`.

The one exception: when a pattern genuinely corresponds to one of `reference/taxonomy.md`'s
"Topics" (not just a loose thematic resemblance -- the pattern *is* that topic), name it with that
topic's exact spelling instead of inventing a kebab-case version of it: `"Developer Tools"`,
`"Security & Identity"`, not `developer-tools` or `security-identity`. This isn't cosmetic:
`match_sessions` compares every pattern name against a session's own topics case-insensitively, but
not hyphen- or punctuation-insensitively, so a kebab-cased rendering of a multi-word topic ("exact"
here means spelling, not case) never actually matches the real topic and silently loses that
reason. A single-word topic like "Serverless" still reads fine in ordinary kebab-case (`serverless`
already matches it case-insensitively), which is why the general vocabulary above stays kebab-case
by default -- this exception only bites for a multi-word topic.

A gap (see "Say what's missing, too" below) is always kebab-case with a `gap-` prefix, never a
topic spelling, so it's never confused with a positive, present-tense pattern: `gap-no-dlq`,
`gap-no-alarms`, `gap-broad-iam`, `gap-no-tests`, `gap-no-tracing`. Code nothing reaches is `dead-code` (no `gap-`
prefix -- it isn't an absence, it's a presence that doesn't count).

## Say what's missing, too

Note real absences you notice while reading -- no test suite, no alarm that notifies a person on the
infrastructure you found, no dead-letter queues on an async pipeline, IAM policies that are broad
rather than scoped to what the code actually needs. These aren't services in the `services` sense
(they have nothing to cite a positive line for), so record them as `patterns` entries named with the
`gap-` prefix (see "Naming patterns" above). The citation rule is the same as for anything else,
applied to the nearest relevant line: cite the resource that *lacks* the thing -- the queue
declaration with no redrive policy, the stack with no alarm construct, the IAM statement with a
wildcard resource -- and explain what's absent and why it matters in `note`; there's no line of
code for an absence itself to point at. The Fix lens consumes these agent-authored judgments;
it does not scan repositories or infer an absence from missing service entries.

Record `gap-no-load-tests` and `gap-no-cost-monitoring` only when the repository deploys production
infrastructure (IaC with a real environment, or a pipeline to one) and has none of the named
practices; otherwise leave them out, since they are true of almost any repository. A gap may apply
to a clearly cited part of the system: record it and say which part in the `note`. A wildcard
permission narrowed by a condition or session policy is still recordable as `gap-broad-iam`, with
the narrowing mentioned in the `note`.

## What counts as each newer gap

Six more gaps have a fixed definition, so two people profiling the same repository record the same
ones. Each needs a code citation of the thing that *lacks* the practice. A gap that is only partly
true is still recordable: cite the part that lacks it and say which part in the `note`. A practice
that is wired in but switched off (`Disabled`, `false`, a retention of 0, an association that
exists only in a comment) is the gap, and you cite the line that switches it off. A practice that
is present but weak (a rule in count-only mode, a cache with a one-second lifetime) is not this
gap.

- **`gap-no-tracing`** (Operational Excellence). The repository deploys a request path that crosses
  two or more components (an API to a function to a queue or table, a service calling another
  service) and no tracing is enabled anywhere on it: no X-Ray active tracing (`tracing: Active`,
  `TracingConfig`), no OpenTelemetry SDK, collector or Lambda layer, no Powertools Tracer. Cite the
  function or service declaration. Logs and metrics are not tracing. A single function that calls
  nothing else is not this gap.
- **`gap-no-ci`** (Operational Excellence). The repository deploys infrastructure or services to a
  real environment and holds no pipeline that builds or tests it on change: no
  `.github/workflows`, `buildspec`, CodePipeline or CDK Pipelines stack, `.gitlab-ci.yml`,
  CircleCI or Jenkins file. Cite the IaC entry point. A pipeline that only runs tests still counts
  as CI, so it is not this gap. If the pipeline could live in a different repository, say so in the
  `note` and record it only when the repository is the deployable unit.
- **`gap-no-backups`** (Reliability). A store that holds the system of record has no backup: a
  DynamoDB table without point-in-time recovery (`pointInTimeRecovery` unset or false) and covered by
  no AWS Backup plan, an RDS or Aurora instance with `backupRetention` of 0, or a stateful store with
  neither a backup plan nor a snapshot policy. Cite the table or instance. Tables that only hold
  data you can rebuild (a cache, a derived index) are not this gap; say in the `note` why the store
  is the system of record.
- **`gap-no-waf`** (Security). An internet-facing HTTP entry point has no web ACL: a CloudFront
  distribution, a public load balancer, a REST API or AppSync API with no `WebACL` and no
  association (`CfnWebACL`, `WebAclAssociation`, `webAclId`, `aws_wafv2_web_acl_association`)
  anywhere in the repository. Cite the entry point. API Gateway HTTP APIs cannot take a web ACL, so
  an HTTP API is this gap only when it is fronted by a CloudFront distribution that has none. A
  private API or an internal load balancer is not this gap.
- **`gap-no-caching`** (Performance Efficiency). A public GET route whose response is the same for
  every caller (a catalog, a listing, configuration) reads its data store or an upstream API on
  every request, and nothing on the path caches it: no CloudFront distribution, no API Gateway
  stage cache, no ElastiCache or DAX, no `Cache-Control` response header, no memoization in the
  function. Cite the handler line that does the read. A route whose response depends on the caller,
  a write path and an admin route are not this gap.
- **`gap-no-graviton`** (Sustainability). The repository deploys production compute and every
  resource in the cited scope runs on x86: Lambda functions with no `architecture` (the default
  is x86_64), ECS task definitions with `X86_64` or no `runtimePlatform`, EC2 instance types with no
  Graviton family (the ones ending in `g`, such as `m7g`). Cite the function or task declaration.
  A resource pinned to x86 by a dependency you can see (an x86-only native layer, an image built
  `--platform=linux/amd64`) is not this gap; mention it in the `note` of the gap you do record, if
  any.

## Interests

`interests` comes from the repository's own stated goals -- what the README says the team is
working toward -- or, when you're running interactively, from asking the attendee one short
question about what they're hoping to get out of the conference. Never invent an interest purely
from the architecture you found; an interest is what someone *wants*, not a restatement of a
service or pattern you already recorded elsewhere.

For each interest, look for the nearest match in `reference/taxonomy.md`'s "Areas of interest" list
and spell it exactly as the catalog does -- `"Event-Driven Architecture"`, `"Kubernetes"`, `"Cost
Optimization"`, not a paraphrase of any of them. This matters mechanically, not just stylistically:
`match_sessions` only produces an `areaOfInterest` reason for an exact tag match; anything else in
`interests` still counts toward the free-text score, but only an exact tag earns that specific,
strongest reason. "Exact" here means spelling and punctuation, not case -- the comparison itself is
case-insensitive (`"kubernetes"` and `"Kubernetes"` match equally well), so there's no need to worry
about matching the catalog's own capitalization exactly, only its wording. Keep an interest as free
text only when nothing in the real list is actually a good fit -- don't force a weak match just to
get the stronger reason type.

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
      "name": "Security & Identity",
      "note": "Every API Gateway route is fronted by a Lambda request authorizer that checks the caller's IAM-scoped role before the handler runs.",
      "evidence": [
        { "repo": "api", "file": "infra/stack.ts", "line": 20, "snippet": "new apigateway.RequestAuthorizer(this, \"OrderAuthorizer\")" }
      ]
    },
    {
      "name": "gap-no-dlq",
      "note": "The order-created consumer queue has no dead-letter queue or redrive policy, so a repeatedly-failing message is retried forever instead of being set aside for inspection.",
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

`"Security & Identity"` is a pattern, not an interest, but follows the same "exact spelling" rule
from "Naming patterns" above for the opposite reason `"serverless"` doesn't: it genuinely *is* one
of `reference/taxonomy.md`'s "Topics", so it's spelled exactly as that topic is, capital letters
and ampersand included, rather than invented as `security-identity` -- the kebab-case rendering
would silently fail to match the real topic at all.

For a multi-repository profile, add one entry per repository to `repos` and use its `root` as the
`repo` value in every citation that belongs to it.

## Supporting components and mixed usage

A service entry may carry `"role": "supporting"` (the default is `"core"`). Use it for components the
product does not run on: deploy templates, example apps, CI-only tooling, and code the product
generates for users. Supporting services count for half in ranking, never satisfy the Fix and
Next-level stack-fit gate, and their names stay out of the free-text relevance. Without it, a
product whose templates deploy Lambda and API Gateway ranks as if it ran on them.

Mark platform services `"role": "supporting"` by default: CloudWatch, VPC, S3, Route 53, ACM, CDK,
CloudFormation, KMS, Secrets Manager, Systems Manager and CloudTrail. IAM and STS are never listed; if
present they are ignored. Nearly every AWS workload runs on them, so sharing one with a session says nothing about your stack. The stack-fit
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

`lens: "explain"` is not evidence-driven. It restricts to level 100 and 200 sessions and favors
lecture formats (Breakout session, Chalk talk) so a foundational session can be recommended for a
concept in the profile. It needs no gap or path patterns.

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
| `gap-no-ci` | Operational Excellence | CI/CD, continuous integration, delivery or deployment, deployment and release pipelines (bare "pipelines" does not count) |
| `gap-no-backups` | Reliability | AWS Backup, point-in-time recovery, backup plans, vaults or policies, immutable and cross-Region backups (bare "backup" does not count) |
| `gap-no-waf` | Security | AWS WAF, web application firewalls |
| `gap-no-caching` | Performance Efficiency | Caching layers and strategies, edge, in-memory, application, read or response caching, cache hits (semantic and prompt caching do not count) |
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
`gap-no-tracing` (AWS Distro for OpenTelemetry), `gap-no-ci` (CodePipeline, CodeBuild, CodeDeploy),
`gap-no-backups` (AWS Backup), `gap-no-waf` (AWS WAF), `gap-no-caching` (ElastiCache, CloudFront)
and `gap-no-graviton` (EC2 - Graviton). A `gap-no-tests` session about testing infrastructure code with a
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
