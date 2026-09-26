import { describe, expect, it } from "vitest";
import type { DetectableFile } from "../../../src/profile/detectable-file.js";
import { detectCloudFormation } from "../../../src/profile/detectors/cloudformation.js";
import { SKIPPED_DIRECTORY_NAMES } from "../../../src/profile/walk.js";

function file(path: string, content: string): DetectableFile {
  return { path, content };
}

function findService(result: ReturnType<typeof detectCloudFormation>, key: string) {
  return result.services.find((s) => s.key === key);
}

const plainTemplateYaml = [
  'AWSTemplateFormatVersion: "2010-09-09"',
  "Resources:",
  "  MyBucket:",
  "    Type: AWS::S3::Bucket",
].join("\n");

const samTemplateYaml = [
  'AWSTemplateFormatVersion: "2010-09-09"',
  "Transform: AWS::Serverless-2016-10-31",
  "Resources:",
  "  MyFunction:",
  "    Type: AWS::Serverless::Function",
].join("\n");

describe("detectCloudFormation", () => {
  it("recognises a template by AWSTemplateFormatVersion", () => {
    const result = detectCloudFormation([file("template.yaml", plainTemplateYaml)]);

    expect(result.cloudformationEvidence.length).toBeGreaterThan(0);
    expect(result.samEvidence).toEqual([]);
  });

  it("recognises a SAM template by its Serverless transform and reports the sam iac signal", () => {
    const result = detectCloudFormation([file("template.yaml", samTemplateYaml)]);

    expect(result.samEvidence.length).toBeGreaterThan(0);
    // The iac flavor actually detected is SAM, not plain CloudFormation, even though this
    // template also carries AWSTemplateFormatVersion -- SAM is the more specific classification.
    expect(result.cloudformationEvidence).toEqual([]);
  });

  it("extracts the service from a Type line such as AWS::DynamoDB::Table", () => {
    const content = [
      'AWSTemplateFormatVersion: "2010-09-09"',
      "Resources:",
      "  OrdersTable:",
      "    Type: AWS::DynamoDB::Table",
    ].join("\n");

    const result = detectCloudFormation([file("template.yaml", content)]);

    expect(findService(result, "dynamodb")).toBeDefined();
  });

  it("extracts services from a JSON template as well as YAML", () => {
    const content = JSON.stringify(
      {
        AWSTemplateFormatVersion: "2010-09-09",
        Resources: {
          OrdersTable: { Type: "AWS::DynamoDB::Table" },
        },
      },
      null,
      2,
    );

    const result = detectCloudFormation([file("template.json", content)]);

    expect(findService(result, "dynamodb")).toBeDefined();
  });

  it("maps AWS::Serverless::Function to the lambda key", () => {
    const result = detectCloudFormation([file("template.yaml", samTemplateYaml)]);

    expect(findService(result, "lambda")).toBeDefined();
  });

  it("records the resource line as evidence", () => {
    const result = detectCloudFormation([file("template.yaml", plainTemplateYaml)]);

    expect(findService(result, "s3")?.evidence).toEqual([
      { file: "template.yaml", line: 4, snippet: expect.stringContaining("AWS::S3::Bucket") },
    ]);
  });

  it("ignores a yaml file that is not a template", () => {
    // A real-looking Kubernetes manifest -- it has its own "type:" key (LoadBalancer), which a
    // naive scan for the bare word "type" would wrongly treat as a resource Type line, and a CRD
    // apiVersion shaped like "group::Kind" (colon-separated, but not "AWS::"), which a scan that
    // dropped the literal "AWS::" requirement would wrongly treat as a resource type. Nothing
    // here is shaped like an actual AWS::<Service>::<Resource> value, so nothing should be
    // detected.
    const content = [
      "apiVersion: v1",
      "kind: Service",
      "metadata:",
      "  name: my-service",
      "spec:",
      "  type: LoadBalancer",
      "  ports:",
      "    - port: 80",
      "  storageClass:",
      "    Type: Storage::Provisioner",
    ].join("\n");

    const result = detectCloudFormation([file("service.yaml", content)]);

    expect(result.services).toEqual([]);
    expect(result.cloudformationEvidence).toEqual([]);
    expect(result.samEvidence).toEqual([]);
  });

  it("does not treat a non-AWS-prefixed Type value as a resource type, even inside a real template", () => {
    // A genuine template can still carry a "Type:" line whose value isn't an AWS resource type
    // (a custom resource's own nested config, a stray comment-like key) -- this must not be
    // mistaken for a service, only the literal "AWS::<Service>::<Resource>" shape should be.
    const content = [
      'AWSTemplateFormatVersion: "2010-09-09"',
      "Resources:",
      "  MyBucket:",
      "    Type: AWS::S3::Bucket",
      "    Properties:",
      "      ProvisionerConfig:",
      "        Type: Storage::Provisioner",
    ].join("\n");

    const result = detectCloudFormation([file("template.yaml", content)]);

    expect(result.services.map((s) => s.key)).toEqual(["s3"]);
  });

  it("does not treat a mention of the Type pattern inside a comment or description as a resource type", () => {
    // "sns" and "kinesis" appear nowhere else in this template -- if either shows up in the
    // result at all, the detector matched free text (a YAML comment, a Description string) that
    // merely mentions the AWS::<Service>::<Resource> shape, rather than an actual resource
    // declaration.
    const content = [
      'AWSTemplateFormatVersion: "2010-09-09"',
      "Resources:",
      "  MyBucket:",
      "    # Considered Type: AWS::SNS::Topic here instead, but went with S3.",
      "    Type: AWS::S3::Bucket",
      "    Properties:",
      '      Description: "Replaces the old Type: AWS::Kinesis::Stream setup."',
    ].join("\n");

    const result = detectCloudFormation([file("template.yaml", content)]);

    expect(result.services.map((s) => s.key)).toEqual(["s3"]);
  });

  it("extracts services from a single-line, minified JSON template with evidence naming the logical id", () => {
    // No indentation at all -- the line-oriented YAML scanner's "Type" line would never be found
    // here, since every key is smashed onto one line. JSON.parse doesn't care about layout.
    const content = JSON.stringify({
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        OrdersTable: { Type: "AWS::DynamoDB::Table" },
      },
    });

    const result = detectCloudFormation([file("template.json", content)]);

    const dynamodb = findService(result, "dynamodb");
    expect(dynamodb).toBeDefined();
    expect(dynamodb?.evidence[0]?.snippet).toContain("OrdersTable");
    expect(dynamodb?.evidence[0]?.snippet).toContain("AWS::DynamoDB::Table");
  });

  it("reports a malformed JSON template as unreadable with a reason, and still recovers what the line scan can find", () => {
    // Missing the closing braces -- invalid JSON -- but each key still sits on its own line, so
    // the anchored line-scan fallback can still recover the real resource even though the exact
    // JSON.parse path failed.
    const content = [
      "{",
      '  "AWSTemplateFormatVersion": "2010-09-09",',
      '  "Resources": {',
      '    "OrdersTable": {',
      '      "Type": "AWS::DynamoDB::Table"',
    ].join("\n");

    const result = detectCloudFormation([file("template.json", content)]);

    expect(result.unreadableTemplates).toHaveLength(1);
    expect(result.unreadableTemplates[0]?.path).toBe("template.json");
    expect(result.unreadableTemplates[0]?.reason.length).toBeGreaterThan(0);
    expect(findService(result, "dynamodb")).toBeDefined();
  });

  it("does not throw on malformed yaml", () => {
    const content = [
      "Resources:",
      "  Bad: [unclosed",
      "\tmixed\ttabs and : colons :: weird",
      "AWSTemplateFormatVersion",
    ].join("\n");

    expect(() => detectCloudFormation([file("broken.yaml", content)])).not.toThrow();
  });

  it.each([...SKIPPED_DIRECTORY_NAMES])(
    "ignores a template file under the shared skip directory %s",
    (skippedDir) => {
      const decoy = file(`${skippedDir}/nested/template.yaml`, samTemplateYaml);

      const result = detectCloudFormation([decoy]);

      expect(result.services).toEqual([]);
      expect(result.cloudformationEvidence).toEqual([]);
      expect(result.samEvidence).toEqual([]);
    },
  );
});
