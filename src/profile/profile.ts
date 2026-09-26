import { z } from "zod";
import type { ServiceAliasIndex } from "../catalog/service-aliases.js";
import { normalizeServiceKey } from "./service-keys.js";

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
 * Validates a raw profile (see `parseProfile`) and resolves every service's `name` against the
 * catalog: `normalizeServiceKey` first (so "dynamodb", "Amazon DynamoDB" and
 * "@aws-sdk/client-dynamodb" all reach the same lookup), then `serviceAliasIndex.resolve`. A
 * service the catalog has no counterpart for is never dropped -- it stays in `services` with
 * `catalogName: null` and is also named in `unresolvedServices`, the same "not found is a normal
 * outcome" treatment the rest of this codebase gives an unresolvable service key.
 */
export function resolveProfile(input: unknown, serviceAliasIndex: ServiceAliasIndex): ResolvedProfile {
  const profile = parseProfile(input);

  const unresolvedServices: string[] = [];
  const services: ResolvedService[] = profile.services.map((service) => {
    const catalogName = serviceAliasIndex.resolve(normalizeServiceKey(service.name));
    if (catalogName === null) {
      unresolvedServices.push(service.name);
    }
    return { ...service, catalogName };
  });

  return { ...profile, services, unresolvedServices };
}
