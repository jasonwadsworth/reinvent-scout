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
  // so "bedrock-runtime" has no catalog name of its own to derive from.
  "bedrock-runtime": "Amazon Bedrock",
};
