import { ValidationError } from "../core/errors.js";

export type WriteOperation = "favorite" | "unfavorite" | "reserve" | "cancel";
export interface WriteQuotaDeps {
  storeRoot: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
interface Bucket { entries: Array<{ at: number; units: number }>; tail: Promise<void> }
const buckets = new Map<string, Map<WriteOperation, Bucket>>();
const WINDOW_MS = 61_000;
/** In-process rolling windows only; independent processes still rely on the API's429 backstop. */
export async function acquireWriteQuota(operation: WriteOperation, units: number, deps: WriteQuotaDeps): Promise<void> {
  if (!Number.isInteger(units) || units < 1 || units > 30) throw new ValidationError("Write quota units must be 1–30.");
  let operations = buckets.get(deps.storeRoot);
  if (!operations) { operations = new Map(); buckets.set(deps.storeRoot, operations); }
  let bucket = operations.get(operation);
  if (!bucket) { bucket = { entries: [], tail: Promise.resolve() }; operations.set(operation, bucket); }
  const previous = bucket.tail;
  let release!: () => void;
  bucket.tail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? (async (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  try {
    for (;;) {
      const t = now();
      bucket.entries = bucket.entries.filter(entry => t - entry.at < WINDOW_MS);
      if (bucket.entries.reduce((sum, entry) => sum + entry.units, 0) + units <= 30) break;
      await sleep(Math.max(1, bucket.entries[0]!.at + WINDOW_MS - t));
    }
    bucket.entries.push({ at: now(), units });
  } finally { release(); }
}
