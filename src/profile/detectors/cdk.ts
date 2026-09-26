import type { DetectableFile } from "../detectable-file.js";
import { extensionOf, isInsideSkippedDirectory } from "./paths.js";

export type { DetectableFile } from "../detectable-file.js";

export interface CdkEvidence {
  file: string;
  /** 1-indexed. */
  line: number;
  snippet: string;
}

export interface DetectedCdkService {
  key: string;
  evidence: CdkEvidence[];
}

export interface CdkDetectionResult {
  /** Every CDK-imported service submodule, sorted by key for a deterministic result. */
  services: DetectedCdkService[];
  /** Evidence that this repository uses the CDK as its infrastructure-as-code tool at all --
   * populated whenever `aws-cdk-lib` appears anywhere, including a bare `package.json`
   * dependency with no submodule import in sight. Empty when CDK usage wasn't detected. Capped
   * the same way `services` evidence is. */
  iacEvidence: CdkEvidence[];
}

const MAX_EVIDENCE_PER_KEY = 3;

const JS_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
]);

/** A bare `"aws-cdk-lib"` reference -- a `package.json` dependency key, or the package specifier
 * in a grouped import statement. The backreferenced quote must close immediately after the
 * package name, so this does not also match a submodule import path like
 * `"aws-cdk-lib/aws-lambda"`, which has more text before its closing quote. */
const BARE_AWS_CDK_LIB_PATTERN = /(?<quote>['"])aws-cdk-lib\k<quote>/;

/** A CDK submodule import path, e.g. `aws-cdk-lib/aws-lambda`. The captured `sub` still carries
 * its own leading `aws-`, stripped separately below. */
const CDK_SUBMODULE_PATTERN = /aws-cdk-lib\/(?<sub>[a-z0-9-]+)/g;

/** A named import destructured directly from the bare `aws-cdk-lib` package, e.g.
 * `{ aws_lambda as lambda }` -> `lambda`. Only applied to a line that also matches
 * `BARE_AWS_CDK_LIB_PATTERN`, so an unrelated identifier that happens to start with `aws_`
 * elsewhere is never mistaken for this. */
const CDK_GROUPED_IMPORT_PATTERN = /\baws_(?<sub>[a-z0-9_]+)\b/g;

/** The CDK for Python's package layout: `aws_cdk.aws_<service>`. */
const CDK_PYTHON_PATTERN = /aws_cdk\.aws_(?<sub>[a-z0-9_]+)/g;

function isJsFile(path: string): boolean {
  return JS_FILE_EXTENSIONS.has(extensionOf(path)) || path.endsWith("package.json");
}

function stripLeadingAwsDash(name: string): string {
  return name.startsWith("aws-") ? name.slice(4) : name;
}

/**
 * Detects AWS CDK usage by import form only -- a submodule import path
 * (`aws-cdk-lib/aws-lambda`), a grouped named import destructured from the bare `aws-cdk-lib`
 * package (`{ aws_lambda as lambda } from "aws-cdk-lib"`), the CDK for Python's dotted module
 * form (`aws_cdk.aws_stepfunctions`), and a bare `aws-cdk-lib` dependency or import with no
 * specific submodule at all (reported as `iacEvidence`, the tooling signal, distinct from any
 * particular service). Construct-name matching (`new lambda.Function(...)`) is deliberately out
 * of scope: it is higher false-positive and proves nothing an import doesn't already prove.
 *
 * Requires the literal text `aws-cdk-lib` (or, for Python, `aws_cdk.aws_`) -- a package that
 * merely starts with `aws-` is never mistaken for a CDK module, however similar its name looks.
 *
 * Ignores any file under a directory `walkRepo` itself would skip, sharing the walker's own
 * `SKIPPED_DIRECTORY_NAMES` (see `detectors/paths.ts`).
 */
export function detectCdkUsage(files: readonly DetectableFile[]): CdkDetectionResult {
  const evidenceByKey = new Map<string, CdkEvidence[]>();
  const iacEvidence: CdkEvidence[] = [];

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

  function recordIac(file: string, line: number, snippet: string): void {
    if (iacEvidence.length < MAX_EVIDENCE_PER_KEY) {
      iacEvidence.push({ file, line, snippet });
    }
  }

  for (const { path, content } of files) {
    if (isInsideSkippedDirectory(path)) {
      continue;
    }

    const isJs = isJsFile(path);
    const isPython = extensionOf(path) === ".py";
    if (!isJs && !isPython) {
      continue;
    }

    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const lineText = lines[index]!;
      const lineNumber = index + 1;
      const snippet = lineText.trim();

      if (isJs) {
        if (BARE_AWS_CDK_LIB_PATTERN.test(lineText)) {
          recordIac(path, lineNumber, snippet);
          for (const match of lineText.matchAll(CDK_GROUPED_IMPORT_PATTERN)) {
            const sub = match.groups?.sub;
            if (sub !== undefined) {
              record(sub, path, lineNumber, snippet);
            }
          }
        }

        for (const match of lineText.matchAll(CDK_SUBMODULE_PATTERN)) {
          const sub = match.groups?.sub;
          if (sub === undefined) {
            continue;
          }
          recordIac(path, lineNumber, snippet);
          record(stripLeadingAwsDash(sub), path, lineNumber, snippet);
        }
      }

      if (isPython) {
        for (const match of lineText.matchAll(CDK_PYTHON_PATTERN)) {
          const sub = match.groups?.sub;
          if (sub === undefined) {
            continue;
          }
          recordIac(path, lineNumber, snippet);
          record(sub, path, lineNumber, snippet);
        }
      }
    }
  }

  const services = [...evidenceByKey.entries()]
    .map(([key, evidence]) => ({ key, evidence }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return { services, iacEvidence };
}
