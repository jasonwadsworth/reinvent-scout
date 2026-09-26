import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";

const FIRST_PORT = 8484;
const LAST_PORT = 8489;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

const SUCCESS_HTML =
  "<!doctype html><html><body><h1>Signed in</h1><p>You can close this tab and return to the terminal.</p></body></html>";
const FAILURE_HTML =
  "<!doctype html><html><body><h1>Sign-in failed</h1><p>You can close this tab and return to the terminal.</p></body></html>";
const NOT_FOUND_HTML = "<!doctype html><html><body><h1>Not found</h1></body></html>";

export class CallbackTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for the OAuth callback.");
    this.name = "CallbackTimeoutError";
  }
}

export class CallbackStateMismatchError extends Error {
  constructor() {
    super("The OAuth callback's state did not match the one sent to the authorization server.");
    this.name = "CallbackStateMismatchError";
  }
}

export class CallbackProviderError extends Error {
  constructor(
    public readonly providerError: string,
    description?: string,
  ) {
    super(description ? `${providerError}: ${description}` : providerError);
    this.name = "CallbackProviderError";
  }
}

export class NoFreePortError extends Error {
  constructor(firstPort: number, lastPort: number) {
    super(`No free port available in ${firstPort}-${lastPort} for the OAuth callback server.`);
    this.name = "NoFreePortError";
  }
}

export interface CallbackResult {
  code: string;
  port: number;
}

export interface StartCallbackServerOptions {
  /** The `state` value sent to `/authorize`; a callback with a different value is refused. */
  expectedState: string;
  /** Defaults to 15 minutes. */
  timeoutMs?: number;
  /** Defaults to the global `setTimeout`. Inject a stub for deterministic tests. */
  setTimeoutFn?: (callback: () => void, ms: number) => NodeJS.Timeout;
  /** Defaults to the global `clearTimeout`. */
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
}

export interface CallbackServerHandle {
  /** The port actually bound; must be echoed into the redirect_uri sent to /authorize. */
  port: number;
  /** Resolves with the authorization code, or rejects on a provider error, state mismatch or timeout. */
  result: Promise<CallbackResult>;
  /** Stops the server immediately without settling `result`. Safe to call more than once. */
  close: () => void;
}

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

function listenOnce(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * Binds one port on both loopback addresses. `localhost` can resolve to only `::1` or only
 * `127.0.0.1` depending on the resolver, and the browser may try whichever the server didn't
 * bind -- so both are bound explicitly, on the same port, and a host with no IPv6 loopback
 * (`EADDRNOTAVAIL` on the `::1` bind) falls back to IPv4 alone.
 */
async function bindPort(port: number, requestListener: RequestListener): Promise<{ port: number; servers: Server[] }> {
  const serverV4 = createServer(requestListener);
  try {
    await listenOnce(serverV4, port, "127.0.0.1");
  } catch (err) {
    serverV4.close();
    throw err;
  }

  const serverV6 = createServer(requestListener);
  try {
    await listenOnce(serverV6, port, "::1");
    return { port, servers: [serverV4, serverV6] };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRNOTAVAIL") {
      return { port, servers: [serverV4] };
    }
    serverV4.close();
    serverV6.close();
    throw err;
  }
}

async function bindFirstFreePort(requestListener: RequestListener): Promise<{ port: number; servers: Server[] }> {
  for (let port = FIRST_PORT; port <= LAST_PORT; port++) {
    try {
      return await bindPort(port, requestListener);
    } catch {
      continue;
    }
  }
  throw new NoFreePortError(FIRST_PORT, LAST_PORT);
}

/**
 * Starts a one-shot HTTP server that waits for the OAuth authorization server to redirect back
 * to `/callback`. Resolves the returned handle once a port is bound (so the caller can build the
 * exact `redirect_uri` to send to `/authorize`); `handle.result` settles once the callback
 * arrives, the state does not match, the provider reports an error, or the timeout elapses.
 */
export async function startCallbackServer(options: StartCallbackServerOptions): Promise<CallbackServerHandle> {
  const {
    expectedState,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = options;

  let settleResolve!: (value: CallbackResult) => void;
  let settleReject!: (reason: unknown) => void;
  const result = new Promise<CallbackResult>((resolve, reject) => {
    settleResolve = resolve;
    settleReject = reject;
  });
  // The callback can arrive (and reject `result`) before a caller has attached its own
  // handler -- e.g. the HTTP response to the browser is still in flight. This extra handler
  // only marks the promise "handled" for Node's unhandledRejection detector; the original
  // promise identity returned as `handle.result` is unaffected and still rejects for callers.
  result.catch(() => {});

  let port = 0;
  let servers: Server[] = [];
  let closed = false;

  function closeAll(): void {
    if (closed) return;
    closed = true;
    for (const server of servers) {
      server.close();
      // This is a one-shot server: force-close the single request's keep-alive socket too,
      // rather than waiting on the client to disconnect. Without this, an idle keep-alive
      // connection can keep the server's 'close' event -- and the OS's hold on the port --
      // pending indefinitely.
      server.closeAllConnections();
    }
  }

  const timeoutHandle = setTimeoutFn(() => {
    closeAll();
    settleReject(new CallbackTimeoutError());
  }, timeoutMs);

  function settle(fn: () => void): void {
    clearTimeoutFn(timeoutHandle);
    closeAll();
    fn();
  }

  const requestListener: RequestListener = (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/callback") {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end(NOT_FOUND_HTML);
      return;
    }

    const params = url.searchParams;
    const providerError = params.get("error");
    const code = params.get("code");
    const state = params.get("state");

    if (providerError) {
      const description = params.get("error_description") ?? undefined;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end(FAILURE_HTML);
      settle(() => settleReject(new CallbackProviderError(providerError, description)));
      return;
    }

    if (state !== expectedState) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end(FAILURE_HTML);
      settle(() => settleReject(new CallbackStateMismatchError()));
      return;
    }

    if (!code) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end(FAILURE_HTML);
      settle(() =>
        settleReject(
          new CallbackProviderError("missing_code", "The callback did not include an authorization code."),
        ),
      );
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
    res.end(SUCCESS_HTML);
    settle(() => settleResolve({ code, port }));
  };

  const bound = await bindFirstFreePort(requestListener);
  port = bound.port;
  servers = bound.servers;

  return {
    port,
    result,
    close: () => {
      clearTimeoutFn(timeoutHandle);
      closeAll();
    },
  };
}
