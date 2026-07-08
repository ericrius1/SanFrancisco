// Ship the overnight-trained brain pool to the live relay, so players joining
// tomorrow meet an already-competent, city-wide fleet (and it keeps improving as
// this is re-run through the night). Connects as a normal client; if it is the
// lowest-id (i.e. the leader — true when nobody else is on) the relay accepts and
// persists the brains, re-serving them to every future joiner via `welcome`.
//
// Run: node tools/push-brains-to-prod.mjs [checkpoint.json] [wss://host/ws]
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "../node_modules/ws/wrapper.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CKPT = process.argv[2] || path.join(ROOT, "tools", "aicars-trained.json");
const WS = process.argv[3] || process.env.SF_WS || "wss://sanfrancisco.up.railway.app/ws";

const blob = JSON.parse(readFileSync(CKPT, "utf8"));
if (blob.v !== 2 || !Array.isArray(blob.cars) || !blob.cars.length) {
  console.error("bad checkpoint:", CKPT);
  process.exit(1);
}
const cars = blob.cars;
console.log(`[push] ${cars.length} brains from ${path.basename(CKPT)} → ${WS}`);

const ws = new WebSocket(WS, { maxPayload: 1 << 20 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let selfId = 0;

ws.on("open", () => ws.send(JSON.stringify({ t: "hi", name: "night-trainer", avatar: null })));

ws.on("message", async (raw) => {
  let m;
  try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.t !== "welcome") return;
  selfId = m.id;
  const others = (m.players || []).map((p) => p.id).filter((x) => x !== selfId);
  const minOther = others.length ? Math.min(...others) : Infinity;
  const leader = selfId < minOther;
  console.log(`[push] welcome id=${selfId}, others=[${others}], leader=${leader}`);
  if (!leader) {
    console.warn("[push] NOT leader — a lower-id client is connected; the relay will drop our brains. Aborting.");
    ws.close();
    process.exit(2);
  }
  // round-robin the pool, throttled well under the 80 msg/s relay budget
  for (let i = 0; i < cars.length; i++) {
    ws.send(JSON.stringify({ t: "brain", d: cars[i] }));
    await sleep(60);
  }
  await sleep(1500); // let the relay's debounced disk write settle
  console.log(`[push] sent ${cars.length} brains, done.`);
  ws.close();
  process.exit(0);
});

ws.on("error", (e) => { console.error("[push] ws error:", e.message); process.exit(3); });
setTimeout(() => { console.error("[push] timeout"); process.exit(4); }, 30000);
