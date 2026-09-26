import { describe, expect, it } from "vitest";
import { buildServiceAliasIndex, type ServiceAliasIndex } from "../../../src/catalog/service-aliases.js";
import type { DetectableFile } from "../../../src/profile/detectable-file.js";
import {
  detectTerraform,
  TERRAFORM_PREFIX_OVERRIDES,
} from "../../../src/profile/detectors/terraform.js";
import { SKIPPED_DIRECTORY_NAMES } from "../../../src/profile/walk.js";

function file(path: string, content: string): DetectableFile {
  return { path, content };
}

function findService(result: ReturnType<typeof detectTerraform>, key: string) {
  return result.services.find((s) => s.key === key);
}

/**
 * A synthetic but realistically-named catalog, standing in for the real 2,043-session catalog's
 * 170 service names -- confirmed against the real catalog snapshot (not committed to this repo)
 * that every name here derives exactly the aliases these tests rely on, and that "bedrockagent"
 * and "apigatewayv2" genuinely do not derive from any of the real catalog's 170 names either.
 * "Amazon ElastiCache" and "Amazon ElastiCache Serverless" are both real, distinct catalog
 * entries -- the case the plan's own longest-prefix example is built around.
 */
const CATALOG_SERVICE_NAMES = [
  "Amazon DynamoDB",
  "Amazon Elastic Container Service (Amazon ECS)",
  "Amazon Elastic Kubernetes Service (Amazon EKS)",
  "Amazon Elastic Compute Cloud (Amazon EC2)",
  "AWS Lambda",
  "Amazon Simple Storage Service (Amazon S3)",
  "Amazon Simple Queue Service (Amazon SQS)",
  "AWS Key Management Service (AWS KMS)",
  "Amazon ElastiCache",
  "Amazon ElastiCache Serverless",
  "Amazon API Gateway",
  "AWS Step Functions",
  "AWS Identity and Access Management (IAM)",
  "Amazon Relational Database Service (Amazon RDS)",
  "Amazon Virtual Private Cloud (Amazon VPC)",
  "Amazon CloudWatch",
  "Amazon CloudFront",
  "Amazon Route 53",
  "Amazon Redshift",
  "Amazon Kinesis",
  "Amazon SageMaker",
  "Amazon Bedrock",
  "AWS Glue",
  "Amazon Athena",
  "Amazon EventBridge",
];

function testAliasIndex(): ServiceAliasIndex {
  return buildServiceAliasIndex(CATALOG_SERVICE_NAMES);
}

