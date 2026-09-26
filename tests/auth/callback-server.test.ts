import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { startCallbackServer, type CallbackServerHandle } from "../../src/auth/callback-server.js";

function occupyPort(port: number, host = "127.0.0.1"): Promise<NetServer> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

function closeNet(server: NetServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

let ipv6Available = false;

beforeAll(async () => {
  try {
    const probe = await occupyPort(0, "::1");
    ipv6Available = true;
    await closeNet(probe);
  } catch {
    ipv6Available = false;
  }
});

describe("startCallbackServer", () => {
  const openHandles: CallbackServerHandle[] = [];
  const occupied: NetServer[] = [];

  afterEach(async () => {
    for (const handle of openHandles.splice(0)) {
      handle.close();
    }
    for (const server of occupied.splice(0)) {
      await closeNet(server);
    }
  });

  it("binds the first free port in 8484 to 8489", async () => {
    occupied.push(await occupyPort(8484));
    occupied.push(await occupyPort(8485));

    const handle = await startCallbackServer({ expectedState: "state-1" });
    openHandles.push(handle);

    expect(handle.port).toBe(8486);
  });

  it("rejects when every port in the range is occupied", async () => {
    for (let port = 8484; port <= 8489; port++) {
      occupied.push(await occupyPort(port));
    }

    await expect(startCallbackServer({ expectedState: "state-1" })).rejects.toThrow(/no free port/i);
  });

  it("binds within an injected port range instead of the default one", async () => {
    // A custom range lets other tests (occupied-range, IPv6-conflict) exercise the same
    // port-selection logic on a couple of high, unlikely-to-collide ports instead of the real
    // 8484-8489 range, which is slower to occupy and could collide with an actual login flow
    // running elsewhere on the same machine.
    const handle = await startCallbackServer({
      expectedState: "state-1",
      portRange: { first: 19584, last: 19589 },
    });
    openHandles.push(handle);

    expect(handle.port).toBe(19584);
  });

  it("rejects when every port in the injected range is occupied", async () => {
    occupied.push(await occupyPort(19684));
    occupied.push(await occupyPort(19685));

    await expect(
      startCallbackServer({
        expectedState: "state-1",
        portRange: { first: 19684, last: 19685 },
      }),
    ).rejects.toThrow(/no free port/i);
  });

  it("clears the timeout when every port in the range is occupied", async () => {
    occupied.push(await occupyPort(19784));

    const clearedHandles: unknown[] = [];
    const fakeHandle = { marker: "fake-timeout-handle" };

    await expect(
      startCallbackServer({
        expectedState: "state-1",
        portRange: { first: 19784, last: 19784 },
        // A real setTimeout here would keep the process alive for the full timeout (15
        // minutes by default) if the bind-failure path forgot to clear it -- since Node
        // timers are ref'd by default. Injecting a fake lets the test assert the clear
        // happened without waiting on a real timer, or worse, leaking one into the test
        // process.
        setTimeoutFn: () => fakeHandle as unknown as NodeJS.Timeout,
        clearTimeoutFn: (handle) => clearedHandles.push(handle),
      }),
    ).rejects.toThrow(/no free port/i);

    expect(clearedHandles).toEqual([fakeHandle]);
  });

  it("resolves with the authorization code when the callback carries a matching state", async () => {
    const handle = await startCallbackServer({ expectedState: "state-1" });
    openHandles.push(handle);

    const response = await fetch(
      `http://localhost:${handle.port}/callback?code=auth-code-123&state=state-1`,
    );
    expect(response.status).toBe(200);

    await expect(handle.result).resolves.toEqual({ code: "auth-code-123", port: handle.port });
  });

  it("rejects with a state-mismatch error and does not resolve the code when the state differs", async () => {
    const handle = await startCallbackServer({ expectedState: "state-1" });
    openHandles.push(handle);

    await fetch(`http://localhost:${handle.port}/callback?code=auth-code-123&state=wrong-state`);

    await expect(handle.result).rejects.toThrow(/state/i);
  });

  it("rejects with the provider error when the callback carries error and error_description", async () => {
    const handle = await startCallbackServer({ expectedState: "state-1" });
    openHandles.push(handle);

    await fetch(
      `http://localhost:${handle.port}/callback?error=access_denied&error_description=User+declined+consent`,
    );

    await expect(handle.result).rejects.toThrow(/access_denied/);
    await expect(handle.result).rejects.toThrow(/User declined consent/);
  });

  it("responds 404 to a request for any path other than /callback", async () => {
    const handle = await startCallbackServer({ expectedState: "state-1" });
    openHandles.push(handle);

    const response = await fetch(`http://localhost:${handle.port}/not-the-callback`);

    expect(response.status).toBe(404);
  });

  it("stops listening once it has resolved", async () => {
    const handle = await startCallbackServer({ expectedState: "state-1" });

    await fetch(`http://localhost:${handle.port}/callback?code=auth-code-123&state=state-1`);
    await handle.result;

    await expect(fetch(`http://localhost:${handle.port}/callback?code=x&state=state-1`)).rejects.toThrow();
  });

  it("rejects after the timeout elapses", async () => {
    let fireTimeout = (): void => {
      throw new Error("timeout was never scheduled");
    };

    const handle = await startCallbackServer({
      expectedState: "state-1",
      timeoutMs: 1000,
      setTimeoutFn: (callback) => {
        fireTimeout = callback;
        return 0 as unknown as NodeJS.Timeout;
      },
      clearTimeoutFn: () => {},
    });
    openHandles.push(handle);

    fireTimeout();

    await expect(handle.result).rejects.toThrow(/timed out/i);
  });

  it("accepts the callback on either loopback address", async (ctx) => {
    const handle = await startCallbackServer({ expectedState: "state-1" });
    openHandles.push(handle);

    await fetch(`http://127.0.0.1:${handle.port}/callback?code=via-v4&state=state-1`);
    await expect(handle.result).resolves.toEqual({ code: "via-v4", port: handle.port });

    // Report as skipped, not passed, when this host has no IPv6 loopback -- a silent early
    // return here would make the suite look green while never having exercised the IPv6 half
    // of the assertion at all.
    ctx.skip(!ipv6Available, "IPv6 loopback (::1) is not available on this host");

    const handle2 = await startCallbackServer({ expectedState: "state-2" });
    openHandles.push(handle2);
    await fetch(`http://[::1]:${handle2.port}/callback?code=via-v6&state=state-2`);
    await expect(handle2.result).resolves.toEqual({ code: "via-v6", port: handle2.port });
  });

  it("skips a port whose IPv6 half is taken even though its IPv4 half is free", async (ctx) => {
    ctx.skip(!ipv6Available, "IPv6 loopback (::1) is not available on this host");

    occupied.push(await occupyPort(19884, "::1"));

    const handle = await startCallbackServer({
      expectedState: "state-1",
      portRange: { first: 19884, last: 19885 },
    });
    openHandles.push(handle);

    // The port whose IPv6 half was taken must be skipped entirely -- including its IPv4 half,
    // which was free -- per the "taken if either address is occupied" rule, since redirect
    // matching depends on the exact port and the server would otherwise be unreachable on
    // whichever loopback address the browser happens to try first.
    expect(handle.port).toBe(19885);
  });

  it("settles the result promise instead of leaving it pending when close() is called", async () => {
    const handle = await startCallbackServer({ expectedState: "state-1" });
    // Not pushed to openHandles: this test calls close() itself and asserts on the outcome,
    // so the afterEach's blanket close() would just be a harmless no-op on top of it.

    handle.close();

    await expect(handle.result).rejects.toThrow(/closed/i);
  });
});
