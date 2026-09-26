/** A file made available to a detector: a path relative to the repository root, exactly as
 * `walkRepo` returns it, and its content already read. Detectors are pure functions over this
 * list rather than over a filesystem, so they're testable without a real directory tree and
 * usable against evidence sourced some other way in the future (the plan's seam for GitHub
 * issues as intent). */
export interface DetectableFile {
  path: string;
  content: string;
}

export interface ManifestEvidence {
  file: string;
  language: string;
}

export interface ManifestDetectionResult {
  /** Every detected language, deduplicated, in detection order. */
  languages: string[];
  evidence: ManifestEvidence[];
  /** Paths of manifest files that were recognized by name but couldn't be parsed -- reported
   * explicitly rather than silently skipped, so a caller can tell "this repo genuinely has no
   * languages" apart from "a manifest here couldn't be read". */
  unreadableManifests: string[];
}

/** Directory name a manifest's path must never pass through, wherever it appears -- independent
 * defense against a dependency-install manifest, in case this detector is ever called with a
 * file list `walkRepo` didn't produce (its primary caller, `profile.ts`, always filters this
 * already, but this detector shouldn't have to trust that). */
function isInsideNodeModules(path: string): boolean {
  return path.split(/[/\\]/).includes("node_modules");
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}

interface Detection {
  language: string;
}

/** Attempts to parse `content` as a `package.json` and derive its language signals. Always
 * "node" when it parses, plus "typescript" when a `typescript` key appears in either
 * `dependencies` or `devDependencies`. Returns `null` (rather than throwing) when the content
 * isn't valid JSON, so the caller can report the manifest as unreadable instead of every
 * language detection failing on one bad file. */
function detectFromPackageJson(content: string): Detection[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const detections: Detection[] = [{ language: "node" }];

  const record = parsed as Record<string, unknown>;
  const dependencySections = [record.dependencies, record.devDependencies];
  const hasTypescript = dependencySections.some(
    (section) =>
      typeof section === "object" && section !== null && "typescript" in (section as object),
  );
  if (hasTypescript) {
    detections.push({ language: "typescript" });
  }

  return detections;
}

/**
 * Detects languages from manifest files by name: `package.json` (node, plus typescript when
 * declared as a dependency), `pyproject.toml` or `requirements.txt` (python), `go.mod` (go),
 * `pom.xml` (java). Tolerant of a manifest that can't be parsed -- reported in
 * `unreadableManifests` rather than thrown -- and of a manifest that appears inside
 * `node_modules`, which is ignored outright rather than treated as evidence of anything.
 */
export function detectManifests(files: readonly DetectableFile[]): ManifestDetectionResult {
  const languages = new Set<string>();
  const evidence: ManifestEvidence[] = [];
  const unreadableManifests: string[] = [];

  for (const { path, content } of files) {
    if (isInsideNodeModules(path)) {
      continue;
    }

    const name = basename(path);

    if (name === "package.json") {
      const detections = detectFromPackageJson(content);
      if (detections === null) {
        unreadableManifests.push(path);
        continue;
      }
      for (const { language } of detections) {
        languages.add(language);
        evidence.push({ file: path, language });
      }
      continue;
    }

    if (name === "pyproject.toml" || name === "requirements.txt") {
      languages.add("python");
      evidence.push({ file: path, language: "python" });
      continue;
    }

    if (name === "go.mod") {
      languages.add("go");
      evidence.push({ file: path, language: "go" });
      continue;
    }

    if (name === "pom.xml") {
      languages.add("java");
      evidence.push({ file: path, language: "java" });
      continue;
    }
  }

  return {
    languages: [...languages],
    evidence,
    unreadableManifests,
  };
}
