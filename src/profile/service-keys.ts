/**
 * Committed overrides for a service key the catalog alias derivation in
 * `src/catalog/service-aliases.ts` cannot reach on its own -- because the short key it's given (an
 * SDK client package name, a Go/Java SDK module path, a boto3 service name, or whatever spelling
 * the agent authoring a profile happened to use) has no textual relationship to the catalog's
 * display name for that service, however the general "strip the parenthetical, strip the vendor
 * prefix" rules are applied to it. Since the profile is agent-authored (see the "Part 2 rescoped"
 * decision), a service name can arrive in any spelling a person or an LLM would naturally write,
 * not just the handful of syntactic forms a deterministic detector would have produced -- which is
 * exactly why this table and `normalizeServiceKey` matter more now, not less.
 *
 * Backed by a `Map`, not a plain object literal used as a map: this table is looked up (and, in
 * `KEY_NORMALIZATION_OVERRIDES` below, actually *is* looked up, by `normalizeServiceKey`) with a
 * key that ultimately comes from an agent-authored profile's own text -- a service literally
 * named "constructor" must resolve to whatever it actually resolves to, not to the inherited
 * `Object.prototype.constructor` function a plain-object bracket lookup would silently return
 * instead (confirmed by `tests/profile/profile.test.ts`'s "treats prototype-key service names as
 * ordinary strings", which caught exactly this before this table was converted).
 *
 * Keep this table as short as possible: a key the derivation rules already resolve (most of them
 * -- see `service-aliases.ts`'s doc comment) does not belong here.
 */
export const SERVICE_KEY_OVERRIDES: ReadonlyMap<string, string> = new Map([
  // The AWS SDK for Go v2's package name for Step Functions is
  // `github.com/aws/aws-sdk-go-v2/service/sfn`. The catalog's display name, "AWS Step
  // Functions", has no parenthetical abbreviation for the derivation rules to find "sfn" in.
  ["sfn", "AWS Step Functions"],
  // boto3's client name for the Bedrock Runtime API is `boto3.client("bedrock-runtime")`. The
  // catalog groups this under the single "Amazon Bedrock" topic, not a separate runtime entry,
  // so "bedrock-runtime" has no catalog name of its own to derive from. normalizeServiceKey below
  // collapses this spelling to "bedrock" before it ever reaches resolution, and "bedrock" already
  // resolves without an override -- but this entry stays as defense in depth for any caller that
  // resolves a key directly, the way catalog/service-aliases.test.ts's own tests do.
  ["bedrock-runtime", "Amazon Bedrock"],
  // A repo calling SageMaker's inference-endpoint API uses SageMaker and should surface
  // SageMaker sessions, the same product call as bedrock-runtime above. Same defense-in-depth
  // note: normalizeServiceKey collapses this spelling to "sagemaker" before resolution.
  ["sagemaker-runtime", "Amazon SageMaker"],
]);

/** Maps a normalized (lowercased, punctuation-stripped) service key to the one canonical key this
 * codebase treats as that service's identity -- collapsing a spelling difference that comes
 * purely from which naming convention the source used for the same AWS API variant (a hyphen an
 * npm package or a boto3 client name can carry that a Go package or Java class name cannot, or
 * that an agent transcribing a repo simply didn't use). Distinct from `SERVICE_KEY_OVERRIDES`
 * above: this maps key -> key, not key -> catalog display name, which is what lets a profile
 * merge two mentions of the same service under one identity by key alone -- including a service
 * with no catalog counterpart at all (SNS), where there is no catalog name to merge on instead.
 * Map-backed for the same prototype-collision reason as `SERVICE_KEY_OVERRIDES` above -- this one
 * is looked up directly, on every call to `normalizeServiceKey`, so it's the table where a plain
 * object literal's `["constructor"]` footgun would actually fire on real agent input. */
const KEY_NORMALIZATION_OVERRIDES: ReadonlyMap<string, string> = new Map([
  ["bedrockruntime", "bedrock"],
  ["sagemakerruntime", "sagemaker"],
  // "stepfunctions" and "sfn" are different words, not different punctuation of the same word, so
  // the character-stripping step above cannot unify them on its own -- this is the case that
  // makes the alias step load-bearing rather than optional. "stepfunctions" is the canonical key,
  // not "sfn": it resolves through the ordinary derivation rules in catalog/service-aliases.ts
  // with no override needed at all (unlike "sfn", which is why SERVICE_KEY_OVERRIDES above still
  // carries its own "sfn" entry as defense-in-depth for a caller that resolves a raw key
  // directly).
  ["sfn", "stepfunctions"],
]);

/** A handful of literal prefixes stripped before normalization, for a name that's really an
 * import specifier or package name rather than a short key -- an agent authoring a profile may
 * transcribe exactly what it saw in the code (`"@aws-sdk/client-dynamodb"`) rather than
 * distilling it to `"dynamodb"` itself. Kept to the one form actually seen in practice; add
 * another prefix here, with a test, if a real profile needs it, rather than guessing at every
 * SDK's own naming convention up front. */
const NAME_PREFIXES_TO_STRIP: readonly string[] = ["@aws-sdk/client-"];

/**
 * Normalizes a raw service key -- however its source spelled it -- into the one canonical key
 * this codebase treats as that service's identity. `profile.ts` calls this while resolving every
 * service name in an agent-authored profile, so this is the *only* place a key's shape is ever
 * decided.
 */
export function normalizeServiceKey(rawKey: string): string {
  let working = rawKey;
  for (const prefix of NAME_PREFIXES_TO_STRIP) {
    if (working.startsWith(prefix)) {
      working = working.slice(prefix.length);
      break;
    }
  }
  const normalized = working.toLowerCase().replace(/[^a-z0-9]/g, "");
  return KEY_NORMALIZATION_OVERRIDES.get(normalized) ?? normalized;
}
