import { describe, expect, it } from "vitest";
import { acquireWriteQuota } from "../../src/schedule/write-quota.js";
import { createTempHome } from "../helpers/temp-home.js";

describe("operation write quotas", () => {
  it("serializes two waiters, rechecks time after waking, and keeps separate root/operation windows", async () => {
    const home = createTempHome(); const other = createTempHome();
    let t = 0; const waits: number[] = [];
    const deps = { storeRoot: home.path, now: () => t, sleep: async (ms: number) => { waits.push(ms); t += ms; } };
    try {
      await acquireWriteQuota("reserve", 30, deps);
      await Promise.all([acquireWriteQuota("reserve", 30, deps), acquireWriteQuota("reserve", 30, deps)]);
      expect(waits).toEqual([61000, 61000]);
      await acquireWriteQuota("favorite", 30, deps);
      await acquireWriteQuota("reserve", 30, { ...deps, storeRoot: other.path });
      expect(waits).toEqual([61000, 61000]);
      await acquireWriteQuota("reserve", 1, deps);
      expect(waits).toEqual([61000, 61000, 61000]);
    } finally { home.cleanup(); other.cleanup(); }
  });
  it("does not assume a sleep actually expired the window and releases queue on rejected sleep", async () => {
    const home = createTempHome(); let t = 0; let calls = 0;
    const deps = { storeRoot: home.path, now: () => t, sleep: async () => { calls++; if (calls === 1) throw new Error("interrupted"); if (calls > 2) t = 61000; } };
    try {
      await acquireWriteQuota("cancel", 30, deps);
      await expect(acquireWriteQuota("cancel", 1, deps)).rejects.toThrow("interrupted");
      await acquireWriteQuota("cancel", 1, deps);
      expect(calls).toBe(3);
    } finally { home.cleanup(); }
  });
});

it("queues waiters FIFO rather than letting both sleep on the same bucket concurrently", async () => {
  const home = createTempHome(); let t = 0; const wakes: Array<() => void> = [];
  const deps = { storeRoot: home.path, now: () => t, sleep: async (ms: number) => new Promise<void>(resolve => wakes.push(() => { t += ms; resolve(); })) };
  try {
    await acquireWriteQuota("reserve", 30, deps);
    const first = acquireWriteQuota("reserve", 30, deps);
    const second = acquireWriteQuota("reserve", 30, deps);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(wakes).toHaveLength(1);
    wakes.shift()!(); await first;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(wakes).toHaveLength(1);
    wakes.shift()!(); await second;
    expect(t).toBe(122000);
  } finally { home.cleanup(); }
});
