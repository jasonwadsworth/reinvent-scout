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

/** Every prefix known to appear immediately after `aws_` in a real terraform-provider-aws
 * resource type name. Matched longest-first against the resource type's own underscore-separated
 * segments (see `extractServiceKey`), which is what correctly stops
 * `aws_elasticache_serverless_cache` at "elasticache" rather than misreading a longer run of
 * segments as a more specific (and nonexistent) service. Deliberately not exhaustive -- the AWS
 * provider has hundreds of resource types; this covers what a repository's detected services
 * plausibly need, and an unrecognized `aws_*` resource is simply not detected rather than
 * mis-detected, which is the safe failure mode.
 */
const KNOWN_TERRAFORM_SERVICE_PREFIXES: ReadonlySet<string> = new Set([
  "dynamodb",
  "ecs",
  "eks",
  "ec2",
  "lambda",
  "s3",
  "sqs",
  "sns",
  "kms",
  "elasticache",
  "apigatewayv2",
  "sfn",
  "iam",
  "rds",
  "vpc",
  "cloudwatch",
  "cloudfront",
  "route53",
]);

/** A resource declaration: `resource "aws_dynamodb_table" "orders" { ... }`. Only the type
 * string is needed -- the resource's own local name is irrelevant to service detection. */
const RESOURCE_DECLARATION_PATTERN = /^\s*resource\s+"(?<type>[a-z0-9_]+)"\s+"[^"]+"/;

/** A provider block naming `"aws"` specifically -- the IaC-against-AWS signal, independent of
 * any particular resource type. */
const AWS_PROVIDER_PATTERN = /^\s*provider\s+"aws"/;

function extractServiceKey(resourceType: string): string | null {
  if (!resourceType.startsWith("aws_")) {
    return null;
  }
  const segments = resourceType.slice("aws_".length).split("_");
  for (let length = segments.length; length >= 1; length--) {
    const candidate = segments.slice(0, length).join("_");
    if (KNOWN_TERRAFORM_SERVICE_PREFIXES.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Detects AWS resource usage from Terraform `.tf` files: `resource "aws_<service>_<rest>" "..."
 * { ... }` declarations, resolved to a service key by longest-prefix match of the type's
 * underscore-separated segments against a small known-prefix vocabulary (see
 * `KNOWN_TERRAFORM_SERVICE_PREFIXES`) -- not a naive "first segment" split, which would
 * mis-resolve a multi-word service like `aws_elasticache_serverless_cache`. A resource from
 * another provider (`google_storage_bucket`, ...) is never matched, since the type string must
 * start with the literal `aws_` prefix.
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
export function detectTerraform(files: readonly DetectableFile[]): TerraformDetectionResult {
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
      const serviceKey = extractServiceKey(resourceType);
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
