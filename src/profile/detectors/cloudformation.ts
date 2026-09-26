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

export interface UnreadableTemplate {
  path: string;
  /** Why this JSON template couldn't be parsed exactly -- the JSON parser's own error message --
   * so whoever sees this doesn't have to reopen the file to find out what was wrong with it.
   * Only ever populated for `.json` templates: YAML has no parser here to fail, by design (see
   * `RESOURCE_TYPE_PATTERN`'s doc comment). */
  reason: string;
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
  /** JSON templates that couldn't be parsed exactly -- reported explicitly rather than silently
   * falling back to the line scanner with no trace, so a caller can tell "this repo genuinely has
   * few/no resources" apart from "a template here couldn't be read exactly". The line-scan
   * fallback still runs on an unreadable JSON template (best effort: it may recover the resources
   * that happen to sit on their own line even though the file as a whole doesn't parse), so this
   * list existing doesn't mean `services` is empty. */
  unreadableTemplates: UnreadableTemplate[];
}

const MAX_EVIDENCE_PER_KEY = 3;

const TEMPLATE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([".yaml", ".yml", ".json"]);

const TEMPLATE_FORMAT_VERSION_PATTERN = /AWSTemplateFormatVersion/;

/** Matched as a bare substring rather than anchored to a `Transform:` key, since the transform
 * value can be a single string in YAML, a quoted string or an array element in JSON -- this
 * exact text only ever appears in a template's `Transform` declaration in practice. */
const SAM_TRANSFORM_PATTERN = /AWS::Serverless-\d{4}-\d{2}-\d{2}/;

/** A resource's `Type` line in YAML form (`Type: AWS::S3::Bucket`) -- the JSON form is handled
 * exactly, by parsing (see `extractResourcesFromJson`), not by this pattern. Anchored to the
 * start of the line (after only leading whitespace), so a YAML comment or a string value that
 * merely *mentions* this shape ("# Considered Type: AWS::SNS::Topic here",
 * `Description: "...Type: AWS::Kinesis::Stream..."`) is never mistaken for an actual resource
 * declaration, since real content always precedes the pattern on that line in both cases. Also
 * used as a best-effort fallback for a `.json` file that fails to parse (see
 * `CloudFormationDetectionResult.unreadableTemplates`), since a resource that sits on its own
 * line may still be recoverable even when the file as a whole is invalid JSON. */
const RESOURCE_TYPE_LINE_PATTERN =
  /^\s*"?Type"?\s*:\s*"?AWS::(?<service>[A-Za-z0-9]+)::(?<resource>[A-Za-z0-9]+)"?/g;

/** A resource type value, matched exactly against the whole string once it's already been pulled
 * out of parsed JSON -- no anchoring tricks needed here, since there's no surrounding line text
 * for it to be confused with. */
const RESOURCE_TYPE_VALUE_PATTERN = /^AWS::(?<service>[A-Za-z0-9]+)::(?<resource>[A-Za-z0-9]+)$/;

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

/** The 1-indexed line on which `needle` first appears in `content`, or `1` if it isn't found on
 * any single line (e.g. a minified template, where the whole file is line 1 anyway). Used only to
 * give JSON.parse-derived evidence a real line number to point at, the same shape every other
 * evidence entry in this codebase carries. */
function findLineContaining(content: string, needle: string): number {
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]!.includes(needle)) {
      return index + 1;
    }
  }
  return 1;
}

interface JsonTemplateResource {
  logicalId: string;
  type: string;
}

type JsonExtractionResult =
  | { status: "ok"; resources: JsonTemplateResource[] }
  | { status: "unreadable"; reason: string };

/** Parses a JSON template exactly and reads `Resources[*].Type` -- comments cannot exist in
 * JSON, and there is no line-orientation limitation to work around, so this is both simpler and
 * strictly more accurate than line-scanning for the one format where a parser costs nothing
 * (`JSON.parse` needs no dependency). Reports `status: "unreadable"` rather than throwing when
 * the content isn't valid JSON, carrying the parser's own error message as `reason`. */
function extractResourcesFromJson(content: string): JsonExtractionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return { status: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { status: "unreadable", reason: "template's top level is not a JSON object" };
  }

  const resources = (parsed as Record<string, unknown>).Resources;
  const found: JsonTemplateResource[] = [];
  if (typeof resources === "object" && resources !== null) {
    for (const [logicalId, resource] of Object.entries(resources as Record<string, unknown>)) {
      if (typeof resource !== "object" || resource === null) {
        continue;
      }
      const type = (resource as Record<string, unknown>).Type;
      if (typeof type === "string") {
        found.push({ logicalId, type });
      }
    }
  }
  return { status: "ok", resources: found };
}

/**
 * Detects AWS resource usage from CloudFormation and SAM templates. A `.json` template is parsed
 * exactly with `JSON.parse` and read via `Resources[*].Type` -- no dependency needed, and no
 * false positive from a comment or a description mentioning the shape is even possible, since
 * JSON has no comments. A `.yaml`/`.yml` template is scanned line by line for a `Type` line
 * (`RESOURCE_TYPE_LINE_PATTERN`), since the plan forbids a YAML parser dependency here; the same
 * line scan is also used as a best-effort fallback when a `.json` template fails to parse (see
 * `unreadableTemplates`).
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
  const unreadableTemplates: UnreadableTemplate[] = [];

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

  function scanLinesForResourceTypes(path: string, lines: string[]): void {
    for (let index = 0; index < lines.length; index++) {
      const lineText = lines[index]!;
      const lineNumber = index + 1;
      const snippet = lineText.trim();
      for (const match of lineText.matchAll(RESOURCE_TYPE_LINE_PATTERN)) {
        const service = match.groups?.service;
        const resource = match.groups?.resource;
        if (service === undefined || resource === undefined) {
          continue;
        }
        record(keyForResourceType(service, resource), path, lineNumber, snippet);
      }
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
      if (flavorEvidence.length >= MAX_EVIDENCE_PER_KEY) {
        break;
      }
      const lineText = lines[index]!;
      // Only lines that actually carry a signal (the format-version marker, or the transform)
      // count as evidence for the file being a template at all.
      const isFlavorSignalLine = isSam
        ? SAM_TRANSFORM_PATTERN.test(lineText)
        : TEMPLATE_FORMAT_VERSION_PATTERN.test(lineText);
      if (isFlavorSignalLine) {
        flavorEvidence.push({ file: path, line: index + 1, snippet: lineText.trim() });
      }
    }

    if (extensionOf(path) === ".json") {
      const jsonResult = extractResourcesFromJson(content);
      if (jsonResult.status === "unreadable") {
        unreadableTemplates.push({ path, reason: jsonResult.reason });
        scanLinesForResourceTypes(path, lines); // Best-effort recovery.
        continue;
      }
      for (const { logicalId, type } of jsonResult.resources) {
        const match = RESOURCE_TYPE_VALUE_PATTERN.exec(type);
        const service = match?.groups?.service;
        const resource = match?.groups?.resource;
        if (service === undefined || resource === undefined) {
          continue;
        }
        const line = findLineContaining(content, type);
        record(keyForResourceType(service, resource), path, line, `${logicalId}: ${type}`);
      }
      continue;
    }

    scanLinesForResourceTypes(path, lines);
  }

  const services = [...evidenceByKey.entries()]
    .map(([key, evidence]) => ({ key, evidence }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return { services, cloudformationEvidence, samEvidence, unreadableTemplates };
}
