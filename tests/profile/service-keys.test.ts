import { describe, expect, it } from "vitest";
import { normalizeServiceKey } from "../../src/profile/service-keys.js";

describe("normalizeServiceKey", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeServiceKey("Amazon-DynamoDB")).toBe("amazondynamodb");
  });

  it("leaves an already-canonical key unchanged", () => {
    expect(normalizeServiceKey("dynamodb")).toBe("dynamodb");
    expect(normalizeServiceKey("s3")).toBe("s3");
  });

  it("collapses every spelling of bedrock-runtime to bedrock", () => {
    // The four spellings a real detector across four languages actually produces (see
    // detectors/sdk-usage.test.ts's cross-language test): JS/Python keep the hyphen, Go/Java
    // can't carry one at all. All four must land on the same canonical key.
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
});
