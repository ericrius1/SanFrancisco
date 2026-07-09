import type * as THREE from "three/webgpu";
import type { PlayerMode } from "../player/types";
import { avatarFromSeed, isDefaultAvatar, normalizeAvatarTraits, type AvatarTraits } from "../player/avatar";

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
 *   → {t:"hi", name, avatar}            on open
 *   ← {t:"welcome", id, hue, name, players:[{id,name,hue,avatar}]}
 *   ← {t:"join"|{t:"leave"}|{t:"name"}|{t:"avatar"} roster changes
 *   → {t:"s", d:[mode,x,y,z,qx,qy,qz,qw,speed,ride?]}   ~12 Hz while moving
 *   ← {t:"snap", ts, ps:[[id,...d]]}    batched world snapshot, ~12 Hz
 *   → {t:"rtc", to, payload}            voice signaling to one peer
 *   ← {t:"rtc", from, payload}          relayed with sender id stamped
 *   → {t:"paint", d:[x,y,z,vx,vy,vz,rgb]}  one paintball shot (fire-and-forget)
 *   ← {t:"paint", id, d}                relayed to everyone else
 *   → {t:"fw", d:[[ox,oy,oz,tx,ty,tz,T,pal,size],...]}  fireworks volley
 *   ← {t:"fw", id, d}                   relayed to everyone else
 *   → {t:"chat", text}                  ephemeral text chat (no persistence)
 *   ← {t:"chat", id, name, text}        relayed to everyone else
 *
 * Movement is client-authoritative by design: each browser runs its own
 * box3d world (destruction and all), so the server can only ever relay
 * poses. Fine for a co-op sandbox — there is nothing competitive to cheat at.
 */

/** Wire order for modes — index into this array is what goes over the socket. */
export const NET_MODES: PlayerMode[] = ["walk", "drive", "plane", "boat", "drone", "board", "bird"];

export type RemoteInfo = { id: number; name: string; hue: number; avatar?: AvatarTraits };

/**
 * One persistent AI car's full brain + identity + pose (continual-learning
 * "life" blob). Structurally identical to fleet.ts's CarBlob so it round-trips
 * through the leader→relay→ghost path without a conversion. Actor is 146 floats,
 * critic 133 (net shape [9,12,2] / [9,12,1]).
 */
export type CarLifeBlob = {
  v: 2;
  id: number;
  actor: number[];
  critic: number[];
  rhoBar: number;
  sigma: number;
  ageS: number;
  odoM: number;
  lessons: number;
  bodyKind: number;
  paintHue: number;
  x: number;
  z: number;
  heading: number;
};

/** The whole fleet's persisted lives (relay welcome / localStorage set). */
export type AiCarsLife = { v: 2; born: number; cars: CarLifeBlob[] };

const AICARS_ACTOR_LEN = 146;
const AICARS_CRITIC_LEN = 133;
const AICARS_MAX_ID = 47;
const AICARS_W_MAX = 16;

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
};

export type NetStatus = "connecting" | "online" | "offline" | "full";

const SEND_HZ = 12;
const KEEPALIVE_MS = 2000; // resend an unchanged pose this often (server idle-timer food)
const NAME_MAX = 20;
const CHAT_MAX = 200;
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

/** Finite-number array of an exact length with |w| bounded (weight vectors). */
function isWeightArray(a: unknown, len: number): a is number[] {
  if (!Array.isArray(a) || a.length !== len) return false;
  for (const n of a) if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > AICARS_W_MAX) return false;
  return true;
}

/** Validate one incoming AI-car life blob (from `brain` or a welcome set).
 * Mirrors the relay's strict gate so a poisoned blob can't reach the fleet even
 * if it slipped past the server. Returns null on anything malformed. */
