import { buildRoadGraphSnapshot, type RoadGraphSnapshot, type RoadsJson } from "./roadGraphCore.ts";
import type {
  RoadGraphWorkerReply,
  RoadGraphWorkerRequest,
  RoadGraphWorkerSuccess
} from "./roadGraphWorkerProtocol.ts";

const MAIN_FETCH_TIMEOUT_MS = 20_000;
const WORKER_REQUEST_TIMEOUT_MS = 30_000;

type PendingWorkerRequest = {
  kind: RoadGraphWorkerRequest["kind"];
  resolve: (reply: RoadGraphWorkerSuccess) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const roadsJsonLoads = new Map<string, Promise<RoadsJson>>();
const roadGraphLoads = new Map<string, Promise<RoadGraphSnapshot>>();
const workerPending = new Map<number, PendingWorkerRequest>();
let roadWorker: Worker | null = null;
let workerUnavailable = typeof Worker === "undefined";
let nextWorkerRequestId = 1;
let latestWorkerBuildMs: number | null = null;

function resolvedRoadsUrl(url: string): string {
  if (typeof document === "undefined") return url;
  return new URL(url, document.baseURI).href;
}

function failWorker(reason: string): void {
  const error = new Error(reason);
  const failed = roadWorker;
  roadWorker = null;
  workerUnavailable = true;
  failed?.terminate();
  for (const pending of workerPending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  workerPending.clear();
}

function ensureWorker(): Worker | null {
  if (workerUnavailable) return null;
  if (roadWorker) return roadWorker;
  try {
    const worker = new Worker(new URL("./roadGraphWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<RoadGraphWorkerReply>) => {
      const reply = event.data;
      const pending = workerPending.get(reply.id);
      if (!pending) return;
      workerPending.delete(reply.id);
      clearTimeout(pending.timer);
      if (reply.kind !== pending.kind) {
        pending.reject(new Error(`Road worker returned ${reply.kind} for a ${pending.kind} request`));
      } else if (!reply.ok) {
        pending.reject(new Error(reply.error));
      } else {
        if (reply.kind === "graph") latestWorkerBuildMs = reply.buildMs;
        pending.resolve(reply);
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      failWorker(event.message || "Road worker failed");
    };
    worker.onmessageerror = () => failWorker("Road worker returned an unreadable response");
    roadWorker = worker;
    return worker;
  } catch {
    workerUnavailable = true;
    return null;
  }
}

function requestWorker(
  kind: RoadGraphWorkerRequest["kind"],
  url: string
): Promise<RoadGraphWorkerSuccess> | null {
  const worker = ensureWorker();
  if (!worker) return null;
  const id = nextWorkerRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!workerPending.has(id)) return;
      failWorker(`Road worker request timed out after ${WORKER_REQUEST_TIMEOUT_MS}ms`);
    }, WORKER_REQUEST_TIMEOUT_MS);
    workerPending.set(id, { kind, resolve, reject, timer });
    try {
      worker.postMessage({ id, kind, url } satisfies RoadGraphWorkerRequest);
    } catch (error) {
      workerPending.delete(id);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function fetchRoadsJsonOnMain(url: string): Promise<RoadsJson> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAIN_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: "force-cache", signal: controller.signal });
    if (!response.ok) throw new Error(`Road data request failed (HTTP ${response.status})`);
    return JSON.parse(await response.text()) as RoadsJson;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Road data request timed out after ${MAIN_FETCH_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Shared raw road data for consumers that still need authored polylines (lane
 * markings). In browsers the worker owns fetch + JSON.parse; unsupported-worker
 * environments use the same single cached main-thread request as a fallback. */
export function loadRoadsJson(url = "/data/roads.json"): Promise<RoadsJson> {
  const key = resolvedRoadsUrl(url);
  const existing = roadsJsonLoads.get(key);
  if (existing) return existing;

  const request = requestWorker("json", key);
  const pending = request
    ? request.then((reply) => {
        if (reply.kind !== "json") throw new Error("Road worker response mismatch");
        return reply.json;
      })
    : fetchRoadsJsonOnMain(key);
  roadsJsonLoads.set(key, pending);
  void pending.catch(() => {
    if (roadsJsonLoads.get(key) === pending) roadsJsonLoads.delete(key);
  });
  return pending;
}

/** Returns one browser-session packed snapshot. The worker path transfers the
 * buffers; repeat RoadGraph.load calls reuse them without another request or
 * another O(points/edges) build. */
export function loadRoadGraphSnapshot(url = "/data/roads.json"): Promise<RoadGraphSnapshot> {
  const key = resolvedRoadsUrl(url);
  const existing = roadGraphLoads.get(key);
  if (existing) return existing;

  const request = requestWorker("graph", key);
  const pending = request
    ? request.then((reply) => {
        if (reply.kind !== "graph") throw new Error("Road worker response mismatch");
        return reply.snapshot;
      })
    : loadRoadsJson(key).then(buildRoadGraphSnapshot);
  roadGraphLoads.set(key, pending);
  void pending.catch(() => {
    if (roadGraphLoads.get(key) === pending) roadGraphLoads.delete(key);
  });
  return pending;
}

/** Exposed for the runtime diagnostics layer without logging on the boot path. */
export function roadGraphWorkerBuildMs(): number | null {
  return latestWorkerBuildMs;
}
