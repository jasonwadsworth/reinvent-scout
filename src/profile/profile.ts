import { z } from "zod";
import type { ServiceAliasIndex } from "../catalog/service-aliases.js";
import { normalizeServiceKey, stripKnownAffix } from "../catalog/service-keys.js";

/** The only schema version this build understands. Bumped whenever the shape changes
 * incompatibly; an agent (or a hand-written profile) targeting an older or newer version is
 * refused outright rather than silently misinterpreted -- there is no meaningful way to
 * "tolerate" a schema mismatch for a document a human or an LLM authored directly, unlike the
 * synced catalog, which has its own independent staleness/rebuild story. */
const CURRENT_SCHEMA_VERSION = 1;

const EvidenceSchema = z.object({
  /** Which of `repos[].root` this citation belongs to, for a multi-repo profile. */
  repo: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  snippet: z.string().optional(),
  note: z.string().optional(),
});

const RepoSchema = z.object({
  root: z.string().min(1),
  languages: z.array(z.string()),
  summary: z.string().optional(),
});

const ServiceSchema = z.object({
  /** However the agent (or a person) spelled it -- a short key, a full catalog display name, an
   * SDK package name, anything. Resolved against the catalog by `resolveProfile`. */
  name: z.string().min(1),
  usage: z.string().optional(),
  /** `supporting` marks a component the product does not run on (deploy templates, example apps,
   * CI-only tooling, code it generates for users); it counts for half in matching. Absent means
   * core. Optional, so the schema version stays 1. */
  role: z.enum(["core", "supporting"]).optional(),
  evidence: z.array(EvidenceSchema),
});

const PatternSchema = z.object({
  name: z.string().min(1),
  note: z.string().optional(),
  evidence: z.array(EvidenceSchema),
});

const IntentSchema = z.object({
  kind: z.enum(["issue", "goal"]),
  text: z.string().min(1),
  ref: z.string().optional(),
});

/**
 * The unresolved shape an agent (or a person) writes directly. `services` and `patterns` are
 * required arrays -- explicitly empty when there's nothing to report, never omitted -- so a
 * profile that forgot a section looks different from one that genuinely found nothing.
 *
 * Evidence is required on every service and pattern (checked below, not by a bare array length
 * on the field itself, so the error can name which entry is missing it): an unevidenced claim
 * is the one thing this schema refuses no matter how it's phrased, since the whole reason the
 * profile is agent-authored rather than deterministic is that a human reviewing a match's reasons
 * needs to be able to check them against real lines in the repo.
 */
const RawProfileSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    repos: z.array(RepoSchema).min(1),
    services: z.array(ServiceSchema),
    patterns: z.array(PatternSchema),
    interests: z.array(z.string()).optional(),
    intents: z.array(IntentSchema).optional(),
  })
  .superRefine((profile, ctx) => {
    profile.services.forEach((service, index) => {
      if (service.evidence.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["services", index, "evidence"],
          message: `Service "${service.name}" has no evidence; at least one citation is required.`,
        });
      }
    });
    profile.patterns.forEach((pattern, index) => {
      if (pattern.evidence.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["patterns", index, "evidence"],
          message: `Pattern "${pattern.name}" has no evidence; at least one citation is required.`,
        });
      }
    });
  });

export type Evidence = z.infer<typeof EvidenceSchema>;
export type Repo = z.infer<typeof RepoSchema>;
export type Service = z.infer<typeof ServiceSchema>;
export type Pattern = z.infer<typeof PatternSchema>;
export type Intent = z.infer<typeof IntentSchema>;
export type Profile = z.infer<typeof RawProfileSchema>;

export interface ResolvedService extends Service {
  /** The catalog's own display name for this service, or `null` when the catalog has no
   * counterpart for it -- a normal, reportable outcome (SNS, today), not an error. */
  catalogName: string | null;
}

export interface ResolvedProfile extends Omit<Profile, "services"> {
  services: ResolvedService[];
  /** Every service `name` that didn't resolve to a catalog display name, in profile order --
   * the same information `services[].catalogName === null` carries, surfaced as a flat list so a
   * caller (the CLI, an MCP tool) can report it as a single warning without re-scanning
   * `services`. */
  unresolvedServices: string[];
}

