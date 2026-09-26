import { SERVICE_KEY_OVERRIDES } from "../profile/service-keys.js";

/** Matches a name ending in a single trailing parenthetical, e.g. `"Amazon Elastic Container
 * Service (Amazon ECS)"` -> base `"Amazon Elastic Container Service"`, parenthetical `"Amazon
 * ECS"`. A name with no parenthetical simply doesn't match, which every caller here treats the
 * same as "no parenthetical" rather than an error. */
const PARENTHETICAL_PATTERN = /^(.*?)\s*\(([^)]+)\)\s*$/;

/** A leading vendor prefix common to nearly every catalog service name; stripped when deriving a
 * short alias like `lambda` from `"AWS Lambda"` or `dynamodb` from `"Amazon DynamoDB"`. */
const VENDOR_PREFIX_PATTERN = /^(?:Amazon|AWS)\s+/;

/** One alias that two or more canonical catalog service names both derived, in the shape
 * `buildServiceAliasIndex` reports it: dropped from `resolve` (which returns `null` for it)
 * rather than silently picked. `canonicalNames` is sorted, since which name happened to be
 * processed first is not meaningful. */
export interface ServiceAliasCollision {
  alias: string;
  canonicalNames: string[];
}

export interface ServiceAliasIndex {
  /**
   * Resolves a detected service key or free-form alias to its canonical catalog display name.
   * Returns `null` when this catalog has no counterpart for it -- a detected service with no
   * catalog entry (Amazon SNS, today) is a normal outcome to report, not an error -- or when the
   * alias is ambiguous (see `collisions`). Lookup is case- and punctuation-insensitive, matching
   * how aliases are derived below.
   */
  resolve(alias: string): string | null;
  /** Every alias two or more canonical names derived. Each one always resolves to `null` via
   * `resolve`; each colliding name's own full display name still resolves correctly, since that
   * string is what actually differs between them. See `buildServiceAliasIndex`'s doc comment for
   * why this degrades instead of failing outright. */
  collisions: ServiceAliasCollision[];
}

/** Lowercases and strips everything but letters and digits, so `"AWS Lambda"`, `"aws-lambda"`
 * and `"Lambda"` all normalize to the same lookup key. */
function normalizeAliasKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Strips a leading `"Amazon "` or `"AWS "` from `name`, or returns `null` when it has neither --
 * `null` (rather than returning `name` unchanged) lets callers skip adding a redundant duplicate
 * candidate for a name that never had the prefix to begin with. */
function stripVendorPrefix(name: string): string | null {
  const match = VENDOR_PREFIX_PATTERN.exec(name);
  return match ? name.slice(match[0].length) : null;
}

/**
 * Every string a canonical catalog service name should be resolvable by, before normalization:
 * the full name; the name without its trailing parenthetical (identical to the full name when
 * there isn't one); that base name with a leading vendor prefix stripped, when it has one; the
 * parenthetical's own contents, when present; and that content with the same prefix stripped.
 *
 * This handles the two shapes the real catalog's 170 service names actually take: a bare name
 * with no useful abbreviation to extract (`"Amazon DynamoDB"` -> `dynamodb`, `"Amazon API
 * Gateway"` -> `apigateway`), and a name carrying its own abbreviation in parentheses
 * (`"Amazon Elastic Container Service (Amazon ECS)"` -> `ecs`, `"Elastic Load Balancing (ELB)"`
 * -> `elb`, the latter with no vendor prefix on the parenthetical to strip in the first place).
 */
function candidateNamesFor(canonicalName: string): string[] {
  const parenMatch = PARENTHETICAL_PATTERN.exec(canonicalName);
  const base = parenMatch ? parenMatch[1]! : canonicalName;
  const parenthetical = parenMatch ? parenMatch[2]! : null;

  const candidates = [canonicalName, base];

  const baseWithoutPrefix = stripVendorPrefix(base);
  if (baseWithoutPrefix !== null) {
    candidates.push(baseWithoutPrefix);
  }

  if (parenthetical !== null) {
    candidates.push(parenthetical);
    const parentheticalWithoutPrefix = stripVendorPrefix(parenthetical);
    if (parentheticalWithoutPrefix !== null) {
      candidates.push(parentheticalWithoutPrefix);
    }
  }

  return candidates;
}

/**
 * Builds a lookup from a detector-facing service key (however it's spelled) to the catalog's own
 * display name, derived from the actual set of service names the synced catalog carries -- not a
 * hard-coded list, so a renamed or newly introduced AWS service is picked up on the next sync
 * with no code change here. The small committed override table in `src/profile/service-keys.ts`
 * fills in the handful of keys the derivation genuinely cannot reach (an abbreviation with no
 * textual relationship to the display name, like `sfn`); an override is only applied when its
 * target canonical name actually exists in `catalogServiceNames`, so it can never claim a service
 * this catalog doesn't have.
 *
 * Backed by a `Map`, not a plain object used as a map: a normalized alias that happens to collide
 * with an inherited `Object.prototype` member (`constructor`, `toString`, `hasOwnProperty`, ...)
 * is exactly as safe to store and look up as any other string key, with no read-side guard
 * needed -- unlike `catalog/index-record.ts`'s term-frequency maps, this index is never
 * JSON-round-tripped (it's rebuilt in memory from the synced catalog on every use), so there's no
 * later read path that could reintroduce the hazard even if one were needed here.
 *
 * A single alias that two different canonical names would both produce is a genuine ambiguity,
 * but it must not make the whole index -- and so the `match` command -- unusable for every user
 * over one AWS-side rename: silently resolving it to whichever name happened to be processed
 * first would make a matcher's "exact service match" reason wrong in a way nothing downstream
 * would ever catch, but refusing to build the index at all is a worse failure than the ambiguity
 * itself. So a colliding alias is dropped (`resolve` returns `null` for it, exactly as if no
 * service had ever produced it) and reported in `collisions` instead -- degrading one alias
 * rather than breaking the command. Each colliding name's own full display name is unaffected,
 * since two different services essentially never share the exact same full name.
 */
export function buildServiceAliasIndex(catalogServiceNames: readonly string[]): ServiceAliasIndex {
  const aliasToCanonicalNames = new Map<string, Set<string>>();

  function addAlias(alias: string, canonicalName: string): void {
    let names = aliasToCanonicalNames.get(alias);
    if (names === undefined) {
      names = new Set();
      aliasToCanonicalNames.set(alias, names);
    }
    names.add(canonicalName);
  }

  const uniqueNames = [...new Set(catalogServiceNames)];
  for (const name of uniqueNames) {
    for (const candidate of candidateNamesFor(name)) {
      addAlias(normalizeAliasKey(candidate), name);
    }
  }

  const knownNames = new Set(uniqueNames);
  for (const [key, canonicalName] of Object.entries(SERVICE_KEY_OVERRIDES)) {
    if (knownNames.has(canonicalName)) {
      addAlias(normalizeAliasKey(key), canonicalName);
    }
  }

  const resolvable = new Map<string, string>();
  const collisions: ServiceAliasCollision[] = [];
  for (const [alias, names] of aliasToCanonicalNames) {
    if (names.size === 1) {
      resolvable.set(alias, [...names][0]!);
    } else {
      collisions.push({ alias, canonicalNames: [...names].sort() });
    }
  }
  collisions.sort((a, b) => a.alias.localeCompare(b.alias));

  return {
    resolve(alias: string): string | null {
      return resolvable.get(normalizeAliasKey(alias)) ?? null;
    },
    collisions,
  };
}
