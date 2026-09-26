import { describe, expect, it } from "vitest";
import type { DetectableFile } from "../../../src/profile/detectable-file.js";
import { detectSdkUsage } from "../../../src/profile/detectors/sdk-usage.js";
import { SKIPPED_DIRECTORY_NAMES } from "../../../src/profile/walk.js";

function file(path: string, content: string): DetectableFile {
  return { path, content };
}

function findService(result: ReturnType<typeof detectSdkUsage>, key: string) {
  return result.services.find((s) => s.key === key);
}

describe("detectSdkUsage", () => {
  it("detects @aws-sdk/client-dynamodb as the dynamodb key from package.json", () => {
    const content = [
      "{",
      '  "name": "x",',
      '  "dependencies": {',
      '    "@aws-sdk/client-dynamodb": "^3.600.0"',
      "  }",
      "}",
    ].join("\n");

    const result = detectSdkUsage([file("package.json", content)]);

    const dynamodb = findService(result, "dynamodb");
    expect(dynamodb).toBeDefined();
    expect(dynamodb?.evidence).toEqual([
      { file: "package.json", line: 4, snippet: expect.stringContaining("@aws-sdk/client-dynamodb") },
    ]);
  });

  it("detects @aws-sdk/client-s3 from an import statement", () => {
    const content = [
      'import { S3Client } from "@aws-sdk/client-s3";',
      "",
      "const client = new S3Client({});",
    ].join("\n");

    const result = detectSdkUsage([file("src/handler.ts", content)]);

    const s3 = findService(result, "s3");
    expect(s3).toBeDefined();
    expect(s3?.evidence).toEqual([
      { file: "src/handler.ts", line: 1, snippet: expect.stringContaining("@aws-sdk/client-s3") },
    ]);
  });

  it("maps @aws-sdk/client-bedrock-runtime to the bedrock key", () => {
    const content = 'import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";';

    const result = detectSdkUsage([file("src/ai.ts", content)]);

    expect(findService(result, "bedrock")).toBeDefined();
    expect(findService(result, "bedrock-runtime")).toBeUndefined();
  });

  it("does not mangle a real client package whose key legitimately ends in -runtime", () => {
    // "@aws-sdk/client-sagemaker-runtime" is a real, distinct AWS SDK v3 package (the SageMaker
    // Runtime API for invoking deployed endpoints, separate from "@aws-sdk/client-sagemaker").
    // The bedrock-runtime mapping is an exact lookup for that one spelling, not a generic
    // "strip a trailing -runtime" rule -- a generic rule would wrongly collapse this one too.
    const content = 'import { SageMakerRuntimeClient } from "@aws-sdk/client-sagemaker-runtime";';

    const result = detectSdkUsage([file("src/predict.ts", content)]);

    expect(findService(result, "sagemaker-runtime")).toBeDefined();
    expect(findService(result, "sagemaker")).toBeUndefined();
  });

  it("detects boto3.client with a single-quoted service name", () => {
    const result = detectSdkUsage([file("app.py", "client = boto3.client('dynamodb')\n")]);

    expect(findService(result, "dynamodb")).toBeDefined();
  });

  it("detects boto3.resource with a double-quoted service name", () => {
    const result = detectSdkUsage([file("app.py", 'resource = boto3.resource("s3")\n')]);

    expect(findService(result, "s3")).toBeDefined();
  });

  it("detects aws-sdk-go-v2/service/sqs", () => {
    const result = detectSdkUsage([
      file("main.go", 'import "github.com/aws/aws-sdk-go-v2/service/sqs"\n'),
    ]);

    expect(findService(result, "sqs")).toBeDefined();
  });

  it("detects software.amazon.awssdk.services.kms", () => {
    const result = detectSdkUsage([
      file("Main.java", "import software.amazon.awssdk.services.kms.KmsClient;\n"),
    ]);

    expect(findService(result, "kms")).toBeDefined();
  });

  it("records the file and line of every detection as evidence", () => {
    const content = [
      'import { DynamoDBClient } from "@aws-sdk/client-dynamodb";',
      'import { S3Client } from "@aws-sdk/client-s3";',
    ].join("\n");

    const result = detectSdkUsage([file("src/app.ts", content)]);

    expect(findService(result, "dynamodb")?.evidence).toEqual([
      { file: "src/app.ts", line: 1, snippet: expect.stringContaining("@aws-sdk/client-dynamodb") },
    ]);
    expect(findService(result, "s3")?.evidence).toEqual([
      { file: "src/app.ts", line: 2, snippet: expect.stringContaining("@aws-sdk/client-s3") },
    ]);
  });

  it("caps evidence at three occurrences per service", () => {
    // Five genuine occurrences -- more than the cap -- so this actually distinguishes a cap from
    // an implementation that just happens to record every occurrence in a three-line fixture.
    const lines = Array.from({ length: 5 }, (_, i) => `boto3.client('dynamodb')  # call ${i}`);

    const result = detectSdkUsage([file("app.py", lines.join("\n"))]);

    const dynamodb = findService(result, "dynamodb");
    expect(dynamodb?.evidence).toHaveLength(3);
    expect(dynamodb?.evidence.map((e) => e.line)).toEqual([1, 2, 3]);
  });

  it("does not report a service mentioned only inside a comment string that does not match the call shape", () => {
    // "redshift" appears nowhere else in this file -- if it shows up in the result at all, the
    // detector matched free-text prose rather than the boto3.client(...)/boto3.resource(...)
    // call shape, which is the only thing that should ever produce a detection.
    const content = [
      '# NOTE: we might add support for the "redshift" service later, similar to s3 below.',
      's3_client = boto3.client("s3")',
    ].join("\n");

    const result = detectSdkUsage([file("app.py", content)]);

    expect(findService(result, "redshift")).toBeUndefined();
    expect(findService(result, "s3")).toBeDefined();
  });

  it.each([...SKIPPED_DIRECTORY_NAMES])(
    "ignores an SDK usage file under the shared skip directory %s",
    (skippedDir) => {
      const decoy = file(`${skippedDir}/nested/app.py`, "boto3.client('dynamodb')\n");

      const result = detectSdkUsage([decoy]);

      expect(result.services).toEqual([]);
    },
  );
});
