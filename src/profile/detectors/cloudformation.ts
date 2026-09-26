import type { DetectableFile } from "../detectable-file.js";
import { normalizeServiceKey } from "../service-keys.js";
import { extensionOf, isInsideSkippedDirectory } from "./paths.js";

export type { DetectableFile } from "../detectable-file.js";

export interface CloudFormationEvidence {
  file: string;
  /** 1-indexed. */
  line: number;
  snippet: string;
}

export interface DetectedCloudFormationService {
  key: string;
  evidence: CloudFormationEvidence[];
}

export interface CloudFormationDetectionResult {
  /** Every AWS resource type found, sorted by key for a deterministic result. */
  services: DetectedCloudFormationService[];
  /** Evidence this repository uses plain CloudFormation as its IaC tool -- populated only for a
   * template that isn't more specifically a SAM template (see `samEvidence`); a SAM template
   * carries `AWSTemplateFormatVersion` too, but SAM is the flavor actually detected there, not
   * plain CloudFormation on top of it. */
  cloudformationEvidence: CloudFormationEvidence[];
  /** Evidence this repository uses SAM specifically -- a template whose `Transform` names the
   * `AWS::Serverless-*` macro. */
  samEvidence: CloudFormationEvidence[];
}

const MAX_EVIDENCE_PER_KEY = 3;

const TEMPLATE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([".yaml", ".yml", ".json"]);

const TEMPLATE_FORMAT_VERSION_PATTERN = /AWSTemplateFormatVersion/;

/** Matched as a bare substring rather than anchored to a `Transform:` key, since the transform
 * value can be a single string in YAML, a quoted string or an array element in JSON -- this
 * exact text only ever appears in a template's `Transform` declaration in practice. */
const SAM_TRANSFORM_PATTERN = /AWS::Serverless-\d{4}-\d{2}-\d{2}/;

/** A resource's `Type` line, in either YAML (`Type: AWS::S3::Bucket`) or JSON
 * (`"Type": "AWS::S3::Bucket"`) form -- the same pattern matches both without needing to know
 * which format is being scanned. */
const RESOURCE_TYPE_PATTERN =
  /"?Type"?\s*:\s*"?AWS::(?<service>[A-Za-z0-9]+)::(?<resource>[A-Za-z0-9]+)"?/g;

/**
 * SAM's own resource-type shorthand crosses AWS's normal `Service::Resource` naming scheme --
 * `AWS::Serverless::Function` isn't a real service called "Serverless", it's SAM's macro for a
 * Lambda function. Kept as a small, explicit table (matched on the full `service::resource` pair,
 * not just the `Serverless` segment) rather than a rule, since different SAM resource types
 * expand to different underlying services.
 */
const SAM_RESOURCE_TYPE_OVERRIDES: Readonly<Record<string, string>> = {
  "serverless::function": "lambda",
};

function isTemplateFile(path: string): boolean {
  return TEMPLATE_FILE_EXTENSIONS.has(extensionOf(path));
}

function keyForResourceType(service: string, resource: string): string {
  const override = SAM_RESOURCE_TYPE_OVERRIDES[`${service.toLowerCase()}::${resource.toLowerCase()}`];
  return normalizeServiceKey(override ?? service);
}

/**
 * Detects AWS resource usage from CloudFormation and SAM templates by extracting every
 * `AWS::<Service>::<Resource>` value from a `Type` line -- line-oriented text extraction, not a
 * YAML or JSON parser, since a resource type is all this detector needs and a parser would add
 * real complexity (and a real failure mode on malformed input) for no accuracy this doesn't
 * already have.
 *
 * A file is classified as a SAM template when its `Transform` names the `AWS::Serverless-*`
 * macro (`samEvidence`), or as plain CloudFormation when it carries `AWSTemplateFormatVersion`
 * with no SAM transform (`cloudformationEvidence`) -- never both for the same file, since SAM is
 * the more specific classification when both signals are present.
 *
 * Every extracted key passes through `service-keys.ts`'s `normalizeServiceKey`, the same
 * function `detectors/sdk-usage.ts` and `detectors/cdk.ts` use, so `AWS::Serverless::Function`
 * and an `@aws-sdk/client-lambda` import in the same repository converge on the same "lambda"
 * key.
 *
 * Ignores any file under a directory `walkRepo` itself would skip, sharing the walker's own
 * `SKIPPED_DIRECTORY_NAMES` (see `detectors/paths.ts`).
 */
export function detectCloudFormation(
  files: readonly DetectableFile[],
): CloudFormationDetectionResult {
  const evidenceByKey = new Map<string, CloudFormationEvidence[]>();
  const cloudformationEvidence: CloudFormationEvidence[] = [];
  const samEvidence: CloudFormationEvidence[] = [];

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
    if (isInsideSkippedDirectory(path) || !isTemplateFile(path)) {
      continue;
    }

    const isSam = SAM_TRANSFORM_PATTERN.test(content);
    const isTemplate = isSam || TEMPLATE_FORMAT_VERSION_PATTERN.test(content);
    if (!isTemplate) {
      continue;
    }

    const flavorEvidence = isSam ? samEvidence : cloudformationEvidence;

    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const lineText = lines[index]!;
      const lineNumber = index + 1;
      const snippet = lineText.trim();

      if (flavorEvidence.length < MAX_EVIDENCE_PER_KEY) {
        // Only lines that actually carry a signal (the format-version marker, the transform, or
        // a resource type) count as evidence for the file being a template at all.
        const isFlavorSignalLine = isSam
          ? SAM_TRANSFORM_PATTERN.test(lineText)
          : TEMPLATE_FORMAT_VERSION_PATTERN.test(lineText);
        if (isFlavorSignalLine) {
          flavorEvidence.push({ file: path, line: lineNumber, snippet });
        }
      }

      for (const match of lineText.matchAll(RESOURCE_TYPE_PATTERN)) {
        const service = match.groups?.service;
        const resource = match.groups?.resource;
        if (service === undefined || resource === undefined) {
          continue;
        }
        record(keyForResourceType(service, resource), path, lineNumber, snippet);
      }
    }
  }

  const services = [...evidenceByKey.entries()]
    .map(([key, evidence]) => ({ key, evidence }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return { services, cloudformationEvidence, samEvidence };
}
