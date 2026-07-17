import type * as THREE from "three/webgpu";
import type { GardenRakeMotion } from "../player/gardenRake";
import type { PlayerMode } from "../player/types";
import { avatarFromSeed, isDefaultAvatar, normalizeAvatarTraits, type AvatarTraits } from "../player/avatar";
import { boardFromSeed, isDefaultBoard, normalizeBoardConfig, type BoardConfig } from "../vehicles/board/config";
import { carFromSeed, isDefaultCar, normalizeCarConfig, type CarConfig } from "../vehicles/car";
import { isDefaultScooter, normalizeScooterConfig, scooterFromSeed, type ScooterConfig } from "../vehicles/scooter";
import {
  isDefaultSurfboard,
  normalizeSurfboardConfig,
  surfboardFromSeed,
  type SurfboardConfig
} from "../vehicles/surf/config";

/**
 * Client side of the multiplayer presence relay (server/server.mjs).
 *
 * Transport is one WebSocket at /ws on the page's own origin — the vite dev
 * server proxies it to the local relay (vite.config.ts), and in production
 * the Node server hosts both the static build and the socket, so there is no
 * URL configuration in the common case. VITE_WS_URL overrides for split
 * hosting (static files on a CDN, relay elsewhere).
 *
 * Protocol (JSON, one room):
 *   → {t:"hi", name, avatar, board, scooter, surfboard, car} on open
 *   ← {t:"welcome", id, hue, name, players:[{id,name,hue,avatar,board,scooter,surfboard,car}]}
 *   ← {t:"join"|{t:"leave"}|{t:"name"}|{t:"avatar"}|{t:"board"}|{t:"scooter"}|{t:"surfboard"}|{t:"car"} roster changes
 *   → {t:"s", d:[mode,x,y,z,qx,qy,qz,qw,speed,ride?,rideSeat?]}   ~12 Hz while moving
 *      Positive ride ids are player vehicles; reserved negative ids are shared
 *      deterministic world rides such as the wandering ghost ship.
 *   ← {t:"snap", ts, ps:[[id,...d]]}    batched world snapshot, ~12 Hz
 *   → {t:"rtc", to, payload}            voice signaling to one peer
 *   ← {t:"rtc", from, payload}          relayed with sender id stamped
 *   → {t:"paint", d:[x,y,z,vx,vy,vz,rgb]}  one paintball shot (fire-and-forget)
 *   ← {t:"paint", id, d}                relayed to everyone else
 *   → {t:"fw", d:[[ox,oy,oz,tx,ty,tz,T,pal,size],...]}  fireworks volley
 *   ← {t:"fw", id, d}                   relayed to everyone else
 *   → {t:"chat", text}                  ephemeral text chat (no persistence)
 *   ← {t:"chat", id, name, text}        relayed to everyone else
 *   → {t:"rake", d:[[px,pz,cx,cz,ax,az,dx,dz,strength],...]} batched sand strokes
 *   ← {t:"rake", id, session, d:[[sequence,...stroke],...]} ordered echo to everyone
 *   → {t:"golf", k, d?|h?|p?|s?|r?}     golf events + cached state for late joins
 *   ← {t:"golf", id, ...}               relayed to everyone else (owner-simulated ball)
 *   → {t:"pickle", k:"claim"|"release", slot:0|1}  court-side ownership request
 *   ← {t:"pickle", k:"claim"|"release", slot, id, ok, authority} arbitration result
 *   → {t:"pickle", k:"state", d:number[]}            authority's match snapshot
 *   ← {t:"pickle", k:"state", id, authority, d}      authority-stamped relay
 *   → {t:"pickle", k:"input", slot, d:number[]}      owned-side controls
 *   ← {t:"pickle", k:"input", slot, id, authority, d} targeted relay to authority
 *   ← welcome.pickle={slots:[id,id],authority,state:{id,d}|null} late-join cache
 *   → {t:"ensemble", k:"claim"|"release", slot:0|1|2} Fort Mason station ownership
 *   → {t:"ensemble", k:"note", slot, step:0..7, velocity:0..1} linked-scale note
 *   ← {t:"ensemble", k, slot, id, ...} server-stamped ownership / note relay
 *   ← welcome.ensemble={slots:[id,id,id]} late-join station ownership
 *
 * Movement and minigame physics are client-authoritative by design. For
 * pickleball only, the relay reserves two sides and selects one full-match
 * authority (side 0's owner, otherwise side 1's) to prevent snapshot races.
 */

/** Wire order for modes — index into this array is what goes over the socket. */
export const NET_MODES: PlayerMode[] = ["walk", "drive", "plane", "boat", "drone", "board", "bird", "surf", "scooter"];

export type RemoteGolfState = { d: number[]; h: number; p: number; s: number; r: number };
export type PickleballSlot = 0 | 1;
export type EnsembleSlot = 0 | 1 | 2;
export type RemotePickleballState = { id: number; d: number[] };
export type SharedRakeStamp = {
  previous: { x: number; z: number };
  current: { x: number; z: number };
  across: { x: number; z: number };
  pull: { x: number; z: number };
  strength?: number;
};
type SequencedRakeStamp = SharedRakeStamp & { sequence: number };
export type RemoteInfo = {
  id: number;
  name: string;
  hue: number;
  avatar?: AvatarTraits;
  board?: BoardConfig;
  scooter?: ScooterConfig;
  surfboard?: SurfboardConfig;
  car?: CarConfig;
  golf?: RemoteGolfState | null;
};

/** One interpolation sample for a remote player, timestamped in local ms. */
export type NetSample = {
  t: number;
  mode: PlayerMode;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  speed: number;
  /** Riding shotgun in this player's vehicle (absent = not riding). Viewers
   * glue the avatar to THEIR interpolation of the driver's car, so the
   * passenger never trails outside the cabin. */
  ride?: number;
  /** Present only while this remote is carrying a spawned garden rake. */
  rake?: GardenRakeMotion;
  /** One-based passenger anchor. Phoenix uses 1..2; legacy vehicles use 1. */
  rideSeat?: number;
};

