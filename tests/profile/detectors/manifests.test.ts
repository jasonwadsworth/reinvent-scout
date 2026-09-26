import { describe, expect, it } from "vitest";
import { detectManifests, type DetectableFile } from "../../../src/profile/detectors/manifests.js";

function file(path: string, content: string): DetectableFile {
  return { path, content };
}

describe("detectManifests", () => {
  it("detects typescript and node from package.json", () => {
    const pkg = file(
      "package.json",
      JSON.stringify({ name: "x", devDependencies: { typescript: "^5.9.0" } }),
    );

    const result = detectManifests([pkg]);

    expect(result.languages.sort()).toEqual(["node", "typescript"]);
  });

  it("detects python from pyproject.toml and requirements.txt", () => {
    const files = [
      file("pyproject.toml", "[project]\nname = \"x\"\n"),
      file("requirements.txt", "boto3==1.34.100\n"),
    ];

    const result = detectManifests(files);

    expect(result.languages).toEqual(["python"]);
  });

  it("detects go from go.mod", () => {
    const result = detectManifests([file("go.mod", "module x\n\ngo 1.22\n")]);

    expect(result.languages).toEqual(["go"]);
  });

  it("detects java from pom.xml", () => {
    const result = detectManifests([
      file("pom.xml", "<project><modelVersion>4.0.0</modelVersion></project>"),
    ]);

    expect(result.languages).toEqual(["java"]);
  });

  it("records the manifest path as evidence for each language", () => {
    const pkg = file(
      "package.json",
      JSON.stringify({ name: "x", devDependencies: { typescript: "^5.9.0" } }),
    );

    const result = detectManifests([pkg]);

    expect(result.evidence).toEqual(
      expect.arrayContaining([
        { file: "package.json", language: "node" },
        { file: "package.json", language: "typescript" },
      ]),
    );
    expect(result.evidence).toHaveLength(2);
  });

  it("ignores a package.json inside node_modules", () => {
    // Tested at the detector's own input boundary -- a file list, not a directory tree --
    // because a real repository walk (walkRepo) already excludes node_modules before this
    // detector ever runs, which would make constructing that case through the walker prove
    // nothing about the detector itself. This is independent defense-in-depth: the detector
    // does not assume its caller already filtered node_modules, so it is safe to call with an
    // unfiltered file list too (e.g. a future caller sourcing evidence some other way).
    const decoy = file(
      "node_modules/some-package/package.json",
      JSON.stringify({ name: "some-package", devDependencies: { typescript: "^5.9.0" } }),
    );

    const result = detectManifests([decoy]);

    expect(result.languages).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it("does not throw on a malformed package.json and reports it as unreadable", () => {
    const malformed = file("package.json", "{ this is not valid json");

    let result: ReturnType<typeof detectManifests> | undefined;
    expect(() => {
      result = detectManifests([malformed]);
    }).not.toThrow();

    expect(result?.unreadableManifests).toEqual(["package.json"]);
    expect(result?.languages).toEqual([]);
  });

  it("finds no languages in a repo with no manifests", () => {
    const result = detectManifests([file("README.md", "# hello")]);

    expect(result.languages).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.unreadableManifests).toEqual([]);
  });
});