describe("detectTerraform", () => {
  it("detects aws_dynamodb_table as the dynamodb key", () => {
    const content = [
      'resource "aws_dynamodb_table" "orders" {',
      '  name = "orders"',
      "}",
    ].join("\n");

    const result = detectTerraform([file("main.tf", content)], testAliasIndex());

    expect(findService(result, "dynamodb")).toBeDefined();
  });

  it("detects aws_ecs_service as the ecs key", () => {
    const content = ['resource "aws_ecs_service" "worker" {', '  name = "worker"', "}"].join("\n");

    const result = detectTerraform([file("main.tf", content)], testAliasIndex());

    expect(findService(result, "ecs")).toBeDefined();
  });

  it("detects aws_lambda_function as the lambda key", () => {
    const content = [
      'resource "aws_lambda_function" "handler" {',
      '  function_name = "handler"',
      "}",
    ].join("\n");

    const result = detectTerraform([file("main.tf", content)], testAliasIndex());

    expect(findService(result, "lambda")).toBeDefined();
  });

  it("resolves aws_elasticache_serverless_cache to the more specific elasticacheserverless key", () => {
    // The catalog carries both "Amazon ElastiCache" and "Amazon ElastiCache Serverless" as
    // distinct, real entries. Longest-prefix match against the catalog-derived set must prefer
    // the more specific one -- a session tagged for the serverless variant is what this repo is
    // actually calling -- not fall back to the shorter, less specific "elasticache" just because
    // it also happens to resolve. If the resource-type name were split naively (e.g. always
    // taking the first two underscore-separated segments as the service), this would wrongly stop
    // at "elasticache_serverless" as the service with "cache" as the resource, or ignore the
    // longer match's specificity entirely.
    const content = [
      'resource "aws_elasticache_serverless_cache" "cache" {',
      '  name = "cache"',
      "}",
    ].join("\n");

    const result = detectTerraform([file("main.tf", content)], testAliasIndex());

    expect(findService(result, "elasticacheserverless")).toBeDefined();
    expect(findService(result, "elasticache")).toBeUndefined();
  });

  it("reports the terraform iac signal when any .tf file declares the aws provider", () => {
    const content = ['provider "aws" {', '  region = "us-east-1"', "}"].join("\n");

    const result = detectTerraform([file("main.tf", content)], testAliasIndex());

    expect(result.iacEvidence.length).toBeGreaterThan(0);
  });

  it("ignores a resource from another provider", () => {
    const content = [
      'resource "google_storage_bucket" "data" {',
      '  name = "data"',
      "}",
    ].join("\n");

    const result = detectTerraform([file("main.tf", content)], testAliasIndex());

    expect(result.services).toEqual([]);
  });

  it("does not treat a commented-out resource declaration as a real one", () => {
    // "kms" resolves via the catalog-derived set (unlike an unresolvable prefix, which would
    // fail to match regardless of whether it's commented out, proving nothing) and appears
    // nowhere else in this file -- if it shows up in the result at all, the detector matched a
    // commented-out declaration rather than a real one.
    const content = [
      '# resource "aws_kms_key" "old" {',
      '#   description = "old"',
      "# }",
      'resource "aws_dynamodb_table" "orders" {',
      '  name = "orders"',
      "}",
    ].join("\n");

    const result = detectTerraform([file("main.tf", content)], testAliasIndex());

    expect(findService(result, "kms")).toBeUndefined();
    expect(findService(result, "dynamodb")).toBeDefined();
  });

  it("does not treat a resource-type-like mention elsewhere on the line as a real declaration", () => {
    // The resource/type/name shape appears for real on this line (unescaped, in a trailing
    // comment), but not at the start of it -- only a line that actually begins with "resource"
    // is a declaration.
    const content = [
      'resource "aws_dynamodb_table" "orders" {',
      '  name = "orders" # was resource "aws_sqs_queue" "legacy"',
      "}",
    ].join("\n");

    const result = detectTerraform([file("main.tf", content)], testAliasIndex());

    expect(findService(result, "sqs")).toBeUndefined();
    expect(findService(result, "dynamodb")).toBeDefined();
  });

  it("records the resource line as evidence", () => {
    const content = [
      "# an orders table",
      'resource "aws_dynamodb_table" "orders" {',
      '  name = "orders"',
      "}",
    ].join("\n");

    const result = detectTerraform([file("main.tf", content)], testAliasIndex());

    expect(findService(result, "dynamodb")?.evidence).toEqual([
      { file: "main.tf", line: 2, snippet: expect.stringContaining("aws_dynamodb_table") },
    ]);
  });

  it.each(Object.keys(TERRAFORM_PREFIX_OVERRIDES))(
    "resolves the override prefix %s via TERRAFORM_PREFIX_OVERRIDES, which is genuinely unreachable by derivation",
    (prefix) => {
      // Proves each override entry actually earns its place: if the prefix already resolved
      // through the catalog-derived set on its own, the override would be redundant rather than
      // necessary. Checked against the same synthetic catalog used everywhere else in this file
      // (already confirmed against the real 170-name catalog snapshot -- see this file's
      // CATALOG_SERVICE_NAMES comment).
      expect(testAliasIndex().resolve(prefix)).toBeNull();
    },
  );

  it("detects aws_bedrockagent_agent via the bedrockagent override, collapsed to the bedrock key", () => {
    const content = [
      'resource "aws_bedrockagent_agent" "assistant" {',
      '  agent_name = "assistant"',
      "}",
    ].join("\n");

    const result = detectTerraform([file("main.tf", content)], testAliasIndex());

    expect(findService(result, "bedrock")).toBeDefined();
  });

  it("detects aws_apigatewayv2_api via the apigatewayv2 override, collapsed to the apigateway key", () => {
    const content = [
      'resource "aws_apigatewayv2_api" "http" {',
      '  name = "http"',
      "}",
    ].join("\n");

    const result = detectTerraform([file("main.tf", content)], testAliasIndex());

    expect(findService(result, "apigateway")).toBeDefined();
  });

  it.each([...SKIPPED_DIRECTORY_NAMES])(
    "ignores a terraform file under the shared skip directory %s",
    (skippedDir) => {
      const decoy = file(
        `${skippedDir}/nested/main.tf`,
        'resource "aws_dynamodb_table" "orders" {}',
      );

      const result = detectTerraform([decoy], testAliasIndex());

      expect(result.services).toEqual([]);
      expect(result.iacEvidence).toEqual([]);
    },
  );
});
