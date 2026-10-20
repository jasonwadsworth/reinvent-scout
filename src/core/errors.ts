/**
 * Thrown when an operation needs the local catalog and nothing has ever been imported (see
 * `catalog/store.ts`'s `getCatalogState` and `catalog/query.ts`). The default message names the
 * agent that fixes it.
 */
export class CatalogMissingError extends Error {
  constructor(message = "No catalog has been imported yet. Run the catalog sync (the reinvent-scout:catalog-sync agent).") {
    super(message);
    this.name = "CatalogMissingError";
  }
}

/**
 * Thrown when a local catalog index exists but can't be trusted -- either it was built at an
 * older schema version (which may carry data poisoned by a bug fixed since, see
 * `store.ts`'s `CURRENT_SCHEMA_VERSION` history) or its import metadata itself couldn't be read,
 * so the version is unknowable and the index may equally be poisoned. In both cases the remedy is
 * a local rebuild (`catalog_import` with `action: "reindex"`) -- deliberately a distinct type from
 * `CatalogMissingError` ("nothing has ever been imported," which needs the catalog-sync agent
 * instead), so a caller can branch on `reason` and recover programmatically rather than treating
 * every "you need to do something first" case the same way.
 */
export class CatalogUnusableError extends Error {
  public readonly reason: "outdated" | "corrupt";

  constructor(reason: "outdated" | "corrupt", message: string) {
    super(message);
    this.name = "CatalogUnusableError";
    this.reason = reason;
  }
}

/** The request was rejected as sent (the API's 400): a field is missing, too long, or
 * malformed. Not retriable -- the same request will be refused again. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
