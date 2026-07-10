import type * as THREE from "three/webgpu";
import type { PlayerMode } from "../player/types";
import { avatarFromSeed, isDefaultAvatar, normalizeAvatarTraits, type AvatarTraits } from "../player/avatar";
import { boardFromSeed, isDefaultBoard, normalizeBoardConfig, type BoardConfig } from "../vehicles/board/config";

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
 *   → {t:"hi", name, avatar, board}      on open
 *   ← {t:"welcome", id, hue, name, players:[{id,name,hue,avatar,board}]}
 *   ← {t:"join"|{t:"leave"}|{t:"name"}|{t:"avatar"}|{t:"board"} roster changes
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
 * box3d world, so the server can only ever relay
 * poses. Fine for a co-op sandbox — there is nothing competitive to cheat at.
 */

/** Wire order for modes — index into this array is what goes over the socket. */
export const NET_MODES: PlayerMode[] = ["walk", "drive", "plane", "boat", "drone", "board", "bird"];

export type RemoteInfo = { id: number; name: string; hue: number; avatar?: AvatarTraits; board?: BoardConfig };

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
  /** Someone else launched fireworks: rows [ox,oy,oz,tx,ty,tz,T,pal,size]
   * (replayed locally by fireworks.launchRemote). */
  onFireworks: (id: number, rockets: number[][]) => void = () => {};
  /** Someone else sent a chat line (name is server-stamped from their roster). */
  onChat: (id: number, name: string, text: string) => void = () => {};

  #ws: WebSocket | null = null;
  #url: string;
  #retryMs = 1000;
  #closed = false;
  #sendAt = 0;
  #lastSent = "";
  #lastSentAt = 0;
  #avatar: AvatarTraits | null;
  #board: BoardConfig | null;
  // serverTs → local-clock mapping (EWMA of arrival offset; interp buffer
  // absorbs the residual jitter)
  #clockOffset: number | null = null;

  constructor(name = pickName(), avatar?: AvatarTraits, board?: BoardConfig) {
    this.name = name;
    this.#avatar = avatar ? normalizeAvatarTraits(avatar) : null;
    this.#board = board ? normalizeBoardConfig(board) : null;
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
      ws.send(JSON.stringify({ t: "hi", name: this.name, avatar: this.#avatar, board: this.#board }));
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
          this.roster.set(p.id, { ...p, avatar: rosterAvatar(p.id, p.avatar), board: rosterBoard(p.id, p.board) });
        }
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
          board: rosterBoard(msg.id as number, msg.board)
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
      case "board": {
        const p = this.roster.get(msg.id as number);
        if (p) {
          p.board = rosterBoard(p.id, msg.board);
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
