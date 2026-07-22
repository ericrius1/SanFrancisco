import type { RoadGraphSnapshot } from "./roadGraphCore.ts";

export type RoadGraphWorkerRequest = {
  id: number;
  url: string;
};

export type RoadGraphWorkerSuccess = {
  id: number;
  ok: true;
  snapshot: RoadGraphSnapshot;
  buildMs: number;
};

export type RoadGraphWorkerFailure = {
  id: number;
  ok: false;
  error: string;
};

export type RoadGraphWorkerReply = RoadGraphWorkerSuccess | RoadGraphWorkerFailure;
