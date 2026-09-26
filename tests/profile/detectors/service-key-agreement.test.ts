import { describe, expect, it } from "vitest";
import type { DetectableFile } from "../../../src/profile/detectable-file.js";
import { detectCdkUsage } from "../../../src/profile/detectors/cdk.js";
import { detectCloudFormation } from "../../../src/profile/detectors/cloudformation.js";
import { detectSdkUsage } from "../../../src/profile/detectors/sdk-usage.js";
import { detectTerraform } from "../../../src/profile/detectors/terraform.js";

function file(path: string, content: string): DetectableFile {
  return { path, content };
}

/**
 * The key divergence normalizeServiceKey exists to close isn't only per-language (bedrock-runtime
 * spelled with or without a hyphen) -- it's per-detector too. The CDK detector naturally produces
 * "stepfunctions" from `aws-cdk-lib/aws-stepfunctions`, while the SDK detector naturally produces
 * "sfn" from the Go SDK's package name (`@aws-sdk/... /service/sfn`). Those are different words,
 * not different punctuation of the same word, so case/punctuation normalization alone cannot
 * unify them -- only an explicit alias entry in KEY_NORMALIZATION_OVERRIDES can. These tests run
 * the real detectors end to end (not normalizeServiceKey directly) so a detector that forgot to
 * call it at all would also be caught, not just a normalizer that forgot the alias step.
 */
describe("service key agreement across detectors", () => {
  it("produces the same key from the CDK detector and the SDK detector for AWS Step Functions", () => {
    const cdkResult = detectCdkUsage([
      file("src/stack.ts", 'import * as stepfunctions from "aws-cdk-lib/aws-stepfunctions";'),
    ]);
    const sdkResult = detectSdkUsage([
      file("main.go", 'import "github.com/aws/aws-sdk-go-v2/service/sfn"\n'),
    ]);

    expect(cdkResult.services.map((s) => s.key)).toEqual(["stepfunctions"]);
    expect(sdkResult.services.map((s) => s.key)).toEqual(["stepfunctions"]);
  });

  it("produces the same key from the CDK detector and the SDK detector for a service with no catalog counterpart", () => {
    const cdkResult = detectCdkUsage([
      file("src/stack.ts", 'import * as sns from "aws-cdk-lib/aws-sns";'),
    ]);
    const sdkResult = detectSdkUsage([
      file("src/notify.ts", 'import { SNSClient } from "@aws-sdk/client-sns";'),
    ]);

    expect(cdkResult.services.map((s) => s.key)).toEqual(["sns"]);
    expect(sdkResult.services.map((s) => s.key)).toEqual(["sns"]);
  });

  it("produces the same key from the CloudFormation detector and the SDK detector for AWS::Serverless::Function", () => {
    // AWS::Serverless::Function crosses AWS's own naming scheme entirely -- "Serverless" isn't a
    // real service, it's SAM's macro name -- so this is a materially different case from a
    // language spelling difference: nothing about it looks like "lambda" without the explicit
    // SAM_RESOURCE_TYPE_OVERRIDES entry. A SAM template defining a function plus an SDK call to
    // invoke one is an ordinary serverless repo (the shape of tests/fixtures/repos/serverless-ts).
    const cfnResult = detectCloudFormation([
      file(
        "template.yaml",
        [
          'AWSTemplateFormatVersion: "2010-09-09"',
          "Transform: AWS::Serverless-2016-10-31",
          "Resources:",
          "  MyFunction:",
          "    Type: AWS::Serverless::Function",
        ].join("\n"),
      ),
    ]);
    const sdkResult = detectSdkUsage([
      file("src/invoke.ts", 'import { LambdaClient } from "@aws-sdk/client-lambda";'),
    ]);

    expect(cfnResult.services.map((s) => s.key)).toEqual(["lambda"]);
    expect(sdkResult.services.map((s) => s.key)).toEqual(["lambda"]);
  });

  it("produces the same key from the Terraform detector and the CDK detector for AWS Step Functions", () => {
    // Terraform's own resource-type prefix for Step Functions is "sfn" (aws_sfn_state_machine),
    // matching the Go SDK's package name rather than the CDK's "stepfunctions" -- a third naming
    // convention for the same service, extending the case already fixed for CDK vs SDK.
    const terraformResult = detectTerraform([
      file(
        "main.tf",
        ['resource "aws_sfn_state_machine" "workflow" {', '  name = "workflow"', "}"].join("\n"),
      ),
    ]);
    const cdkResult = detectCdkUsage([
      file("src/stack.ts", 'import * as stepfunctions from "aws-cdk-lib/aws-stepfunctions";'),
    ]);

    expect(terraformResult.services.map((s) => s.key)).toEqual(["stepfunctions"]);
    expect(cdkResult.services.map((s) => s.key)).toEqual(["stepfunctions"]);
  });
});
