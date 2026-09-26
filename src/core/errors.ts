/**
 * Thrown when an operation needs a signed-in session and none is available (nothing stored,
 * the store is corrupt, or a refresh was rejected with `invalid_grant`). The default message
 * names the exact command that fixes it, since every caller (CLI output, the MCP status tool)
 * wants to tell the user or agent the same thing.
 */
export class AuthRequiredError extends Error {
  constructor(message = "Not signed in. Run `reinvent-scout auth login`.") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

/**
 * Thrown when the caller is signed in but not registered for the event (the API's 403). Unlike
 * `AuthRequiredError`, running `auth login` again does not fix this -- the account itself needs
 * to register for the event -- so the message says so explicitly rather than pointing at a
 * command that won't help.
 */
export class NotRegisteredError extends Error {
  constructor(
    message = "You're signed in, but not registered for this event. Signing in again will not help; register for the event first.",
  ) {
    super(message);
    this.name = "NotRegisteredError";
  }
}

/**
 * Thrown when an operation needs the local catalog and nothing has ever been synced (see
 * `catalog/store.ts`'s `getCatalogState` and `catalog/query.ts`). The default message names the
 * exact command that fixes it, mirroring `AuthRequiredError` -- these are the pair of "you need
 * to do something first" errors a new user will hit.
 */
export class CatalogMissingError extends Error {
  constructor(message = "No catalog has been synced yet. Run `reinvent-scout catalog sync` first.") {
    super(message);
    this.name = "CatalogMissingError";
  }
}

/**
 * Thrown when a local catalog index exists but can't be trusted -- either it was built at an
 * older schema version (which may carry data poisoned by a bug fixed since, see
 * `store.ts`'s `CURRENT_SCHEMA_VERSION` history) or its sync metadata itself couldn't be read, so
 * the version is unknowable and the index may equally be poisoned. In both cases the remedy is a
 * local rebuild (`catalog sync`, or `catalog sync --reindex` to skip re-fetching) -- deliberately
 * a distinct type from `CatalogMissingError` ("nothing has ever been synced," which needs network
 * and a signed-in session instead), so a caller -- part 3's MCP tools especially -- can branch on
 * `reason` and recover programmatically rather than treating every "you need to do something
 * first" case the same way.
 */
export class CatalogUnusableError extends Error {
  public readonly reason: "outdated" | "corrupt";

  constructor(reason: "outdated" | "corrupt", message: string) {
    super(message);
    this.name = "CatalogUnusableError";
    this.reason = reason;
  }
}

/** Thrown when the API's rate limit (429) is exceeded after exhausting retries. */
export class ThrottledError extends Error {
  constructor(message = "Too many requests. Try again in a moment.") {
    super(message);
    this.name = "ThrottledError";
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

/** The requested resource does not exist (the API's 404). */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** The operation is intentionally disabled and not accepting requests right now (the API's
 * 409). Retrying will not help until it's re-enabled. */
export class OperationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationUnavailableError";
  }
}

/** An internal server error (500), or the service still unavailable (503) after exhausting
 * retries. */
export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceError";
  }
}