function parseCarBlob(raw: unknown): CarLifeBlob | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 2) return null;
  if (!Number.isInteger(o.id) || (o.id as number) < 0 || (o.id as number) > AICARS_MAX_ID) return null;
  if (!isWeightArray(o.actor, AICARS_ACTOR_LEN)) return null;
  if (!isWeightArray(o.critic, AICARS_CRITIC_LEN)) return null;
  const fin = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (!fin(o.rhoBar) || !fin(o.sigma) || !fin(o.ageS) || !fin(o.odoM) || !fin(o.lessons)) return null;
  if (!fin(o.bodyKind) || !fin(o.paintHue) || !fin(o.x) || !fin(o.z) || !fin(o.heading)) return null;
  // range caps: reject wildly out-of-range numeric fields (poison / overflow).
  if (Math.abs(o.rhoBar as number) > 1e3) return null;
  if ((o.ageS as number) < 0 || (o.ageS as number) > 1e12) return null;
  if ((o.odoM as number) < 0 || (o.odoM as number) > 1e12) return null;
  if ((o.lessons as number) < 0 || (o.lessons as number) > 1e9) return null;
  return {
    v: 2,
    id: o.id as number,
    actor: o.actor as number[],
    critic: o.critic as number[],
    rhoBar: o.rhoBar as number,
    sigma: o.sigma as number,
    ageS: o.ageS as number,
    odoM: o.odoM as number,
    lessons: o.lessons as number,
    bodyKind: o.bodyKind as number,
    paintHue: o.paintHue as number,
    x: o.x as number,
    z: o.z as number,
    heading: o.heading as number
  };
}

/** Validate a whole AI-cars life set (the relay's saved fleet in `welcome`). */
function parseAiCarsLife(raw: unknown): AiCarsLife | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { v?: unknown; born?: unknown; cars?: unknown };
  if (o.v !== 2 || !Array.isArray(o.cars) || o.cars.length === 0) return null;
  const cars: CarLifeBlob[] = [];
  for (const c of o.cars) {
    const blob = parseCarBlob(c);
    if (blob) cars.push(blob);
  }
  if (cars.length === 0) return null;
  const born = typeof o.born === "number" && Number.isFinite(o.born) ? o.born : Date.now();
  return { v: 2, born, cars };
}

function rosterAvatar(id: number, raw: unknown): AvatarTraits {
  if (raw) {
    const traits = normalizeAvatarTraits(raw);
    if (!isDefaultAvatar(traits)) return traits;
  }
  return avatarFromSeed(id);
}

export class Net {
  /** My server-assigned identity (0 until welcomed). */
  selfId = 0;
  selfHue = 200;
  name: string;
  status: NetStatus = "connecting";
  /** Roster of everyone else, kept in lockstep with server join/leave. */
  readonly roster = new Map<number, RemoteInfo>();

  onRoster: () => void = () => {}; // any join/leave/rename (rebuild lists)
  onWelcome: () => void = () => {}; // assigned id + roster hydrated — push saved avatar
  onSample: (id: number, s: NetSample) => void = () => {};
  onLeave: (id: number) => void = () => {};
  onStatus: (status: NetStatus, detail?: string) => void = () => {};
  onRtc: (from: number, payload: unknown) => void = () => {}; // voice signaling (src/net/voice.ts)
  /** Someone else fired a paintball: origin, velocity, 24-bit rgb. */
  onPaint: (id: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, rgb: number) => void = () => {};
  /** Someone else played a museum instrument: (instrument, key). */
  onNote: (id: number, instrument: number, key: number) => void = () => {};
  /** Someone else launched fireworks: rows [ox,oy,oz,tx,ty,tz,T,pal,size]
   * (replayed locally by fireworks.launchRemote). */
  onFireworks: (id: number, rockets: number[][]) => void = () => {};
  /** Someone else sent a chat line (name is server-stamped from their roster). */
  onChat: (id: number, name: string, text: string) => void = () => {};
  /** AI-cars snapshot from the training leader (rows per netSync.serializeCars). */
  onCars: (id: number, rows: number[][]) => void = () => {};
  /** One AI car's brain/pose from the leader (round-robin `brain` broadcast). */
  onBrain: (blob: CarLifeBlob) => void = () => {};
  /** The whole AI-cars fleet the relay had saved when we joined (null if none). */
  aicarsLife: AiCarsLife | null = null;

  #ws: WebSocket | null = null;
  #url: string;
  #retryMs = 1000;
  #closed = false;
  #sendAt = 0;
  #lastSent = "";
  #lastSentAt = 0;
  #avatar: AvatarTraits | null;
  // serverTs → local-clock mapping (EWMA of arrival offset; interp buffer
  // absorbs the residual jitter)
  #clockOffset: number | null = null;

