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
- **The README**: useful for the story and for open issues, but never as the source of truth for
  what services are actually used -- see "prose" below.

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

`snippet` and `note` are optional but cheap and valuable -- a short snippet saves a reviewer a trip
to the file, and a note is the place to say *why* the line counts as evidence when it isn't
obvious from the snippet alone.

## What doesn't count as evidence

- **Commented-out infrastructure.** A `// new SnsClient(...)` left behind after a migration is not
  a service the repository uses today. Skip it, or note the absence if it's relevant (see below).
- **Prose mentions.** A README that says "we plan to add caching with ElastiCache" or an
  architecture doc that describes a target state is not evidence the code does that today. A
  service named only in a comment, docstring, or description string is the same case -- it has to
  be called, provisioned, or declared as infrastructure, not just talked about.

## Distinguish SDK generations

For JavaScript/TypeScript repositories, `aws-sdk` (v2, a single monolithic package) and
`@aws-sdk/client-*` (v3, one package per service) are different signals, not interchangeable
spellings of "uses the AWS SDK." Note which generation a repository is on when it's relevant --
it can matter for how current the codebase is, which the Fix lens (a later phase) will use.

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
exact-match reason.

## Skip anything that isn't the project's own code

Dependency directories (`node_modules`, `vendor`, `.venv`, `site-packages`), build output (`dist`,
`build`, `target`), and tool caches are not the repository being profiled -- a manifest or an SDK
import found inside one of these belongs to a dependency, not to this project, and citing it would
misattribute someone else's stack as this repository's own.

## Say what's missing, too

Note real absences you notice while reading -- no test suite, no alarms or dashboards on the
infrastructure you found, no dead-letter queues on an async pipeline, IAM policies that are broad
rather than scoped to what the code actually needs. These aren't services or patterns in the
`services`/`patterns` sense (they have nothing to cite a positive line for), so record them as
`patterns` entries whose `note` says what's absent, with evidence pointing at the file where you'd
expect to find the missing thing and didn't (a stack definition with no alarm construct, a queue
declaration with no redrive policy). Phase 1 doesn't act on this itself, but a later "Fix" lens
will, and this is where that signal has to come from.

## Fold in open issues

If you have access to the repository's open GitHub issues, fold ones that describe a real technical
problem or goal into `intents`:

```json
{ "kind": "issue", "text": "Cold starts on the ingest Lambda are too slow under load", "ref": "https://github.com/org/repo/issues/142" }
```

Use `"goal"` instead of `"issue"` for something you learned isn't tracked as an issue at all -- a
stated roadmap item from the README, or something the user told you directly. `ref` is optional and
is the right place for an issue URL or number; leave it off for a goal with no such reference.

## The profile shape

`validate_profile` and `match_sessions` both take this object as their `profile` argument
(`schemaVersion` is currently always `1`; `services` and `patterns` are required arrays -- write
them as `[]` when there's genuinely nothing to report, never omit them):

```json
{
  "schemaVersion": 1,
  "repos": [
    { "root": "api", "languages": ["typescript"], "summary": "Order-processing API on Lambda." }
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
      "note": "Order creation publishes to EventBridge; no DLQ on the consumer queue.",
      "evidence": [
        { "repo": "api", "file": "infra/stack.ts", "line": 44 }
      ]
    }
  ],
  "interests": ["serverless", "cost optimization"],
  "intents": [
    { "kind": "issue", "text": "Cold starts on the ingest Lambda are too slow under load", "ref": "https://github.com/org/repo/issues/142" }
  ]
}
```

For a multi-repository profile, add one entry per repository to `repos` and use its `root` as the
`repo` value in every citation that belongs to it.
