/**
 * Committed overrides for a detector-emitted service key that the catalog alias derivation in
 * `src/catalog/service-aliases.ts` cannot reach on its own -- because the short key a detector
 * actually sees (an SDK client package name, a Go/Java SDK module path, a boto3 service name) has
 * no textual relationship to the catalog's display name for that service, however the general
 * "strip the parenthetical, strip the vendor prefix" rules are applied to it.
 *
 * Keep this table as short as possible: a key the derivation rules already resolve (most of them
 * -- see `service-aliases.ts`'s doc comment) does not belong here. A stale entry that no detector
 * emits anymore is harmless (it just never gets looked up) rather than a bug, so it costs nothing
 * to leave one behind, but it is still worth pruning as detectors change.
 */
export const SERVICE_KEY_OVERRIDES: Readonly<Record<string, string>> = {
  // The AWS SDK for Go v2's package name for Step Functions is
  // `github.com/aws/aws-sdk-go-v2/service/sfn`. The catalog's display name, "AWS Step
  // Functions", has no parenthetical abbreviation for the derivation rules to find "sfn" in.
  sfn: "AWS Step Functions",
  // boto3's client name for the Bedrock Runtime API is `boto3.client("bedrock-runtime")`. The
  // catalog groups this under the single "Amazon Bedrock" topic, not a separate runtime entry,
  // so "bedrock-runtime" has no catalog name of its own to derive from. In practice no detector
  // emits this raw spelling anymore -- normalizeServiceKey below collapses it to "bedrock" before
  // it ever reaches resolution, and "bedrock" already resolves without an override -- but this
  // entry stays as defense in depth for any caller that resolves a key directly, the way
  // catalog/service-aliases.test.ts's own tests do.
  "bedrock-runtime": "Amazon Bedrock",
  // A repo calling SageMaker's inference-endpoint API uses SageMaker and should surface
  // SageMaker sessions, the same product call as bedrock-runtime above. Same defense-in-depth
  // note: normalizeServiceKey collapses this spelling to "sagemaker" before any detector's
  // output reaches resolution.
  "sagemaker-runtime": "Amazon SageMaker",
};

/** Maps a normalized (lowercased, punctuation-stripped) detector key to the one canonical key
 * every detector should emit for that service -- collapsing a spelling difference that comes
 * purely from how a language's own naming convention represents the same AWS API variant (a
 * hyphen a JS or Python name can carry that a Go package or Java class name cannot; see
 * `detectors/sdk-usage.test.ts`'s cross-language test, which confirms all four languages'
 * spellings of "bedrock runtime" normalize to the same string before this table is even
 * consulted). Distinct from `SERVICE_KEY_OVERRIDES` above: this maps key -> key, not key ->
 * catalog display name, which is what lets `profile.ts` merge detections of the same service
 * across languages by key alone -- including a service with no catalog counterpart at all (SNS),
 * where there is no catalog name to merge on instead. */
const KEY_NORMALIZATION_OVERRIDES: Readonly<Record<string, string>> = {
  bedrockruntime: "bedrock",
  sagemakerruntime: "sagemaker",
};

/**
 * Normalizes a raw, detector-emitted service key -- however this particular language's own
 * naming conventions spelled it -- into the one canonical key every detector should emit for
 * that service. Every detector in `src/profile/detectors/**` that emits a service key calls this
 * on it before returning, so this is the *only* place a key's shape is ever decided.
 */
export function normalizeServiceKey(rawKey: string): string {
  const normalized = rawKey.toLowerCase().replace(/[^a-z0-9]/g, "");
  return KEY_NORMALIZATION_OVERRIDES[normalized] ?? normalized;
}
