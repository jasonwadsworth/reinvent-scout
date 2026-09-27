import { describe, expect, it } from "vitest";
import { normalizeServiceKey } from "../../src/catalog/service-keys.js";

describe("normalizeServiceKey", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeServiceKey("Amazon-DynamoDB")).toBe("amazondynamodb");
  });

  it("leaves an already-canonical key unchanged", () => {
    expect(normalizeServiceKey("dynamodb")).toBe("dynamodb");
    expect(normalizeServiceKey("s3")).toBe("s3");
  });

  it("collapses every spelling of bedrock-runtime to bedrock", () => {
    // Real spellings this service's name takes across ecosystems: an npm package name or a
    // boto3 client name keeps the hyphen ("bedrock-runtime"); a Go package or Java class name
    // can't carry one at all ("bedrockruntime"). Both must land on the same canonical key.
    expect(normalizeServiceKey("bedrock-runtime")).toBe("bedrock");
    expect(normalizeServiceKey("bedrockruntime")).toBe("bedrock");
    expect(normalizeServiceKey("Bedrock-Runtime")).toBe("bedrock");
  });

  it("collapses every spelling of sagemaker-runtime to sagemaker", () => {
    expect(normalizeServiceKey("sagemaker-runtime")).toBe("sagemaker");
    expect(normalizeServiceKey("sagemakerruntime")).toBe("sagemaker");
  });

  it("unifies sfn and stepfunctions to the same canonical key", () => {
    // Punctuation-stripping alone cannot unify these two -- they differ in letters, not
    // punctuation -- which is exactly why the alias step exists, not just the character filter.
    expect(normalizeServiceKey("sfn")).toBe("stepfunctions");
    expect(normalizeServiceKey("stepfunctions")).toBe("stepfunctions");
  });

  it("does not collapse an unrelated key that merely ends in runtime", () => {
    // The override is an exact lookup for the two curated spellings above, not a generic
    // "strip a trailing runtime" rule -- a synthetic key here since no real AWS service name
    // happens to share this shape without also being a case that should collapse.
    expect(normalizeServiceKey("foo-runtime")).toBe("fooruntime");
  });

  it("normalizes a key with no catalog counterpart the same as any other", () => {
    // sns has no catalog entry at all, but normalization doesn't know or care about that -- it
    // only shapes the key, which is what lets profile.ts merge sns detections across languages
    // even though there is no catalog name to merge on instead.
    expect(normalizeServiceKey("sns")).toBe("sns");
  });

  it("strips a known wrapper affix before normalizing", () => {
    expect(normalizeServiceKey("@aws-sdk/client-dynamodb")).toBe("dynamodb");
    expect(normalizeServiceKey("aws-cdk-lib/aws-dynamodb")).toBe("dynamodb");
    expect(normalizeServiceKey("aws_cdk.aws_dynamodb")).toBe("dynamodb");
    expect(normalizeServiceKey("software.amazon.awssdk.services.dynamodb")).toBe("dynamodb");
    expect(normalizeServiceKey("github.com/aws/aws-sdk-go-v2/service/dynamodb")).toBe("dynamodb");
  });

  it("strips the more specific aws_cdk.aws_ affix rather than the shorter aws_ affix it contains", () => {
    // "aws_cdk.aws_dynamodb" starts with both "aws_cdk.aws_" and the shorter "aws_" -- stripping
    // the shorter one first would leave "cdk.aws_dynamodb", not "dynamodb".
    expect(normalizeServiceKey("aws_cdk.aws_dynamodb")).toBe("dynamodb");
  });

  it("is not corrupted by every plain-object prototype member a service name could collide with", () => {
    // constructor is the one reachable today (a bare object literal's bracket lookup returns the
    // inherited Object constructor for it); toString, valueOf and hasOwnProperty are safe only
    // because lowercasing rescues them ("toString" -> "tostring") and __proto__ only because
    // punctuation-stripping does ("__proto__" -> "proto") -- pinned here so a future change to
    // normalization can't quietly re-expose one of these by accident.
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      const result = normalizeServiceKey(name);
      expect(typeof result).toBe("string");
    }
  });
});
