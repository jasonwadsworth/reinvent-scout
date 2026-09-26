import { describe, expect, it } from "vitest";
import type { DetectableFile } from "../../../src/profile/detectable-file.js";
import { detectCdkUsage } from "../../../src/profile/detectors/cdk.js";
import { SKIPPED_DIRECTORY_NAMES } from "../../../src/profile/walk.js";

function file(path: string, content: string): DetectableFile {
  return { path, content };
}

function findService(result: ReturnType<typeof detectCdkUsage>, key: string) {
  return result.services.find((s) => s.key === key);
}

describe("detectCdkUsage", () => {
  it("detects aws-cdk-lib/aws-lambda as the lambda key", () => {
    const content = 'import * as lambda from "aws-cdk-lib/aws-lambda";';

    const result = detectCdkUsage([file("src/stack.ts", content)]);

    expect(findService(result, "lambda")).toBeDefined();
  });

  it("detects a grouped import of aws-cdk-lib submodules", () => {
    const content =
      'import { aws_lambda as lambda, aws_dynamodb as dynamodb } from "aws-cdk-lib";';

    const result = detectCdkUsage([file("src/stack.ts", content)]);

    expect(findService(result, "lambda")).toBeDefined();
    expect(findService(result, "dynamodb")).toBeDefined();
  });

  it("detects the python aws_cdk.aws_stepfunctions form", () => {
    const content = "import aws_cdk.aws_stepfunctions as sfn\n";

    const result = detectCdkUsage([file("stack.py", content)]);

    expect(findService(result, "stepfunctions")).toBeDefined();
  });

  it("detects aws-cdk-lib in package.json as the cdk iac signal even with no submodule imports", () => {
    const content = JSON.stringify({ name: "x", dependencies: { "aws-cdk-lib": "^2.140.0" } });

    const result = detectCdkUsage([file("package.json", content)]);

    expect(result.iacEvidence.length).toBeGreaterThan(0);
    expect(result.services).toEqual([]);
  });

  it("records the import line as evidence", () => {
    const content = [
      "// a comment above the import",
      'import * as dynamodb from "aws-cdk-lib/aws-dynamodb";',
    ].join("\n");

    const result = detectCdkUsage([file("src/stack.ts", content)]);

    expect(findService(result, "dynamodb")?.evidence).toEqual([
      {
        file: "src/stack.ts",
        line: 2,
        snippet: expect.stringContaining("aws-cdk-lib/aws-dynamodb"),
      },
    ]);
  });

  it("does not treat an aws_-prefixed identifier as a grouped cdk import without a bare aws-cdk-lib reference on the same line", () => {
    // "aws_lambda_client" is a plain local identifier on a line with no CDK import at all -- if
    // the grouped-import pattern weren't scoped to a line that also matches the bare
    // "aws-cdk-lib" import, this would be misdetected as a CDK-imported lambda service.
    const content = 'const aws_lambda_client = createLambdaClient();';

    const result = detectCdkUsage([file("src/app.ts", content)]);

    expect(result.services).toEqual([]);
  });

  it("does not treat an unrelated package whose name starts with aws- as a cdk module", () => {
    // A real, plausible package name that shares a prefix with both "aws-cdk-lib" and the
    // "lambda" service key -- if the detector matched loosely on "aws-" or on "lambda" alone
    // rather than requiring the literal "aws-cdk-lib" text, this would be misdetected as CDK
    // usage of the lambda service.
    const content = JSON.stringify({
      name: "x",
      dependencies: { "aws-lambda-powertools": "^2.0.0", "aws-amplify": "^6.0.0" },
    });

    const result = detectCdkUsage([file("package.json", content)]);

    expect(result.services).toEqual([]);
    expect(result.iacEvidence).toEqual([]);
  });

  it.each([...SKIPPED_DIRECTORY_NAMES])(
    "ignores a cdk usage file under the shared skip directory %s",
    (skippedDir) => {
      const decoy = file(
        `${skippedDir}/nested/stack.ts`,
        'import * as lambda from "aws-cdk-lib/aws-lambda";',
      );

      const result = detectCdkUsage([decoy]);

      expect(result.services).toEqual([]);
      expect(result.iacEvidence).toEqual([]);
    },
  );
});
