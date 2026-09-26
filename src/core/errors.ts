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
