import type { ServiceAliasIndex } from "../../catalog/service-aliases.js";
import type { DetectableFile } from "../detectable-file.js";
import { normalizeServiceKey } from "../service-keys.js";
import { extensionOf, isInsideSkippedDirectory } from "./paths.js";

export type { DetectableFile } from "../detectable-file.js";

export interface TerraformEvidence {
  file: string;
  /** 1-indexed. */
  line: number;
  snippet: string;
}

export interface DetectedTerraformService {
  key: string;
  evidence: TerraformEvidence[];
}

export interface TerraformDetectionResult {
  /** Every AWS resource type found, sorted by key for a deterministic result. */
  services: DetectedTerraformService[];
  /** Evidence this repository uses Terraform against AWS at all -- populated whenever any `.tf`
   * file declares `provider "aws"`, independent of which resource types were actually declared
   * (a module might declare the provider and be entirely composed of child modules with no
   * resource block of its own). */
  iacEvidence: TerraformEvidence[];
}

const MAX_EVIDENCE_PER_KEY = 3;

/**
 * A handful of real terraform-provider-aws resource-type prefixes that derive from no catalog
 * service name at all, so `ServiceAliasIndex.resolve` alone can never recognize them -- kept as
 * small, explicit, tested-as-necessary entries rather than a rule (see
 * tests/profile/detectors/terraform.test.ts's "each override is genuinely unreachable by
 * derivation"). Maps prefix -> the *key* to emit (further normalized below), not a catalog name:
 * this is the same key -> key shape as `service-keys.ts`'s `KEY_NORMALIZATION_OVERRIDES`, for the
 * same reason -- the catalog doesn't need to have heard of the exact spelling for a detector to
 * still report the parent service.
 */
export const TERRAFORM_PREFIX_OVERRIDES: Readonly<Record<string, string>> = {
  // Terraform's Bedrock Agent resources use a compound "bedrockagent" prefix with no separator.
  // The catalog has only "Amazon Bedrock", not a distinct "Bedrock Agent" entry, so this prefix
  // derives from nothing -- collapsed to the parent service.
  bedrockagent: "bedrock",
  // Terraform's API Gateway v2 (HTTP APIs / WebSocket APIs) resources use a compound
  // "apigatewayv2" prefix. The catalog has only "Amazon API Gateway", with no "v2" variant, so
  // this prefix derives from nothing either -- collapsed to the parent service.
  apigatewayv2: "apigateway",
};

/** A resource declaration: `resource "aws_dynamodb_table" "orders" { ... }`. Only the type
 * string is needed -- the resource's own local name is irrelevant to service detection. Anchored
 * to the start of the line (after only leading whitespace), so a commented-out resource or one
 * merely mentioned elsewhere on a line -- `# resource "aws_sqs_queue" "old" {}`, a trailing
 * comment citing an old resource -- is never mistaken for a real declaration, the same lesson
 * `detectors/cloudformation.ts` learned about a `Type:` line. */
const RESOURCE_DECLARATION_PATTERN = /^\s*resource\s+"(?<type>[a-z0-9_]+)"\s+"[^"]+"/;

/** A provider block naming `"aws"` specifically -- the IaC-against-AWS signal, independent of
 * any particular resource type. */
const AWS_PROVIDER_PATTERN = /^\s*provider\s+"aws"/;

/**
 * Resolves a Terraform resource type's service prefix by longest-prefix match of its
 * underscore-separated segments against the catalog's own alias derivation
 * (`serviceAliasIndex.resolve`) -- not a hand-written list of known services, which would rot as
 * AWS ships new services and, per the plan's own worked example, must stop at the *longest*
 * candidate a real service actually exists for (`aws_elasticache_serverless_cache` resolves via
 * "elasticache_serverless" -- Amazon ElastiCache Serverless, a real, more specific catalog entry
 * -- rather than the shorter "elasticache", since a catalog-derived set can recognize both and the
 * more specific one is what the repository is actually calling). Falls back to
 * `TERRAFORM_PREFIX_OVERRIDES` for the handful of real prefixes that derive from no catalog name
 * at all.
 */
function extractServiceKey(resourceType: string, serviceAliasIndex: ServiceAliasIndex): string | null {
  if (!resourceType.startsWith("aws_")) {
    return null;
  }
  const segments = resourceType.slice("aws_".length).split("_");
  for (let length = segments.length; length >= 1; length--) {
    const candidate = segments.slice(0, length).join("_");
    if (serviceAliasIndex.resolve(candidate) !== null) {
      return candidate;
    }
    const overridden = TERRAFORM_PREFIX_OVERRIDES[candidate];
    if (overridden !== undefined) {
      return overridden;
    }
  }
  return null;
}

/**
 * Detects AWS resource usage from Terraform `.tf` files: `resource "aws_<service>_<rest>" "..."
 * { ... }` declarations, resolved to a service key by longest-prefix match against the catalog's
 * own alias derivation, passed in as `serviceAliasIndex` (built once per run from the synced
 * catalog, the same way `catalog/service-aliases.ts`'s doc comment describes and the matcher will
 * build it -- never once per candidate or per file). A resource type that doesn't start with the
 * literal `aws_` prefix (another provider) never matches.
 *
 * Reports `iacEvidence` whenever any file declares `provider "aws"`, independent of whether a
 * specific resource type was found -- the tooling-and-target signal, distinct from any one
 * service.
 *
 * Every extracted key passes through `service-keys.ts`'s `normalizeServiceKey`, the same function
 * every other detector in `src/profile/detectors/**` uses -- so, for example, `aws_sfn_state_
 * machine`'s raw "sfn" key converges on the same "stepfunctions" the CDK and SDK detectors
 * produce for the same service.
 *
 * Ignores any file under a directory `walkRepo` itself would skip (this is what makes `.terraform`
 * -- Terraform's own local module and provider cache -- excluded), sharing the walker's own
 * `SKIPPED_DIRECTORY_NAMES` (see `detectors/paths.ts`).
 */
export function detectTerraform(
  files: readonly DetectableFile[],
  serviceAliasIndex: ServiceAliasIndex,
): TerraformDetectionResult {
  const evidenceByKey = new Map<string, TerraformEvidence[]>();
  const iacEvidence: TerraformEvidence[] = [];

  function record(key: string, file: string, line: number, snippet: string): void {
    let evidence = evidenceByKey.get(key);
    if (evidence === undefined) {
      evidence = [];
      evidenceByKey.set(key, evidence);
    }
    if (evidence.length < MAX_EVIDENCE_PER_KEY) {
      evidence.push({ file, line, snippet });
    }
  }

  for (const { path, content } of files) {
    if (isInsideSkippedDirectory(path) || extensionOf(path) !== ".tf") {
      continue;
    }

    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const lineText = lines[index]!;
      const lineNumber = index + 1;
      const snippet = lineText.trim();

      if (iacEvidence.length < MAX_EVIDENCE_PER_KEY && AWS_PROVIDER_PATTERN.test(lineText)) {
        iacEvidence.push({ file: path, line: lineNumber, snippet });
      }

      const match = RESOURCE_DECLARATION_PATTERN.exec(lineText);
      const resourceType = match?.groups?.type;
      if (resourceType === undefined) {
        continue;
      }
      const serviceKey = extractServiceKey(resourceType, serviceAliasIndex);
      if (serviceKey === null) {
        continue;
      }
      record(normalizeServiceKey(serviceKey), path, lineNumber, snippet);
    }
  }

  const services = [...evidenceByKey.entries()]
    .map(([key, evidence]) => ({ key, evidence }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return { services, iacEvidence };
}
