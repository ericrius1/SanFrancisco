import {
  buildRoadGraphSnapshot,
  roadGraphSnapshotTransferList,
  type RoadsJson
} from "./roadGraphCore.ts";
import type { RoadGraphWorkerReply, RoadGraphWorkerRequest } from "./roadGraphWorkerProtocol.ts";

const FETCH_TIMEOUT_MS = 20_000;

// Both the raw markings request and the packed graph request share this exact
// promise. Parsing therefore happens once per browser worker session, even when
// the two consumers initialize concurrently.
const loads = new Map<string, Promise<RoadsJson>>();

function loadRoads(url: string): Promise<RoadsJson> {
  const existing = loads.get(url);
  if (existing) return existing;

  const pending = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { cache: "force-cache", signal: controller.signal });
      if (!response.ok) throw new Error(`Road data request failed (HTTP ${response.status})`);
      const raw = await response.text();
      return JSON.parse(raw) as RoadsJson;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Road data request timed out after ${FETCH_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  })();
  loads.set(url, pending);
  void pending.catch(() => {
    if (loads.get(url) === pending) loads.delete(url);
  });
  return pending;
}

function post(reply: RoadGraphWorkerReply, transfer: ArrayBuffer[] = []): void {
  (self as unknown as { postMessage(message: unknown, transfer: ArrayBuffer[]): void }).postMessage(reply, transfer);
}

self.onmessage = async (event: MessageEvent<RoadGraphWorkerRequest>) => {
  const request = event.data;
  try {
    const json = await loadRoads(request.url);
    if (request.kind === "json") {
      post({ id: request.id, ok: true, kind: "json", json });
      return;
    }

    const started = performance.now();
    const snapshot = buildRoadGraphSnapshot(json);
    const buildMs = performance.now() - started;
    post(
      { id: request.id, ok: true, kind: "graph", snapshot, buildMs },
      roadGraphSnapshotTransferList(snapshot)
    );
  } catch (error) {
    post({
      id: request.id,
      ok: false,
      kind: request.kind,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
