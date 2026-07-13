import type { RoadGraphSnapshot, RoadsJson } from "./roadGraphCore.ts";

export type RoadGraphWorkerRequest = {
  id: number;
  kind: "json" | "graph";
  url: string;
};

export type RoadGraphWorkerSuccess =
  | { id: number; ok: true; kind: "json"; json: RoadsJson }
  | { id: number; ok: true; kind: "graph"; snapshot: RoadGraphSnapshot; buildMs: number };

export type RoadGraphWorkerFailure = {
  id: number;
  ok: false;
  kind: "json" | "graph";
  error: string;
};

export type RoadGraphWorkerReply = RoadGraphWorkerSuccess | RoadGraphWorkerFailure;