  constructor(name = pickName(), avatar?: AvatarTraits) {
    this.name = name;
    this.#avatar = avatar ? normalizeAvatarTraits(avatar) : null;
    const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.#url = envUrl || `${proto}://${location.host}/ws`;
    this.#connect();
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
      ws.send(JSON.stringify({ t: "hi", name: this.name, avatar: this.#avatar }));
    };
    ws.onmessage = (ev) => this.#handle(String(ev.data));
    ws.onclose = () => {
      this.#ws = null;
      this.selfId = 0;
      if (this.roster.size) {
        for (const id of [...this.roster.keys()]) {
          this.roster.delete(id);
          this.onLeave(id);
        }
        this.onRoster();
      }
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
          this.roster.set(p.id, { ...p, avatar: rosterAvatar(p.id, p.avatar) });
        }
        this.aicarsLife = parseAiCarsLife(msg.aicarsLife); // relay's saved fleet, if any
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
          avatar: rosterAvatar(msg.id as number, msg.avatar)
        });
        this.onRoster();
        break;
      }
      case "leave": {
        this.roster.delete(msg.id as number);
        this.onLeave(msg.id as number);
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
          this.onSample(id, { t: tLocal, mode: NET_MODES[m] ?? "walk", x, y, z, qx, qy, qz, qw, speed, ride: row[10] || undefined });
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
      case "note": {
        const id = msg.id as number;
        const d = msg.d as number[];
        if (id !== this.selfId && this.roster.has(id) && Array.isArray(d) && d.length === 2) {
          this.onNote(id, d[0], d[1]);
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
      case "cars": {
        const id = msg.id as number;
        const d = msg.d;
        if (id !== this.selfId && this.roster.has(id) && Array.isArray(d)) {
          const rows = d.filter((r) => Array.isArray(r) && r.every((n) => Number.isFinite(n)));
          if (rows.length) this.onCars(id, rows as number[][]);
        }
        break;
      }
      case "brain": {
        // one AI car's brain/pose from the training leader; the relay stamps the
        // sender as `from` and only forwards `brain` from the leader (lowest id).
        const from = msg.from as number;
        const blob = parseCarBlob(msg.d);
        if (from !== this.selfId && this.roster.has(from) && blob) this.onBrain(blob);
        break;
      }
      case "chat": {
        const id = msg.id as number;
        const name = String(msg.name ?? "");
        const text = String(msg.text ?? "");
        if (id !== this.selfId && this.roster.has(id) && name && text) this.onChat(id, name, text);
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

  /** Leader → everyone: one AI-cars snapshot (rows from netSync.serializeCars). */
  sendCars(rows: number[][]) {
    if (this.#ws?.readyState !== WebSocket.OPEN || !this.selfId) return;
    this.#ws.send(JSON.stringify({ t: "cars", d: rows }));
  }

  /** Leader → everyone: one AI car's full brain + pose (round-robin, relay
   * persists the latest per car id and re-serves the set on `welcome`). */
  sendBrain(blob: CarLifeBlob) {
    if (this.#ws?.readyState !== WebSocket.OPEN || !this.selfId) return;
    this.#ws.send(JSON.stringify({ t: "brain", d: blob }));
  }

  /** Broadcast one museum instrument note (instrument index, key index). */
  sendNote(instrument: number, key: number) {
    if (this.#ws?.readyState !== WebSocket.OPEN || !this.selfId) return;
    this.#ws.send(JSON.stringify({ t: "note", d: [instrument, key] }));
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

  /**
   * Push my pose, throttled to SEND_HZ and deduplicated while standing still
   * (a keepalive copy still goes out every KEEPALIVE_MS so the server's idle
   * timer sees a live player). Call once per rendered frame.
   */
  sendState(mode: PlayerMode, pos: THREE.Vector3, quat: THREE.Quaternion, speed: number, ride = 0) {
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
    if (ride) d.push(ride);
    const key = d.join(",");
    if (key === this.#lastSent && now - this.#lastSentAt < KEEPALIVE_MS) return;
    this.#lastSent = key;
    this.#lastSentAt = now;
    ws.send(JSON.stringify({ t: "s", d }));
  }

  dispose() {
    this.#closed = true;
    this.#ws?.close();
  }
}
