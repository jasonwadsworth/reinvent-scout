import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const REPOS_ROOT = join(here, "repos");

/** Lists every regular file under `dir`, recursively, including inside decoy directories like
 * `node_modules` or `.venv` -- the walker (task 3) is what's responsible for skipping those, not
 * this test helper, since "keeps every fixture repo under twenty files" is meant to count
 * everything actually on disk. */
function listFilesRecursively(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...listFilesRecursively(path));
    } else {
      files.push(path);
    }
  }
  return files;
}

function readText(...segments: string[]): string {
  return readFileSync(join(REPOS_ROOT, ...segments), "utf8");
}

describe("synthetic repository fixtures", () => {
  it("provides a serverless typescript repo with cdk, sdk clients and a lambda handler", () => {
    const pkg = JSON.parse(readText("serverless-ts", "package.json")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["aws-cdk-lib"]).toBeDefined();
    expect(pkg.dependencies?.["@aws-sdk/client-dynamodb"]).toBeDefined();
    expect(pkg.dependencies?.["@aws-sdk/client-s3"]).toBeDefined();

    const handler = readText("serverless-ts", "src", "handler.ts");
    expect(handler).toContain('from "@aws-sdk/client-dynamodb"');
    expect(handler).toContain('from "@aws-sdk/client-s3"');
    expect(handler).toContain("export async function handler(");

    const stack = readText("serverless-ts", "src", "stack.ts");
    expect(stack).toContain('from "aws-cdk-lib/aws-lambda"');
    expect(stack).toContain('from "aws-cdk-lib/aws-dynamodb"');

    // Decoys that a real walker must skip, but which genuinely exist on disk here.
    expect(readText("serverless-ts", ".env")).toContain("SECRET");
    expect(() => readText("serverless-ts", "node_modules", "some-package", "package.json")).not.toThrow();
  });

  it("provides a python repo with boto3 usage and a requirements file", () => {
    const requirements = readText("python-boto3", "requirements.txt");
    expect(requirements).toMatch(/boto3/);

    const app = readText("python-boto3", "app.py");
    expect(app).toContain("import boto3");
    expect(app).toContain("boto3.resource('dynamodb')");
    expect(app).toContain('boto3.client("s3")');

    expect(readText("python-boto3", ".env")).toContain("SECRET");
  });

  it("provides a terraform plus go repo", () => {
    const goMod = readText("terraform-go", "go.mod");
    expect(goMod).toContain("module terraform-go-fixture");

    const mainGo = readText("terraform-go", "main.go");
    expect(mainGo).toContain('"github.com/aws/aws-sdk-go-v2/service/dynamodb"');
    expect(mainGo).toContain('"github.com/aws/aws-sdk-go-v2/service/sqs"');

    const mainTf = readText("terraform-go", "main.tf");
    expect(mainTf).toContain('provider "aws"');
    expect(mainTf).toContain('resource "aws_dynamodb_table"');
    expect(mainTf).toContain('resource "aws_ecs_service"');

    // Decoys a real walker must skip.
    expect(() => readText("terraform-go", ".terraform", "modules", "decoy.tf")).not.toThrow();
    expect(() => readText("terraform-go", "vendor", "github.com", "aws", "decoy.go")).not.toThrow();
  });

  it("provides a repo with no aws signals at all", () => {
    const files = listFilesRecursively(join(REPOS_ROOT, "plain-node"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = readFileSync(file, "utf8");
      expect(content.toLowerCase()).not.toMatch(/\baws\b/);
    }
  });

  it("keeps every fixture repo under twenty files", () => {
    for (const repo of ["serverless-ts", "python-boto3", "terraform-go", "plain-node"]) {
      const files = listFilesRecursively(join(REPOS_ROOT, repo));
      expect(files.length).toBeLessThan(20);
    }
  });
});
