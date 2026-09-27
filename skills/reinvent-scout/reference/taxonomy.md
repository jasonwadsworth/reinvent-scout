# Catalog taxonomy

The re:Invent session catalog tags each session with a handful of controlled vocabularies. This is
what they look like today and how the profile's own vocabulary lines up with them. Topic and role
matching in `match_sessions` is case-insensitive, so exact casing here is a convenience, not a
requirement -- but matching the real spelling makes a profile's `interests` and `patterns.name`
entries more likely to line up with a session's own tags at all.

## Session types

The `type` a session carries (surfaced as `type` on a `match_sessions` candidate and on
`catalog show`):

- Bootcamp
- Breakout session
- Builders' session
- Chalk talk
- Code talk
- Exam prep
- Gamified learning
- Lab
- Lightning talk
- Workshop

The Explain lens (see `reference/workflow.md`) favors Breakout sessions and Chalk talks -- formats
built for explaining a concept -- over a Workshop or Lab, which assume more hands-on context.

## Levels

The `level` string's leading number is what `levelBand` (an integer) is parsed from -- a session
with no level on record has a `null` `levelBand`, treated the same as "doesn't match" by any
level-restricting lens or search:

- 100 - Foundational
- 200 - Intermediate
- 300 - Advanced
- 400 - Expert
- 500 - Distinguished

## Topics

Broad subject areas. This is the field a `patterns` entry's `name` most naturally lines up with
(e.g. a repository built around event-driven Lambda functions might list a `patterns` entry named
`"serverless"`, which reads naturally against the catalog's own "Serverless" topic):

- Analytics
- Application Integration
- Architecture
- Artificial Intelligence
- Business Agents
- Cloud Operations
- Compute
- Containers
- Databases
- Hybrid Cloud & Multicloud
- Networking & Content Delivery
- Security & Identity
- Serverless

## Roles

The audience a session is aimed at:

- Academic / Researcher
- Advisor / Consultant
- Business Executive
- Cloud Security Specialist
- Data Engineer
- Data Scientist
- DevOps Engineer
- Developer / Engineer
- IT Executive
- IT Professional / Technical Manager
- Solution / Systems Architect

## Areas of interest

A finer-grained tag than topic, closest to what a profile's own `interests` field should draw from:

- Agentic AI
- Automation
- Cost Optimization
- DevOps
- Digital Sovereignty
- Disaster Response & Recovery
- Event-Driven Architecture
- Generative AI
- Global Infrastructure
- Governance, Risk & Compliance
- Innovation & Transformation
- Machine Learning
- Management & Governance
- Monitoring & Observability
- Resilience
- Responsible AI
- Threat Intelligence
- Training & Certification
- Well-Architected Framework

## Features

Format tags, mostly informational rather than something a profile matches against directly:

- AWS Partners
- Community-led
- Discussion
- Hands-on
- Lecture-style

## Service names and how a profile's spelling resolves

The catalog's own `services` field always carries the full display name ("Amazon DynamoDB", "AWS
Step Functions") -- see `reference/profiling.md`'s "Naming services" section for how to write a
service name in a profile and what spellings the CLI resolves automatically. In short: prefer the
display name; a short key, an SDK package name (`@aws-sdk/client-dynamodb`, `boto3.client("s3")`),
or a Terraform resource name (`aws_dynamodb_table`) all resolve too, and a name that doesn't
resolve against the currently-synced catalog is reported in `unresolvedServices` rather than
dropped or rejected.
