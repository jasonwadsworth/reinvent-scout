import type { DetectableFile } from "../detectable-file.js";
import { basename, extensionOf, isInsideSkippedDirectory } from "./paths.js";

export type { DetectableFile } from "../detectable-file.js";

export interface SdkUsageEvidence {
  file: string;
  /** 1-indexed. */
  line: number;
  snippet: string;
}

export interface DetectedSdkService {
  key: string;
  evidence: SdkUsageEvidence[];
}

export interface SdkUsageDetectionResult {
  /** Every detected service, sorted by key for a deterministic result. */
  services: DetectedSdkService[];
}

/** No more than this many evidence entries are kept per service -- a service called from fifty
 * call sites is exactly as detected as one called from one, and the profile's evidence list is
 * meant to be a few illustrative examples, not an exhaustive index of every call site. */
const MAX_EVIDENCE_PER_SERVICE = 3;

const JS_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
]);

/** `@aws-sdk/client-<name>` matches both a `package.json` dependency key string and a JS/TS
 * import or require specifier -- the same textual shape either way, which is why this one
 * pattern covers both without needing to know which kind of file it's scanning. */
const JS_CLIENT_PATTERN = /@aws-sdk\/client-(?<key>[a-z0-9][a-z0-9-]*)/g;

/** A handful of AWS SDK for JavaScript v3 client packages are named after a specific API
 * variant (`-runtime`, `-data`, ...) that the catalog and every other language's SDK naming
 * collapse into the parent service; normalized here so the JS detector's key already matches
 * what the derivation rules in `catalog/service-aliases.ts` produce from the parent service's
 * display name, with no override-table entry needed for this spelling. */
const JS_CLIENT_KEY_OVERRIDES: Readonly<Record<string, string>> = {
  "bedrock-runtime": "bedrock",
};

/** `boto3.client('name')` or `boto3.resource("name")` -- the quote character is captured and
 * backreferenced so a stray unmatched quote elsewhere on the line can't pair a single-quote open
 * with a double-quote close. */
const PYTHON_BOTO3_PATTERN = /boto3\.(?:client|resource)\(\s*(?<quote>['"])(?<key>[a-z0-9][a-z0-9-]*)\k<quote>/g;

/** The AWS SDK for Go v2's own package-per-service layout: `.../aws-sdk-go-v2/service/<name>`.
 * Matches regardless of the module path prefix before it. */
const GO_SDK_PATTERN = /aws-sdk-go-v2\/service\/(?<key>[a-z0-9]+)/g;

/** The AWS SDK for Java v2's package-per-service layout:
 * `software.amazon.awssdk.services.<name>`. */
const JAVA_SDK_PATTERN = /software\.amazon\.awssdk\.services\.(?<key>[a-z0-9]+)/g;

function isJsFile(path: string): boolean {
  return basename(path) === "package.json" || JS_FILE_EXTENSIONS.has(extensionOf(path));
}

/**
 * Detects AWS SDK client usage across JavaScript/TypeScript (`@aws-sdk/client-*`, in either a
 * `package.json` dependency or a source import/require), Python (`boto3.client(...)` /
 * `boto3.resource(...)`), Go (`aws-sdk-go-v2/service/*` imports) and Java
 * (`software.amazon.awssdk.services.*` imports). Every pattern requires the actual call or
 * import shape, not a bare mention of a service name, so text that merely discusses a service
 * (a comment, a docstring) is never mistaken for usage of it.
 *
 * Line-scans rather than parsing each language, since the shape needed is a small, specific
 * substring pattern per language -- a real parser for four languages would be far more code for
 * no additional accuracy this detector needs. Evidence is capped at
 * `MAX_EVIDENCE_PER_SERVICE` occurrences per service, in scan order; the service is still
 * reported once past the cap, only further evidence stops accumulating.
 *
 * Ignores any file under a directory `walkRepo` itself would skip (`node_modules`, `.venv`,
 * ...) -- independent defense-in-depth against a file list `walkRepo` didn't produce, sharing
 * the walker's own `SKIPPED_DIRECTORY_NAMES` rather than a locally hard-coded subset (see
 * `detectors/paths.ts`).
 */
export function detectSdkUsage(files: readonly DetectableFile[]): SdkUsageDetectionResult {
  const evidenceByKey = new Map<string, SdkUsageEvidence[]>();

  function record(key: string, file: string, line: number, snippet: string): void {
    let evidence = evidenceByKey.get(key);
    if (evidence === undefined) {
      evidence = [];
      evidenceByKey.set(key, evidence);
    }
    if (evidence.length < MAX_EVIDENCE_PER_SERVICE) {
      evidence.push({ file, line, snippet });
    }
  }

  for (const { path, content } of files) {
    if (isInsideSkippedDirectory(path)) {
      continue;
    }

    const isJs = isJsFile(path);
    const extension = extensionOf(path);
    const isPython = extension === ".py";
    const isGo = extension === ".go";
    const isJava = extension === ".java";

    if (!isJs && !isPython && !isGo && !isJava) {
      continue;
    }

    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const lineText = lines[index]!;
      const lineNumber = index + 1;
      const snippet = lineText.trim();

      if (isJs) {
        for (const match of lineText.matchAll(JS_CLIENT_PATTERN)) {
          const raw = match.groups?.key;
          if (raw === undefined) {
            continue;
          }
          const key = JS_CLIENT_KEY_OVERRIDES[raw] ?? raw;
          record(key, path, lineNumber, snippet);
        }
      }

      if (isPython) {
        for (const match of lineText.matchAll(PYTHON_BOTO3_PATTERN)) {
          const key = match.groups?.key;
          if (key === undefined) {
            continue;
          }
          record(key, path, lineNumber, snippet);
        }
      }

      if (isGo) {
        for (const match of lineText.matchAll(GO_SDK_PATTERN)) {
          const key = match.groups?.key;
          if (key === undefined) {
            continue;
          }
          record(key, path, lineNumber, snippet);
        }
      }

      if (isJava) {
        for (const match of lineText.matchAll(JAVA_SDK_PATTERN)) {
          const key = match.groups?.key;
          if (key === undefined) {
            continue;
          }
          record(key, path, lineNumber, snippet);
        }
      }
    }
  }

  const services = [...evidenceByKey.entries()]
    .map(([key, evidence]) => ({ key, evidence }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return { services };
}