export type NetStatus = "connecting" | "online" | "offline" | "full";

const SEND_HZ = 12;
const KEEPALIVE_MS = 2000; // resend an unchanged pose this often (server idle-timer food)
const MAX_PLAYER_RIDE_SEAT = 2;
const MAX_WORLD_RIDE_SEAT = 12;
const NAME_MAX = 20;
const CHAT_MAX = 200;
/** Mirrors the relay caps: compact numeric snapshots, never arbitrary JSON. */
const PICKLEBALL_STATE_MAX = 96;
const PICKLEBALL_INPUT_MAX = 16;
const PICKLEBALL_VALUE_LIMIT = 1_000_000;
const RAKE_BATCH_MAX = 16;
const RAKE_HISTORY_MAX = 256;
const RAKE_COORD_LIMIT = 20_000;
const RAKE_BATCH_DELAY_MS = 50;
const PLAYER_NAME_KEY = "sf.playerName";
const PLAYER_NAME_KIND_KEY = "sf.playerNameKind";
const LAST_GENERATED_NAME_KEY = "sf.lastGeneratedPlayerName";
const CUSTOM_NAME_KIND = "custom";

const ADJ = [
  "Foggy",
  "Golden",
  "Sunny",
  "Salty",
  "Breezy",
  "Misty",
  "Neon",
  "Mellow",
  "Turbo",
  "Lucky",
  "Cosmic",
  "Pacific",
  "Sparkly",
  "Painted",
  "Wiggly",
  "Zippy"
];
const NOUN = [
  "Otter",
  "Pelican",
  "Sea Lion",
  "Gull",
  "Coyote",
  "Crab",
  "Surfer",
  "Sourdough",
  "Redwood",
  "Cable Car",
  "Fog Horn",
  "Bison",
  "Skater",
  "Firework",
  "Trolley",
  "Sea Star"
];
const FUN_NAME_FALLBACK = /^[\p{N}\s._\-']+$/u;

function isPickleballSlot(value: unknown): value is PickleballSlot {
  return value === 0 || value === 1;
}

function isEnsembleSlot(value: unknown): value is EnsembleSlot {
  return value === 0 || value === 1 || value === 2;
}

function pickleballOwner(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

function pickleballNumbers(value: unknown, maxLength: number): number[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxLength) return null;
  if (!value.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= PICKLEBALL_VALUE_LIMIT)) return null;
  return value.slice();
}

function finiteRakeNumber(value: unknown, limit: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
}

function rakeWireRow(value: unknown, sequenced: boolean): number[] | null {
  if (!Array.isArray(value) || value.length !== (sequenced ? 10 : 9)) return null;
  const offset = sequenced ? 1 : 0;
  if (sequenced && (!Number.isInteger(value[0]) || value[0] <= 0)) return null;
  if (!value.slice(offset, offset + 4).every((n) => finiteRakeNumber(n, RAKE_COORD_LIMIT))) return null;
  if (!value.slice(offset + 4, offset + 8).every((n) => finiteRakeNumber(n, 2))) return null;
  if (!finiteRakeNumber(value[offset + 8], 2) || value[offset + 8] < 0) return null;
  return value.slice() as number[];
}

function rakeStampFromRow(row: readonly number[], sequenced: boolean): SequencedRakeStamp {
  const offset = sequenced ? 1 : 0;
  return {
    sequence: sequenced ? row[0] : 0,
    previous: { x: row[offset], z: row[offset + 1] },
    current: { x: row[offset + 2], z: row[offset + 3] },
    across: { x: row[offset + 4], z: row[offset + 5] },
    pull: { x: row[offset + 6], z: row[offset + 7] },
    strength: row[offset + 8]
  };
}

function rakeRowFromStamp(stamp: Readonly<SharedRakeStamp>): number[] | null {
  const values = [
    stamp.previous.x,
    stamp.previous.z,
    stamp.current.x,
    stamp.current.z,
    stamp.across.x,
    stamp.across.z,
    stamp.pull.x,
    stamp.pull.z,
    stamp.strength ?? 1
  ];
  if (!rakeWireRow(values, false)) return null;
  return values.map((value, index) => {
    const precision = index < 4 ? 1000 : 10_000;
    return Math.round(value * precision) / precision;
  });
}

function finiteRakeMotion(value: unknown, limit = RAKE_COORD_LIMIT): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
}

