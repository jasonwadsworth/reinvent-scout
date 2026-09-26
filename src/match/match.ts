import type { CatalogStoreDeps } from "../catalog/store.js";
import { requireCurrentIndex } from "../catalog/query.js";
import type { IndexRecord } from "../catalog/index-record.js";
import type { ResolvedProfile } from "../profile/profile.js";
import { getLensProfile, type Lens } from "./lens.js";
import { scoreSession, type MatchQuery, type Reason } from "./score.js";

export interface MatchOptions {
  /** Defaults to `"all"` -- no level restriction, no format preference. */
  lens?: Lens;
  /** Caps the number of candidates returned, after ranking. */
  limit?: number;
}

export interface MatchCandidate {
  record: IndexRecord;
  score: number;
  reasons: Reason[];
}

/**
 * Builds the scorer's query from a resolved, agent-authored profile:
 *
 * - `services`: every service that resolved to a catalog display name (an unresolved one has
 *   nothing to exact-match against a session's own `services`, so it's simply absent here --
 *   it still contributes through `text` below via its own `name`).
 * - `topics`: each pattern's `name` -- a pattern like "serverless" or "event-driven" is the
 *   closest agent-authored equivalent to one of the catalog's own topic labels.
 * - `areasOfInterest`: the profile's own `interests`, unchanged.
 * - `text`: every piece of free-text prose the profile carries -- each service's own `name` (not
 *   just the ones that resolved) and `usage`, each pattern's `name` and `note`, `interests`, and
 *   every intent's `text` -- joined into one string for BM25-lite scoring. A service's own `name`
 *   is included here even when it also produced an exact match above, since a text match on the
 *   same term costs nothing extra to compute and helps sessions that mention the service without
 *   it being in their formal `services` list.
 */
function buildMatchQuery(profile: ResolvedProfile): MatchQuery {
  const services: string[] = [];
  const textParts: string[] = [];

  for (const service of profile.services) {
    if (service.catalogName !== null) {
      services.push(service.catalogName);
    }
    textParts.push(service.name);
    if (service.usage !== undefined) {
      textParts.push(service.usage);
    }
  }

  const topics: string[] = [];
  for (const pattern of profile.patterns) {
    topics.push(pattern.name);
    textParts.push(pattern.name);
    if (pattern.note !== undefined) {
      textParts.push(pattern.note);
    }
  }

  const areasOfInterest = [...(profile.interests ?? [])];
  textParts.push(...areasOfInterest);

  for (const intent of profile.intents ?? []) {
    textParts.push(intent.text);
  }

  return { services, topics, areasOfInterest, text: textParts.join(" ") };
}

/**
 * Ranks the local catalog against a resolved profile, applying `options.lens`'s level-band
 * restriction (a session with no level band on record is excluded whenever the lens restricts by
 * level, never assumed to satisfy it) and format preference (an additional `"format"` reason,
 * appended on top of `scoreSession`'s own reasons) before sorting.
 *
 * A session with nothing to say for it (zero score -- no service, topic, area-of-interest, text,
 * or lens bonus at all) is excluded entirely rather than returned at the bottom with a `0`; this
 * is what makes a profile with no signals at all return an empty list instead of every session in
 * the catalog in an arbitrary order.
 *
 * Ties break first on whether the session is actually scheduled (`startDate` present) -- an
 * unscheduled session ranks below an otherwise-equal scheduled one, since there's nothing yet to
 * act on for it -- and then on `abbreviation`, the same deterministic tiebreak
 * `catalog/query.ts`'s local search already uses.
 *
 * Throws `CatalogMissingError`/`CatalogUnusableError` exactly like `queryCatalog`, since there's
 * nothing to rank against until a catalog has been synced.
 */
export function matchSessions(
  profile: ResolvedProfile,
  deps: CatalogStoreDeps,
  options: MatchOptions = {},
): MatchCandidate[] {
  const lens = options.lens ?? "all";
  const lensProfile = getLensProfile(lens);
  const index = requireCurrentIndex(deps);
  const query = buildMatchQuery(profile);

  const candidates: MatchCandidate[] = [];

  for (const record of index) {
    if (lensProfile.levelBands !== null) {
      if (record.levelBand === null || !lensProfile.levelBands.includes(record.levelBand)) {
        continue;
      }
    }

    const base = scoreSession(record, query);
    const reasons = [...base.reasons];
    let score = base.score;

    const formatBonus = record.type !== null ? lensProfile.typeWeights[record.type] : undefined;
    if (formatBonus !== undefined) {
      reasons.push({
        kind: "format",
        detail: `${record.type} sessions are favored under the ${lens} lens.`,
        weight: formatBonus,
        evidence: record.type!,
      });
      score += formatBonus;
    }

    if (score <= 0) {
      continue;
    }

    candidates.push({ record, score, reasons });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    const aScheduled = a.record.startDate !== null;
    const bScheduled = b.record.startDate !== null;
    if (aScheduled !== bScheduled) {
      return aScheduled ? -1 : 1;
    }
    return (a.record.abbreviation ?? "").localeCompare(b.record.abbreviation ?? "");
  });

  return options.limit === undefined ? candidates : candidates.slice(0, options.limit);
}
