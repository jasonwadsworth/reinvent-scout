/**
 * A minimal, queue-based stand-in for the global `fetch`, injected into every module that makes
 * HTTP calls so no test ever touches the network. Responses are consumed in order; the last one
 * given is reused for any extra calls beyond the queue's length, which keeps retry tests short.
 */
export interface FakeResponseInit {
  status?: number;
  headers?: Record<string, string>;
  /** When set, `.json()` resolves to this value and `.text()` returns its JSON string form. */
  json?: unknown;
  /** When set (and `json` is not), `.text()` resolves to this and `.json()` throws like real fetch does on invalid JSON. */
  text?: string;
}

export interface FakeFetchCall {
  url: string;
  init?: RequestInit;
}

export interface FakeFetch {
  fetch: typeof fetch;
  calls: FakeFetchCall[];
}

function toResponse(resp: FakeResponseInit): Response {
  const status = resp.status ?? 200;
  const headers = new Headers(resp.headers ?? {});
  const hasJson = resp.json !== undefined;
  const bodyText = hasJson ? JSON.stringify(resp.json) : (resp.text ?? "");

  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    json: async () => {
      if (hasJson) return resp.json;
      // Mirrors real fetch: parsing non-JSON text throws.
      return JSON.parse(bodyText) as unknown;
    },
    text: async () => bodyText,
  } as unknown as Response;
}

export function createFakeFetch(responses: FakeResponseInit[]): FakeFetch {
  const calls: FakeFetchCall[] = [];
  let index = 0;

  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init });
    const resp = responses[Math.min(index, responses.length - 1)];
    if (!resp) {
      throw new Error("fake fetch called with no responses queued");
    }
    index++;
    return toResponse(resp);
  }) as unknown as typeof fetch;

  return { fetch: fetchFn, calls };
}
