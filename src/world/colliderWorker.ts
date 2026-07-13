// Collider fetch + JSON.parse off the main thread: downtown tiles carry up to
// ~280 KB of collider JSON, and lexing that mid-flight was a per-tile frame
// spike. The worker parses, patches the per-box derived fields (yaw trig +
// sub-box ordinal, see BuildingCollider), and ships a flat Float64Array back —
// the main thread only unpacks numbers, never touches the JSON text.

// 13 doubles per box: i,p,x,y,z,hx,hy,hz,yaw,cosYaw,sinYaw,s,vol
export const COLLIDER_FIELDS = 13;

type ColliderRequest = {
  type?: "fetch";
  id: number;
  url: string;
  /** Optional per-fetch deadline. Callers may choose a tighter outer policy. */
  timeoutMs?: number;
  /** Total fetch attempts inside this worker request, including the first. */
  maxAttempts?: number;
};

type ColliderCancel = {
  type: "cancel";
  id: number;
};

export type ColliderWorkerReply = {
  id: number;
  buf: Float64Array | null;
  /** Additive fields: legacy callers may continue to inspect only id + buf. */
  ok: boolean;
  attempts: number;
  error?: string;
};

type RawCollider = {
  i: number;
  p: number;
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  yaw: number;
  vol: number;
};

const DEFAULT_TIMEOUT_MS = 7_500;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 160;

const boundedInt = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const activeRequests = new Map<number, AbortController>();

const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", aborted, { once: true });
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }
  });

async function fetchColliderList(
  url: string,
  timeoutMs: number,
  requestSignal: AbortSignal
): Promise<RawCollider[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cancel = () => controller.abort();
  requestSignal.addEventListener("abort", cancel, { once: true });
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error("collider payload is not an array");
    return payload as RawCollider[];
  } catch (error) {
    if (requestSignal.aborted) throw new DOMException("Aborted", "AbortError");
    if (controller.signal.aborted) throw new Error(`request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
    requestSignal.removeEventListener("abort", cancel);
  }
}

self.onmessage = async (e: MessageEvent<ColliderRequest | ColliderCancel>) => {
  if (e.data.type === "cancel") {
    activeRequests.get(e.data.id)?.abort();
    return;
  }
  const { id, url } = e.data;
  const requestController = new AbortController();
  // Request ids are unique per worker client. Replacing defensively ensures a
  // malformed duplicate cannot leave the prior network request alive.
  activeRequests.get(id)?.abort();
  activeRequests.set(id, requestController);
  const timeoutMs = boundedInt(e.data.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxAttempts = boundedInt(e.data.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, MAX_ATTEMPTS);
  let lastError = "collider request failed";

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const list = await fetchColliderList(url, timeoutMs, requestController.signal);
        if (requestController.signal.aborted) return;
        const buf = new Float64Array(list.length * COLLIDER_FIELDS);
        const seen = new Map<number, number>();
        for (let k = 0; k < list.length; k++) {
          const c = list[k];
          const s = seen.get(c.i) ?? 0;
          seen.set(c.i, s + 1);
          const o = k * COLLIDER_FIELDS;
          buf[o] = c.i;
          buf[o + 1] = c.p;
          buf[o + 2] = c.x;
          buf[o + 3] = c.y;
          buf[o + 4] = c.z;
          buf[o + 5] = c.hx;
          buf[o + 6] = c.hy;
          buf[o + 7] = c.hz;
          buf[o + 8] = c.yaw;
          buf[o + 9] = Math.cos(c.yaw);
          buf[o + 10] = Math.sin(c.yaw);
          buf[o + 11] = s;
          buf[o + 12] = c.vol;
        }
        const reply: ColliderWorkerReply = { id, buf, ok: true, attempts: attempt };
        (self as unknown as Worker).postMessage(reply, [buf.buffer]);
        return;
      } catch (error) {
        if (requestController.signal.aborted) return;
        lastError = errorMessage(error);
        if (attempt < maxAttempts) await delay(RETRY_BASE_MS * attempt, requestController.signal);
      }
    }

    if (!requestController.signal.aborted) {
      const reply: ColliderWorkerReply = {
        id,
        buf: null,
        ok: false,
        attempts: maxAttempts,
        error: lastError
      };
      (self as unknown as Worker).postMessage(reply);
    }
  } finally {
    if (activeRequests.get(id) === requestController) activeRequests.delete(id);
  }
};
