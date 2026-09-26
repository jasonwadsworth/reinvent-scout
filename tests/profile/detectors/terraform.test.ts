import { describe, expect, it } from "vitest";
import type { DetectableFile } from "../../../src/profile/detectable-file.js";
import { detectTerraform } from "../../../src/profile/detectors/terraform.js";
import { SKIPPED_DIRECTORY_NAMES } from "../../../src/profile/walk.js";

function file(path: string, content: string): DetectableFile {
  return { path, content };
}

function findService(result: ReturnType<typeof detectTerraform>, key: string) {
  return result.services.find((s) => s.key === key);
}

describe("detectTerraform", () => {
  it("detects aws_dynamodb_table as the dynamodb key", () => {
    const content = [
      'resource "aws_dynamodb_table" "orders" {',
      '  name = "orders"',
      "}",
    ].join("\n");

    const result = detectTerraform([file("main.tf", content)]);

    expect(findService(result, "dynamodb")).toBeDefined();
  });

  it("detects aws_ecs_service as the ecs key", () => {
    const content = ['resource "aws_ecs_service" "worker" {', '  name = "worker"', "}"].join("\n");

    const result = detectTerraform([file("main.tf", content)]);

    expect(findService(result, "ecs")).toBeDefined();
  });

  it("detects aws_lambda_function as the lambda key", () => {
    const content = [
      'resource "aws_lambda_function" "handler" {',
      '  function_name = "handler"',
      "}",
    ].join("\n");

    const result = detectTerraform([file("main.tf", content)]);

    expect(findService(result, "lambda")).toBeDefined();
  });

  it("resolves aws_elasticache_serverless_cache to the elasticache key via longest-prefix match", () => {
    // If the resource-type name were split naively (e.g. always taking the first two
    // underscore-separated segments as the service), this would wrongly resolve to
    // "elasticache_serverless". Longest-prefix matching against the known key set is what
    // correctly stops at "elasticache", since "elasticache_serverless" isn't itself a service.
    const content = [
      'resource "aws_elasticache_serverless_cache" "cache" {',
      '  name = "cache"',
      "}",
    ].join("\n");

    const result = detectTerraform([file("main.tf", content)]);

    expect(findService(result, "elasticache")).toBeDefined();
    expect(findService(result, "elasticache_serverless")).toBeUndefined();
  });

  it("reports the terraform iac signal when any .tf file declares the aws provider", () => {
    const content = ['provider "aws" {', '  region = "us-east-1"', "}"].join("\n");

    const result = detectTerraform([file("main.tf", content)]);

    expect(result.iacEvidence.length).toBeGreaterThan(0);
  });

  it("ignores a resource from another provider", () => {
    const content = [
      'resource "google_storage_bucket" "data" {',
      '  name = "data"',
      "}",
    ].join("\n");

    const result = detectTerraform([file("main.tf", content)]);

    expect(result.services).toEqual([]);
  });

  it("does not treat a commented-out resource declaration as a real one", () => {
    // "kms" is a recognized service prefix (unlike an unrecognized one, which would fail to
    // match regardless of whether it's commented out, proving nothing) and appears nowhere else
    // in this file -- if it shows up in the result at all, the detector matched a commented-out
    // declaration rather than a real one.
    const content = [
      '# resource "aws_kms_key" "old" {',
      '#   description = "old"',
      "# }",
      'resource "aws_dynamodb_table" "orders" {',
      '  name = "orders"',
      "}",
    ].join("\n");

    const result = detectTerraform([file("main.tf", content)]);

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

    const result = detectTerraform([file("main.tf", content)]);

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

    const result = detectTerraform([file("main.tf", content)]);

    expect(findService(result, "dynamodb")?.evidence).toEqual([
      { file: "main.tf", line: 2, snippet: expect.stringContaining("aws_dynamodb_table") },
    ]);
  });

  it.each([...SKIPPED_DIRECTORY_NAMES])(
    "ignores a terraform file under the shared skip directory %s",
    (skippedDir) => {
      const decoy = file(
        `${skippedDir}/nested/main.tf`,
        'resource "aws_dynamodb_table" "orders" {}',
      );

      const result = detectTerraform([decoy]);

      expect(result.services).toEqual([]);
      expect(result.iacEvidence).toEqual([]);
    },
  );
});
