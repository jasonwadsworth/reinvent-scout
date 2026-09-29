/** Shared CLI/MCP lens vocabulary; new evidence lenses have no level or format bias. */
export const LENSES = ["all", "explain", "fix", "next-level"] as const;
export type Lens = (typeof LENSES)[number];

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
   * calls for). Absent from the map means no bonus, not a penalty.
   *
   * `Map`-backed, not a plain object literal: `record.type` comes straight from the catalog API,
   * so a session typed `"constructor"`, `"toString"` or `"valueOf"` would otherwise read the
   * inherited `Object.prototype` member instead of `undefined` from a bracket lookup, pass the
   * "is this a real bonus" check, and corrupt that session's `score` -- the same prototype-key
   * hazard this codebase has already fixed at `tokenize`'s term-frequency maps and both service-key
   * override tables. */
  typeWeights: ReadonlyMap<string, number>;
}

const EXPLAIN_LENS_PROFILE: LensProfile = {
  levelBands: [100, 200],
  typeWeights: new Map([
    ["Breakout session", 5],
    ["Chalk talk", 5],
  ]),
};

const ALL_LENS_PROFILE: LensProfile = {
  levelBands: null,
  typeWeights: new Map(),
};

export function getLensProfile(lens: Lens): LensProfile {
  return lens === "explain" ? EXPLAIN_LENS_PROFILE : ALL_LENS_PROFILE;
}