/**
 * Validates a raw, agent-authored profile against the schema, throwing `z.ZodError` (with a
 * message naming the offending entry, e.g. a service or pattern with no evidence) when it's
 * invalid. Does not resolve service names against the catalog -- see `resolveProfile` for that;
 * this function alone is what proves the schema round-trips a profile without silently mutating
 * or dropping anything.
 */
export function parseProfile(input: unknown): Profile {
  return RawProfileSchema.parse(input);
}

/**
 * Resolves one raw service name against the catalog:
 *
 * 1. Strip a known wrapper affix (`service-keys.ts`'s `stripKnownAffix`) -- an SDK package name,
 *    module path, or Terraform's own `aws_` resource-type prefix.
 * 2. If no affix matched, resolve the name as a single candidate and stop there -- see below for
 *    why segment shortening only applies once a known code-shape affix has actually been found.
 * 3. If an affix *did* match, the remainder may still be a Terraform-style compound
 *    (`aws_dynamodb_table` strips to `dynamodb_table`, `aws_elasticache_serverless_cache` strips
 *    to `elasticache_serverless_cache`) that needs its own resource-type suffix separated from
 *    the service. Split it into segments on `-`/`_` (never mid-token: "s3_batch_operations"
 *    splits into ["s3", "batch", "operations"], never something that cuts a word in half) and try
 *    joining the first *N* segments, from all of them down to just the first, resolving each
 *    candidate through `normalizeServiceKey` then `serviceAliasIndex.resolve`. The first (longest)
 *    match wins -- when the catalog carries both a specific and a more general entry for the same
 *    prefix (`"Amazon ElastiCache Serverless"` alongside `"Amazon ElastiCache"`), the specific one
 *    is what such a repository is actually calling.
 *
 * Segment shortening is gated on an affix having actually been stripped, rather than applying to
 * every name unconditionally, because it is a recovery strategy for a name that arrived in a
 * known code shape -- not a general prefix match on arbitrary text. Without that gate, an
 * ordinary hyphenated name that happens to start with a service name would be silently
 * misresolved: `"lambda-labs-gpu"` (a GPU hosting product) would shorten down to `"lambda"` and
 * wrongly resolve to AWS Lambda, and `"athena-health"` (a healthcare company) would do the same
 * for Amazon Athena. Confirmed against the real catalog before this gate existed, and confirmed
 * gone after.
 *
 * Returns `null` when nothing resolves -- a genuinely unresolvable name (`sns`, or `aws_sns_topic`
 * after stripping) is never rescued into something adjacent just because shortening ran out of
 * segments to try.
 */
export function resolveServiceName(rawName: string, serviceAliasIndex: ServiceAliasIndex): string | null {
  const stripped = stripKnownAffix(rawName);
  const affixWasStripped = stripped !== rawName;

  if (!affixWasStripped) {
    return serviceAliasIndex.resolve(normalizeServiceKey(rawName));
  }

  const segments = stripped.split(/[-_]+/).filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return null;
  }

  for (let length = segments.length; length >= 1; length--) {
    const candidate = segments.slice(0, length).join("_");
    const resolved = serviceAliasIndex.resolve(normalizeServiceKey(candidate));
    if (resolved !== null) {
      return resolved;
    }
  }
  return null;
}

/**
 * Validates a raw profile (see `parseProfile`) and resolves every service's `name` against the
 * catalog via `resolveServiceName`. A service the catalog has no counterpart for is never
 * dropped -- it stays in `services` with `catalogName: null` and is also named in
 * `unresolvedServices`, the same "not found is a normal outcome" treatment the rest of this
 * codebase gives an unresolvable service key.
 */
export function resolveProfile(input: unknown, serviceAliasIndex: ServiceAliasIndex): ResolvedProfile {
  const profile = parseProfile(input);

  const unresolvedServices: string[] = [];
  const services: ResolvedService[] = profile.services.map((service) => {
    const catalogName = resolveServiceName(service.name, serviceAliasIndex);
    if (catalogName === null) {
      unresolvedServices.push(service.name);
    }
    return { ...service, catalogName };
  });

  return { ...profile, services, unresolvedServices };
}