function cleanName(raw: string): string {
  return raw
    .replace(/[^\p{L}\p{N} _\-'.]/gu, "")
    .trim()
    .slice(0, NAME_MAX);
}

function needsFunName(name: string): boolean {
  if (name.length < 3) return true;
  return FUN_NAME_FALLBACK.test(name);
}

function saveCustomName(name: string) {
  localStorage.setItem(PLAYER_NAME_KEY, name);
  localStorage.setItem(PLAYER_NAME_KIND_KEY, CUSTOM_NAME_KIND);
}

function clearCustomName() {
  localStorage.removeItem(PLAYER_NAME_KEY);
  localStorage.removeItem(PLAYER_NAME_KIND_KEY);
}

export function makeFunName(avoid = ""): string {
  let name = "";
  for (let i = 0; i < 8; i++) {
    name = `${ADJ[(Math.random() * ADJ.length) | 0]} ${NOUN[(Math.random() * NOUN.length) | 0]}`;
    if (name !== avoid) break;
  }
  return name;
}

function pickGeneratedName(): string {
  const name = makeFunName(localStorage.getItem(LAST_GENERATED_NAME_KEY) ?? "");
  localStorage.setItem(LAST_GENERATED_NAME_KEY, name);
  return name;
}

export function pickName(): string {
  const raw = localStorage.getItem(PLAYER_NAME_KEY) ?? "";
  const saved = cleanName(raw);
  if (localStorage.getItem(PLAYER_NAME_KIND_KEY) === CUSTOM_NAME_KIND && !needsFunName(saved)) {
    if (saved !== raw) saveCustomName(saved);
    return saved;
  }
  clearCustomName();
  return pickGeneratedName();
}

/**
 * True when a real, player-chosen name is on disk from a prior visit.
 * Fun/generated names never count (they're re-rolled every load).
 */
export function hasChosenName(): boolean {
  if (localStorage.getItem(PLAYER_NAME_KIND_KEY) !== CUSTOM_NAME_KIND) return false;
  return !needsFunName(cleanName(localStorage.getItem(PLAYER_NAME_KEY) ?? ""));
}

function rosterAvatar(id: number, raw: unknown): AvatarTraits {
  if (raw) {
    const traits = normalizeAvatarTraits(raw);
    if (!isDefaultAvatar(traits)) return traits;
  }
  return avatarFromSeed(id);
}

// same guard as avatars: absent/default board (old relay, uncustomized player)
// falls back to the per-id seed so everyone still rides something distinct
function rosterBoard(id: number, raw: unknown): BoardConfig {
  if (raw) {
    const config = normalizeBoardConfig(raw);
    if (!isDefaultBoard(config)) return config;
  }
  return boardFromSeed(id);
}

function rosterScooter(id: number, raw: unknown): ScooterConfig {
  if (raw) {
    const config = normalizeScooterConfig(raw);
    if (!isDefaultScooter(config)) return config;
  }
  return scooterFromSeed(id);
}

function rosterCar(id: number, raw: unknown): CarConfig {
  if (raw) {
    const config = normalizeCarConfig(raw);
    if (!isDefaultCar(config)) return config;
  }
  return carFromSeed(id);
}

// Surfboards use the same presence rule as the other customizable vehicles:
// missing/invalid data gets a stable per-player seeded board. The relay already
// sanitizes current-schema messages; normalizing here keeps mixed-version
// clients harmless and makes RemoteInfo safe for rendering.
function rosterSurfboard(id: number, raw: unknown): SurfboardConfig {
  if (raw) {
    const config = normalizeSurfboardConfig(raw);
    if (!isDefaultSurfboard(config)) return config;
  }
  return surfboardFromSeed(id);
}

export class Net {
  /** My server-assigned identity (0 until welcomed). */
  selfId = 0;
  selfHue = 200;
  name: string;
  status: NetStatus = "connecting";
  /** Roster of everyone else, kept in lockstep with server join/leave. */
  readonly roster = new Map<number, RemoteInfo>();
  /** Latest server-cached canonical state for late-loaded golf and reconnects. */
  readonly golfStates = new Map<number, RemoteGolfState>();
  /** Server-arbitrated owner id for each pickleball side (0 means available). */
  readonly pickleballSlots: [number, number] = [0, 0];
  /** Server-arbitrated owners for piano, steel drum and pan pipes. */
  readonly ensembleSlots: [number, number, number] = [0, 0, 0];
  /** Deterministic full-match authority: side 0's owner, otherwise side 1's. */
  pickleballAuthority = 0;
  /** Latest validated full-match snapshot, cached for lazy/late initialization. */
  pickleballState: RemotePickleballState | null = null;

  onRoster: () => void = () => {}; // any join/leave/rename (rebuild lists)
  onJoin: (id: number, name: string) => void = () => {}; // a new player entered (announce/toast)
  onWelcome: () => void = () => {}; // assigned id + roster hydrated — push saved avatar
  onSample: (id: number, s: NetSample) => void = () => {};
  onLeave: (id: number) => void = () => {};
  onStatus: (status: NetStatus, detail?: string) => void = () => {};
  onRtc: (from: number, payload: unknown) => void = () => {}; // voice signaling (src/net/voice.ts)
  /** Someone else fired a paintball: origin, velocity, 24-bit rgb. */
  onPaint: (id: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, rgb: number) => void = () => {};
  /** Someone else launched fireworks: rows [ox,oy,oz,tx,ty,tz,T,pal,size]
   * (replayed locally by fireworks.launchRemote). */
  onFireworks: (id: number, rockets: number[][]) => void = () => {};
  /** Someone else sent a chat line (name is server-stamped from their roster). */
  onChat: (id: number, name: string, text: string) => void = () => {};
  /** Canonical server-ordered rake segment. Return true once a live sand
   *  simulation consumed it; false keeps it cached for lazy replay. */
  onRakeStamp: (stamp: SharedRakeStamp) => boolean = () => false;
  /** The relay restarted its in-memory sand session; reset the local field. */
  onRakeReset: () => void = () => {};
  /** relayed golf event from another player (k discriminates; see gameplay/golf) */
  onGolf: (id: number, msg: Record<string, unknown>) => void = () => {};
  /** Any accepted ownership change or welcome hydration. The tuple is a copy. */
  onPickleballSlots: (slots: readonly [number, number], authorityId: number) => void = () => {};
  /** Claim acknowledgement. On failure ownerId is the player holding the slot. */
  onPickleballClaim: (slot: PickleballSlot, ownerId: number, ok: boolean, authorityId: number) => void = () => {};
  /** Release acknowledgement / disconnect cleanup. */
  onPickleballRelease: (slot: PickleballSlot, ownerId: number, ok: boolean, authorityId: number) => void = () => {};
  /** Valid full-match snapshot from the current server-arbitrated authority. */
  onPickleballState: (ownerId: number, state: number[]) => void = () => {};
  /** Bounded controls from a side owner, delivered only to the match authority. */
  onPickleballInput: (slot: PickleballSlot, ownerId: number, input: number[]) => void = () => {};
  onEnsembleSlots: (slots: readonly [number, number, number]) => void = () => {};
  onEnsembleClaim: (slot: EnsembleSlot, ownerId: number, ok: boolean) => void = () => {};
  onEnsembleRelease: (slot: EnsembleSlot, ownerId: number, ok: boolean) => void = () => {};
  onEnsembleNote: (slot: EnsembleSlot, ownerId: number, step: number, velocity: number) => void = () => {};

  #ws: WebSocket | null = null;
  #url: string;
  #retryMs = 1000;
  #closed = false;
  #sendAt = 0;
  #lastSent = "";
  #lastSentAt = 0;
  #avatar: AvatarTraits | null;
  #board: BoardConfig | null;
  #scooter: ScooterConfig | null;
  #surfboard: SurfboardConfig | null;
  #car: CarConfig | null;
  #rakeSession = "";
  #rakeHistory: SequencedRakeStamp[] = [];
  #lastAppliedRakeSequence = 0;
  #pendingRakeRows: number[][] = [];
  #rakeFlushTimer: number | null = null;
  // serverTs → local-clock mapping (EWMA of arrival offset; interp buffer
  // absorbs the residual jitter)
  #clockOffset: number | null = null;

  constructor(
    name = pickName(),
    avatar?: AvatarTraits,
    board?: BoardConfig,
    scooter?: ScooterConfig,
    surfboard?: SurfboardConfig,
    car?: CarConfig
  ) {
    this.name = name;
    this.#avatar = avatar ? normalizeAvatarTraits(avatar) : null;
    this.#board = board ? normalizeBoardConfig(board) : null;
    this.#scooter = scooter ? normalizeScooterConfig(scooter) : null;
    this.#surfboard = surfboard ? normalizeSurfboardConfig(surfboard) : null;
    this.#car = car ? normalizeCarConfig(car) : null;
    const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.#url = envUrl || `${proto}://${location.host}/ws`;
    this.#connect();
  }

  #adoptRakeSession(raw: unknown): boolean {
    const session = typeof raw === "string" ? raw.slice(0, 80) : "";
    if (!session) return false;
    if (!this.#rakeSession) {
      this.#rakeSession = session;
      // A delayed first connection can follow offline local raking. Reset if
      // the lazy simulation already exists so the server session remains the
      // one shared source of truth; before construction this is a no-op.
      this.onRakeReset();
      return true;
    }
    if (session === this.#rakeSession) return true;
    this.#rakeSession = session;
    this.#rakeHistory.length = 0;
    this.#lastAppliedRakeSequence = 0;
    this.onRakeReset();
    return true;
  }

  #rememberRake(stamp: SequencedRakeStamp) {
    const last = this.#rakeHistory[this.#rakeHistory.length - 1];
    if (last && stamp.sequence <= last.sequence) return;
    this.#rakeHistory.push(stamp);
    if (this.#rakeHistory.length > RAKE_HISTORY_MAX) this.#rakeHistory.shift();
  }

  #hydrateRakes(raw: unknown) {
    if (!raw || typeof raw !== "object") return;
    const data = raw as { session?: unknown; stamps?: unknown };
    if (!this.#adoptRakeSession(data.session) || !Array.isArray(data.stamps)) return;
    for (const value of data.stamps) {
      const row = rakeWireRow(value, true);
      if (row) this.#rememberRake(rakeStampFromRow(row, true));
    }
    this.replayRakeStamps();
  }

  #flushRakeRows() {
    if (this.#rakeFlushTimer !== null) {
      window.clearTimeout(this.#rakeFlushTimer);
      this.#rakeFlushTimer = null;
    }
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.selfId) return;
    const rows = this.#pendingRakeRows.splice(0, RAKE_BATCH_MAX);
    if (rows.length) ws.send(JSON.stringify({ t: "rake", d: rows }));
    if (this.#pendingRakeRows.length) this.#scheduleRakeFlush(0);
  }

  #scheduleRakeFlush(delay = RAKE_BATCH_DELAY_MS) {
    if (this.#rakeFlushTimer !== null) return;
    this.#rakeFlushTimer = window.setTimeout(() => this.#flushRakeRows(), delay);
  }

  #applyPendingRakesLocally() {
    if (this.#rakeFlushTimer !== null) {
      window.clearTimeout(this.#rakeFlushTimer);
      this.#rakeFlushTimer = null;
    }
    const rows = this.#pendingRakeRows.splice(0);
    for (const row of rows) this.onRakeStamp(rakeStampFromRow(row, false));
  }

  #emitPickleballSlots() {
    this.onPickleballSlots([this.pickleballSlots[0], this.pickleballSlots[1]], this.pickleballAuthority);
  }

  #emitEnsembleSlots() {
    this.onEnsembleSlots([
      this.ensembleSlots[0],
      this.ensembleSlots[1],
      this.ensembleSlots[2]
    ]);
  }

  #resetEnsemble(notify = true) {
    this.ensembleSlots[0] = 0;
    this.ensembleSlots[1] = 0;
    this.ensembleSlots[2] = 0;
    if (notify) this.#emitEnsembleSlots();
  }

  #hydrateEnsemble(raw: unknown) {
    this.#resetEnsemble(false);
    if (raw && typeof raw === "object") {
      const slots = Array.isArray((raw as { slots?: unknown }).slots)
        ? (raw as { slots: unknown[] }).slots
        : [];
      for (const slot of [0, 1, 2] as const) {
        const ownerId = pickleballOwner(slots[slot]);
        this.ensembleSlots[slot] = ownerId === this.selfId || this.roster.has(ownerId) ? ownerId : 0;
      }
    }
    this.#emitEnsembleSlots();
  }

  #dropEnsembleOwner(ownerId: number) {
    for (const slot of [0, 1, 2] as const) {
      if (this.ensembleSlots[slot] !== ownerId) continue;
      this.ensembleSlots[slot] = 0;
      this.onEnsembleRelease(slot, ownerId, true);
      this.#emitEnsembleSlots();
    }
  }

  #refreshPickleballAuthority(advertised?: unknown) {
    const derived = this.pickleballSlots[0] || this.pickleballSlots[1];
    const announced = pickleballOwner(advertised);
    const next = announced === derived ? announced : derived;
    if (next !== this.pickleballAuthority || (this.pickleballState && this.pickleballState.id !== next)) {
      this.pickleballState = null;
    }
    this.pickleballAuthority = next;
  }

  #dropPickleballOwner(ownerId: number, notify = true) {
    for (const slot of [0, 1] as const) {
      if (this.pickleballSlots[slot] !== ownerId) continue;
      this.pickleballSlots[slot] = 0;
      this.#refreshPickleballAuthority();
      if (notify) this.onPickleballRelease(slot, ownerId, true, this.pickleballAuthority);
      this.#emitPickleballSlots();
    }
  }

  #resetPickleball(notify = true) {
    if (!notify) {
      this.pickleballSlots[0] = 0;
      this.pickleballSlots[1] = 0;
      this.pickleballAuthority = 0;
      this.pickleballState = null;
      return;
    }
    for (const slot of [0, 1] as const) {
      const ownerId = this.pickleballSlots[slot];
      if (!ownerId) continue;
      this.pickleballSlots[slot] = 0;
      this.#refreshPickleballAuthority();
      this.onPickleballRelease(slot, ownerId, true, this.pickleballAuthority);
      this.#emitPickleballSlots();
    }
    this.pickleballState = null;
  }

  #hydratePickleball(raw: unknown) {
    this.#resetPickleball(false);
    if (!raw || typeof raw !== "object") {
      this.#emitPickleballSlots();
      return;
    }
    const data = raw as { slots?: unknown; authority?: unknown; state?: unknown };
    const slots = Array.isArray(data.slots) ? data.slots : [];
    for (const slot of [0, 1] as const) {
      const ownerId = pickleballOwner(slots[slot]);
      this.pickleballSlots[slot] = ownerId === this.selfId || this.roster.has(ownerId) ? ownerId : 0;
    }
    this.#refreshPickleballAuthority(data.authority);
    if (data.state && typeof data.state === "object") {
      const entry = data.state as { id?: unknown; d?: unknown };
      const ownerId = pickleballOwner(entry.id);
      const state = pickleballNumbers(entry.d, PICKLEBALL_STATE_MAX);
      if (state && ownerId > 0 && ownerId === this.pickleballAuthority) {
        this.pickleballState = { id: ownerId, d: state };
      }
    }
    this.#emitPickleballSlots();
  }

  #connect() {
    if (this.#closed) return;
    this.#setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.#url);
    } catch {
      this.#scheduleRetry();
      return;
    }
    this.#ws = ws;
    ws.onopen = () => {
      this.#retryMs = 1000;
      ws.send(
        JSON.stringify({
          t: "hi",
          name: this.name,
          avatar: this.#avatar,
          board: this.#board,
          scooter: this.#scooter,
          surfboard: this.#surfboard,
          car: this.#car
        })
      );
    };
    ws.onmessage = (ev) => this.#handle(String(ev.data));
    ws.onclose = () => {
      this.#ws = null;
      // Segments accepted just before disconnect have not been applied locally
      // yet because online play waits for the server's canonical echo.
      this.#applyPendingRakesLocally();
      // Clear identity before synthetic slot-release notifications so the app
      // can keep an already-controlled side alive as an offline AI match and
      // reclaim it after reconnect, instead of treating disconnect as a leave.
      this.selfId = 0;
      this.#resetPickleball();
      this.#resetEnsemble();
      if (this.roster.size) {
        for (const id of [...this.roster.keys()]) {
          this.roster.delete(id);
          this.onLeave(id);
        }
        this.onRoster();
      }
      this.golfStates.clear();
      if (this.status !== "full") this.#setStatus("offline");
      this.#scheduleRetry();
    };
    ws.onerror = () => ws.close();
  }

  #scheduleRetry() {
    if (this.#closed) return;
    setTimeout(() => this.#connect(), this.#retryMs);
    this.#retryMs = Math.min(this.#retryMs * 2, 15000);
  }

  #setStatus(s: NetStatus, detail?: string) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s, detail);
  }

  #handle(raw: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.t) {
      case "welcome": {
        this.selfId = msg.id as number;
        this.selfHue = msg.hue as number;
        this.name = msg.name as string; // server-sanitized
        for (const p of msg.players as RemoteInfo[]) {
          this.roster.set(p.id, {
            ...p,
            avatar: rosterAvatar(p.id, p.avatar),
            board: rosterBoard(p.id, p.board),
            scooter: rosterScooter(p.id, p.scooter),
            surfboard: rosterSurfboard(p.id, p.surfboard),
            car: rosterCar(p.id, p.car)
          });
          if (p.golf) this.golfStates.set(p.id, p.golf);
        }
        this.#hydratePickleball(msg.pickle);
        this.#hydrateRakes(msg.sand);
        this.#hydrateEnsemble(msg.ensemble);
        this.#setStatus("online");
        this.onRoster();
        this.onWelcome();
        break;
      }
      case "join": {
        this.roster.set(msg.id as number, {
          id: msg.id as number,
          name: msg.name as string,
          hue: msg.hue as number,
          avatar: rosterAvatar(msg.id as number, msg.avatar),
          board: rosterBoard(msg.id as number, msg.board),
          scooter: rosterScooter(msg.id as number, msg.scooter),
          surfboard: rosterSurfboard(msg.id as number, msg.surfboard),
          car: rosterCar(msg.id as number, msg.car)
        });
        this.onRoster();
        this.onJoin(msg.id as number, String(msg.name));
        break;
      }
      case "leave": {
        const id = msg.id as number;
        this.golfStates.delete(id);
        this.#dropPickleballOwner(id);
        this.#dropEnsembleOwner(id);
        this.roster.delete(id);
        this.onLeave(id);
        this.onRoster();
        break;
      }
      case "name": {
        const p = this.roster.get(msg.id as number);
        if (p) {
          p.name = String(msg.name);
          this.onRoster();
        }
        break;
      }
      case "avatar": {
        const p = this.roster.get(msg.id as number);
        if (p) {
          p.avatar = normalizeAvatarTraits(msg.avatar);
          this.onRoster();
        }
        break;
      }
      case "board": {
        const p = this.roster.get(msg.id as number);
        if (p) {
          p.board = rosterBoard(p.id, msg.board);
          this.onRoster();
        }
        break;
      }
      case "scooter": {
        const p = this.roster.get(msg.id as number);
        if (p) {
          p.scooter = rosterScooter(p.id, msg.scooter);
          this.onRoster();
        }
        break;
      }
      case "surfboard": {
        const p = this.roster.get(msg.id as number);
        if (p) {
          p.surfboard = rosterSurfboard(p.id, msg.surfboard);
          this.onRoster();
        }
        break;
      }
      case "car": {
        const p = this.roster.get(msg.id as number);
        if (p) {
          p.car = rosterCar(p.id, msg.car);
          this.onRoster();
        }
        break;
      }
      case "snap": {
        const now = performance.now();
        const ts = msg.ts as number;
        // first snapshot pins the mapping; afterwards drift-correct slowly
        const off = now - ts;
        this.#clockOffset = this.#clockOffset === null ? off : this.#clockOffset * 0.95 + off * 0.05;
        const tLocal = ts + this.#clockOffset;
        for (const row of msg.ps as number[][]) {
          const [id, m, x, y, z, qx, qy, qz, qw, speed] = row;
          if (id === this.selfId || !this.roster.has(id)) continue;
          let rake: GardenRakeMotion | undefined;
          if (
            row.length === 21 &&
            (row[11] === 0 || row[11] === 1) &&
            (row[12] === 0 || row[12] === 1) &&
            row.slice(13, 16).every((n) => finiteRakeMotion(n)) &&
            row.slice(16, 18).every((n) => finiteRakeMotion(n, 2)) &&
            row.slice(18, 21).every((n) => finiteRakeMotion(n, 2))
          ) {
            rake = {
              engaged: row[11] === 1,
              dragging: row[12] === 1,
              contactX: row[13],
              contactY: row[14],
              contactZ: row[15],
              pullX: row[16],
              pullZ: row[17],
              normalX: row[18],
              normalY: row[19],
              normalZ: row[20]
            };
          }
          this.onSample(id, {
            t: tLocal,
            mode: NET_MODES[m] ?? "walk",
            x,
            y,
            z,
            qx,
            qy,
            qz,
            qw,
            speed,
            ride: row[10] || undefined,
            rideSeat: row.length === 12 ? row[11] || undefined : undefined,
            rake
          });
        }
        break;
      }
      case "full": {
        this.#setStatus("full", "Server is full — retrying");
        break;
      }
      case "rtc": {
        this.onRtc(msg.from as number, msg.payload);
        break;
      }
      case "paint": {
        const id = msg.id as number;
        const d = msg.d as number[];
        if (id !== this.selfId && this.roster.has(id) && Array.isArray(d) && d.length === 7) {
          this.onPaint(id, d[0], d[1], d[2], d[3], d[4], d[5], d[6]);
        }
        break;
      }
      case "fw": {
        const id = msg.id as number;
        const d = msg.d as number[][];
        if (id !== this.selfId && this.roster.has(id) && Array.isArray(d)) {
          const rows = d.filter((r) => Array.isArray(r) && r.length === 9 && r.every((n) => Number.isFinite(n)));
          if (rows.length) this.onFireworks(id, rows);
        }
        break;
      }
      case "chat": {
        const id = msg.id as number;
        const name = String(msg.name ?? "");
        const text = String(msg.text ?? "");
        if (id !== this.selfId && this.roster.has(id) && name && text) this.onChat(id, name, text);
        break;
      }
      case "rake": {
        if (!this.#adoptRakeSession(msg.session) || !Array.isArray(msg.d)) break;
        for (const value of msg.d.slice(0, RAKE_BATCH_MAX)) {
          const row = rakeWireRow(value, true);
          if (!row) continue;
          const stamp = rakeStampFromRow(row, true);
          this.#rememberRake(stamp);
          if (stamp.sequence <= this.#lastAppliedRakeSequence) continue;
          if (this.onRakeStamp(stamp)) this.#lastAppliedRakeSequence = stamp.sequence;
        }
        break;
      }
      case "golf": {
        const id = msg.id as number;
        if (id !== this.selfId && this.roster.has(id) && typeof msg.k === "string") {
          if (
            msg.k === "state" &&
            Array.isArray(msg.d) &&
            typeof msg.h === "number" &&
            typeof msg.p === "number" &&
            typeof msg.s === "number" &&
            typeof msg.r === "number"
          ) {
            this.golfStates.set(id, { d: msg.d as number[], h: msg.h, p: msg.p, s: msg.s, r: msg.r });
          } else if (msg.k === "quit") {
            this.golfStates.delete(id);
          }
          this.onGolf(id, msg);
        }
        break;
      }
      case "pickle": {
        if (typeof msg.k !== "string") break;
        const ownerId = pickleballOwner(msg.id);
        if (msg.k === "claim" && isPickleballSlot(msg.slot)) {
          const slot = msg.slot;
          const ok = msg.ok === true;
          if (ok && ownerId > 0 && (ownerId === this.selfId || this.roster.has(ownerId))) {
            this.pickleballSlots[slot] = ownerId;
            this.#refreshPickleballAuthority(msg.authority);
            this.#emitPickleballSlots();
          }
          this.onPickleballClaim(slot, ownerId, ok, this.pickleballAuthority);
        } else if (msg.k === "release" && isPickleballSlot(msg.slot)) {
          const slot = msg.slot;
          const ok = msg.ok === true;
          if (ok && this.pickleballSlots[slot] === ownerId) {
            this.pickleballSlots[slot] = 0;
            this.#refreshPickleballAuthority(msg.authority);
            this.#emitPickleballSlots();
          }
          this.onPickleballRelease(slot, ownerId, ok, this.pickleballAuthority);
        } else if (msg.k === "state") {
          const state = pickleballNumbers(msg.d, PICKLEBALL_STATE_MAX);
          if (!state || ownerId === 0 || ownerId !== this.pickleballAuthority || !this.roster.has(ownerId)) break;
          this.pickleballState = { id: ownerId, d: state };
          this.onPickleballState(ownerId, state.slice());
        } else if (msg.k === "input" && isPickleballSlot(msg.slot)) {
          const input = pickleballNumbers(msg.d, PICKLEBALL_INPUT_MAX);
          if (
            !input ||
            ownerId === 0 ||
            this.selfId !== this.pickleballAuthority ||
            this.pickleballSlots[msg.slot] !== ownerId ||
            !this.roster.has(ownerId)
          )
            break;
          this.onPickleballInput(msg.slot, ownerId, input);
        }
        break;
      }
      case "ensemble": {
        if (typeof msg.k !== "string" || !isEnsembleSlot(msg.slot)) break;
        const slot = msg.slot;
        const ownerId = pickleballOwner(msg.id);
        if (msg.k === "claim") {
          const ok = msg.ok === true;
          if (ok && ownerId > 0 && (ownerId === this.selfId || this.roster.has(ownerId))) {
            this.ensembleSlots[slot] = ownerId;
            this.#emitEnsembleSlots();
          }
          this.onEnsembleClaim(slot, ownerId, ok);
        } else if (msg.k === "release") {
          const ok = msg.ok === true;
          if (ok && this.ensembleSlots[slot] === ownerId) {
            this.ensembleSlots[slot] = 0;
            this.#emitEnsembleSlots();
          }
          this.onEnsembleRelease(slot, ownerId, ok);
        } else if (
          msg.k === "note" &&
          ownerId !== this.selfId &&
          this.roster.has(ownerId) &&
          this.ensembleSlots[slot] === ownerId &&
          Number.isInteger(msg.step) &&
          (msg.step as number) >= 0 &&
          (msg.step as number) <= 7 &&
          typeof msg.velocity === "number" &&
          Number.isFinite(msg.velocity)
        ) {
          this.onEnsembleNote(slot, ownerId, msg.step as number, Math.min(1, Math.max(0, msg.velocity)));
        }
        break;
      }
    }
  }

  /** Broadcast one paintball shot (origin, velocity, packed 24-bit color). */
  sendPaint(pos: THREE.Vector3, vel: THREE.Vector3, rgb: number) {
    if (this.#ws?.readyState !== WebSocket.OPEN || !this.selfId) return;
    const d = [
      Math.round(pos.x * 100) / 100,
      Math.round(pos.y * 100) / 100,
      Math.round(pos.z * 100) / 100,
      Math.round(vel.x * 100) / 100,
      Math.round(vel.y * 100) / 100,
      Math.round(vel.z * 100) / 100,
      rgb
    ];
    this.#ws.send(JSON.stringify({ t: "paint", d }));
  }

  /** Broadcast one fireworks volley (rows [ox,oy,oz,tx,ty,tz,T,pal,size]).
   * Chunked so a cranked 200-rocket volley stays under the relay's 16 KB
   * message cap. */
  sendFireworks(rockets: number[][]) {
    if (this.#ws?.readyState !== WebSocket.OPEN || !this.selfId) return;
    for (let i = 0; i < rockets.length; i += 64) {
      this.#ws.send(JSON.stringify({ t: "fw", d: rockets.slice(i, i + 64) }));
    }
  }

  /** Broadcast one golf event (swing / ball snapshot / rest / score / quit).
   * Fire-and-forget like paint — the sender's sim is authoritative for its ball. */
  sendGolf(msg: Record<string, unknown>) {
    if (this.#ws?.readyState !== WebSocket.OPEN || !this.selfId) return;
    this.#ws.send(JSON.stringify({ t: "golf", ...msg }));
  }

  /** Replay cached peer state after the deferred golf module becomes available. */
  replayGolf() {
    for (const [id, state] of this.golfStates) {
      if (!this.roster.has(id)) continue;
      this.onGolf(id, { t: "golf", id, k: "state", ...state });
    }
  }

  /** Ask the relay to reserve one of the two court-side player slots. */
  claimPickleball(slot: PickleballSlot) {
    if (!isPickleballSlot(slot) || this.#ws?.readyState !== WebSocket.OPEN || !this.selfId) return;
    this.#ws.send(JSON.stringify({ t: "pickle", k: "claim", slot }));
  }

  /** Release a court side. The relay ignores releases from non-owners. */
  releasePickleball(slot: PickleballSlot) {
    if (!isPickleballSlot(slot) || this.#ws?.readyState !== WebSocket.OPEN || !this.selfId) return;
    this.#ws.send(JSON.stringify({ t: "pickle", k: "release", slot }));
  }

  /** Publish a compact full-match snapshot when this client is authority. */
  sendPickleballState(state: readonly number[]) {
    if (this.#ws?.readyState !== WebSocket.OPEN || !this.selfId || this.pickleballAuthority !== this.selfId) return;
    const d = pickleballNumbers(state, PICKLEBALL_STATE_MAX);
    if (!d) return;
    this.#ws.send(JSON.stringify({ t: "pickle", k: "state", d }));
  }

  /** Send compact controls for a side this client owns to match authority. */
  sendPickleballInput(slot: PickleballSlot, input: readonly number[]) {
    if (
      !isPickleballSlot(slot) ||
      this.#ws?.readyState !== WebSocket.OPEN ||
      !this.selfId ||
      this.pickleballSlots[slot] !== this.selfId
    )
      return;
    const d = pickleballNumbers(input, PICKLEBALL_INPUT_MAX);
    if (!d) return;
    this.#ws.send(JSON.stringify({ t: "pickle", k: "input", slot, d }));
  }

  /** Replay the server-cached match snapshot after lazy gameplay initialization. */
  replayPickleball() {
    const state = this.pickleballState;
    if (!state || state.id !== this.pickleballAuthority) return;
    this.onPickleballState(state.id, state.d.slice());
  }

  /** Queue one local sand segment for a small ordered relay batch. The sender
   * also waits for the echo, so every participant applies concurrent strokes
   * in the same server-defined order. */
  sendRakeStamp(stamp: Readonly<SharedRakeStamp>): boolean {
    if (this.#ws?.readyState !== WebSocket.OPEN || !this.selfId) return false;
    const row = rakeRowFromStamp(stamp);
    if (!row) return false;
    this.#pendingRakeRows.push(row);
    if (this.#pendingRakeRows.length >= RAKE_BATCH_MAX) this.#flushRakeRows();
    else this.#scheduleRakeFlush();
    return true;
  }

  /** Replay relay-cached strokes after the lazy Tea Garden simulation exists. */
  replayRakeStamps() {
    for (const stamp of this.#rakeHistory) {
      if (stamp.sequence <= this.#lastAppliedRakeSequence) continue;
      if (!this.onRakeStamp(stamp)) break;
      this.#lastAppliedRakeSequence = stamp.sequence;
    }
  }

  /** Reserve one Fort Mason instrument. A player may own at most one station. */
  claimEnsemble(slot: EnsembleSlot) {
    if (!isEnsembleSlot(slot) || this.#ws?.readyState !== WebSocket.OPEN || !this.selfId) return;
    this.#ws.send(JSON.stringify({ t: "ensemble", k: "claim", slot }));
  }

  releaseEnsemble(slot: EnsembleSlot) {
    if (!isEnsembleSlot(slot) || this.#ws?.readyState !== WebSocket.OPEN || !this.selfId) return;
    this.#ws.send(JSON.stringify({ t: "ensemble", k: "release", slot }));
  }

  /** The relay accepts only the shared eight-step scale, never raw pitch data. */
  sendEnsembleNote(slot: EnsembleSlot, step: number, velocity: number) {
    if (
      !isEnsembleSlot(slot) ||
      this.#ws?.readyState !== WebSocket.OPEN ||
      !this.selfId ||
      this.ensembleSlots[slot] !== this.selfId ||
      !Number.isInteger(step) ||
      step < 0 ||
      step > 7 ||
      !Number.isFinite(velocity)
    ) return;
    this.#ws.send(JSON.stringify({
      t: "ensemble",
      k: "note",
      slot,
      step,
      velocity: Math.round(Math.min(1, Math.max(0, velocity)) * 100) / 100
    }));
  }

  /** Broadcast one chat line (server sanitizes + stamps name; no persistence). */
  sendChat(text: string) {
    if (this.#ws?.readyState !== WebSocket.OPEN || !this.selfId) return;
    const clean = text.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, CHAT_MAX);
    if (!clean) return;
    this.#ws.send(JSON.stringify({ t: "chat", text: clean }));
  }

  /** Voice signaling: relay `payload` (SDP/ICE) to one peer through the server. */
  sendRtc(to: number, payload: unknown) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify({ t: "rtc", to, payload }));
  }

  /** Rename (persisted + broadcast). Called by the user panel. */
  setName(name: string) {
    const clean = cleanName(name);
    const isCustom = clean.length > 0 && !needsFunName(clean);
    const normalized = isCustom ? clean : pickGeneratedName();
    this.name = normalized;
    if (isCustom) saveCustomName(normalized);
    else clearCustomName();
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify({ t: "name", name: normalized }));
  }

  setAvatar(avatar: AvatarTraits) {
    this.#avatar = normalizeAvatarTraits(avatar);
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify({ t: "avatar", avatar: this.#avatar }));
  }

  setBoard(board: BoardConfig) {
    this.#board = normalizeBoardConfig(board);
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify({ t: "board", board: this.#board }));
  }

  setScooter(scooter: ScooterConfig) {
    this.#scooter = normalizeScooterConfig(scooter);
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify({ t: "scooter", scooter: this.#scooter }));
  }

  setSurfboard(surfboard: SurfboardConfig) {
    this.#surfboard = normalizeSurfboardConfig(surfboard);
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ t: "surfboard", surfboard: this.#surfboard }));
    }
  }

  setCar(car: CarConfig) {
    this.#car = normalizeCarConfig(car);
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ t: "car", car: this.#car }));
    }
  }

  /**
   * Push my pose, throttled to SEND_HZ and deduplicated while standing still
   * (a keepalive copy still goes out every KEEPALIVE_MS so the server's idle
   * timer sees a live player). Call once per rendered frame.
   */
  sendState(
    mode: PlayerMode,
    pos: THREE.Vector3,
    quat: THREE.Quaternion,
    speed: number,
    ride = 0,
    rideSeat = 0,
    rake?: Readonly<GardenRakeMotion> | null
  ) {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.selfId) return;
    const now = performance.now();
    if (now < this.#sendAt) return;
    this.#sendAt = now + 1000 / SEND_HZ;
    const d = [
      NET_MODES.indexOf(mode),
      Math.round(pos.x * 100) / 100,
      Math.round(pos.y * 100) / 100,
      Math.round(pos.z * 100) / 100,
      Math.round(quat.x * 1000) / 1000,
      Math.round(quat.y * 1000) / 1000,
      Math.round(quat.z * 1000) / 1000,
      Math.round(quat.w * 1000) / 1000,
      Math.round(speed * 10) / 10
    ];
    if (rake && mode === "walk") {
      // Presence rows keep the old compact 9/10-value shape until a rake is
      // actually held. A held row has an explicit ride slot followed by the
      // exact contact frame used by the sand brush.
      d.push(
        ride,
        rake.engaged ? 1 : 0,
        rake.dragging ? 1 : 0,
        Math.round(rake.contactX * 1000) / 1000,
        Math.round(rake.contactY * 1000) / 1000,
        Math.round(rake.contactZ * 1000) / 1000,
        Math.round(rake.pullX * 10_000) / 10_000,
        Math.round(rake.pullZ * 10_000) / 10_000,
        Math.round(rake.normalX * 10_000) / 10_000,
        Math.round(rake.normalY * 10_000) / 10_000,
        Math.round(rake.normalZ * 10_000) / 10_000
      );
    } else if (ride) {
      const capacity = ride < 0 ? MAX_WORLD_RIDE_SEAT : MAX_PLAYER_RIDE_SEAT;
      d.push(ride, Math.max(1, Math.min(capacity, Math.round(rideSeat || 1))));
    }
    const key = d.join(",");
    if (key === this.#lastSent && now - this.#lastSentAt < KEEPALIVE_MS) return;
    this.#lastSent = key;
    this.#lastSentAt = now;
    ws.send(JSON.stringify({ t: "s", d }));
  }

  dispose() {
    this.#closed = true;
    this.#applyPendingRakesLocally();
    this.#ws?.close();
  }
}
