/**
 * Which lens a match is viewed through. Phase 1 ships only `"explain"` (foundational, conceptual
 * clarity for someone new to a service or architecture) and `"all"` (no lens restriction at all).
 * `Lens` itself, and `LensProfile`'s shape below, are what a later phase's Fix (Well-Architected)
 * and Next-level (migration paths) lenses extend without changing this module's existing cases.
 */
export type Lens = "explain" | "all";

export interface LensProfile {
  /** The level bands a session must be in to be included at all under this lens, or `null` when
   * the lens doesn't restrict by level. A session with no level band on record (the real catalog
   * has exactly one, and it isn't rare enough to assume away) is excluded whenever this is set --
   * the same "unknown is not proven to satisfy the filter" rule `catalog/query.ts`'s own
   * `--level` filter already uses, so a level-restricting lens and a level-restricting search
   * agree with each other about a session with no level at all. */
  levelBands: readonly number[] | null;
  /** An additional flat score bonus for a session of this exact type (e.g. re:Invent's own
   * lecture-style "Breakout session" and "Chalk talk" formats are favored under the Explain
   * lens over a hands-on Workshop or Lab, which assume more context than "explain a concept"
   * calls for). Absent from the map means no bonus, not a penalty. */
  typeWeights: Readonly<Record<string, number>>;
}

const EXPLAIN_LENS_PROFILE: LensProfile = {
  levelBands: [100, 200],
  typeWeights: {
    "Breakout session": 5,
    "Chalk talk": 5,
  },
};

const ALL_LENS_PROFILE: LensProfile = {
  levelBands: null,
  typeWeights: {},
};

export function getLensProfile(lens: Lens): LensProfile {
  return lens === "explain" ? EXPLAIN_LENS_PROFILE : ALL_LENS_PROFILE;
}
