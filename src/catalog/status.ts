import { readLastImport, type LastImport } from "./diff.js";
import { getCatalogState, type CatalogState, type CatalogStoreDeps, type ClockDeps } from "./store.js";

export type CatalogSummary =
  | { status: "missing" }
  | { status: "stale"; reason: "corrupt" }
  | { status: "stale"; reason: "schema-version" | "age"; syncedAt: number }
  | { status: "fresh"; syncedAt: number; count: number };

export function summarizeCatalogState(state: CatalogState): CatalogSummary {
  if (state.status === "missing") return { status: "missing" };
  if (state.status === "stale") {
    return state.reason === "corrupt" ? { status: "stale", reason: "corrupt" } : { status: "stale", reason: state.reason, syncedAt: state.meta.syncedAt };
  }
  return { status: "fresh", syncedAt: state.meta.syncedAt, count: state.meta.count };
}

export interface CatalogStatus {
  catalog: CatalogSummary;
  /** The last import's counts, present only while it still describes the stored catalog. */
  lastImport?: LastImport;
}

/** The local catalog's state, without touching the network or any account. */
export function catalogStatus(deps: CatalogStoreDeps & ClockDeps): CatalogStatus {
  const catalog = summarizeCatalogState(getCatalogState(deps));
  const lastImport = catalog.status === "missing" ? null : readLastImport(deps);
  return { catalog, ...(lastImport === null ? {} : { lastImport }) };
}
