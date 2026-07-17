// Two-client contract test for Fort Mason ensemble seat arbitration + notes.
import WebSocket from "ws";

const URL = process.env.SF_RELAY_URL ?? "ws://127.0.0.1:8799/ws";
const timeout = (label) => new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), 5000));

function client(name) {
  const ws = new WebSocket(URL);
  const queue = [];
  const waiters = [];
  ws.on("message", (data) => {
    const message = JSON.parse(String(data));
    const index = waiters.findIndex((waiter) => waiter.match(message));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
    else queue.push(message);
  });
  const next = (match, label) => {
    const found = queue.findIndex(match);
    if (found >= 0) return Promise.resolve(queue.splice(found, 1)[0]);
    const pending = new Promise((resolve) => waiters.push({ match, resolve }));
    return Promise.race([pending, timeout(label)]);
  };
  return {
    ws,
    next,
    async welcome() {
      await new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      ws.send(JSON.stringify({ t: "hi", name }));
      return next((message) => message.t === "welcome", `${name} welcome`);
    },
    send(message) { ws.send(JSON.stringify(message)); },
    close() { ws.close(); }
  };
}

const a = client("Piano Test");
const welcomeA = await a.welcome();
const b = client("Steel Test");
const welcomeB = await b.welcome();
if (welcomeA.ensemble.slots.join(",") !== "0,0,0" || welcomeB.ensemble.slots.join(",") !== "0,0,0") {
  throw new Error("welcome did not hydrate three empty ensemble slots");
}

a.send({ t: "ensemble", k: "claim", slot: 0 });
const claimA = await a.next((m) => m.t === "ensemble" && m.k === "claim" && m.slot === 0, "piano claim");
if (!claimA.ok || claimA.id !== welcomeA.id) throw new Error(`bad piano claim: ${JSON.stringify(claimA)}`);

b.send({ t: "ensemble", k: "claim", slot: 1 });
const claimB = await b.next((m) => m.t === "ensemble" && m.k === "claim" && m.slot === 1, "steel claim");
if (!claimB.ok || claimB.id !== welcomeB.id) throw new Error(`bad steel claim: ${JSON.stringify(claimB)}`);

b.send({ t: "ensemble", k: "note", slot: 1, step: 4, velocity: 0.83 });
const note = await a.next((m) => m.t === "ensemble" && m.k === "note", "network note");
if (note.id !== welcomeB.id || note.slot !== 1 || note.step !== 4 || note.velocity !== 0.83) {
  throw new Error(`bad note relay: ${JSON.stringify(note)}`);
}

b.send({ t: "ensemble", k: "claim", slot: 2 });
const secondSeat = await b.next((m) => m.t === "ensemble" && m.k === "claim" && m.slot === 2, "second-seat denial");
if (secondSeat.ok !== false || secondSeat.id !== welcomeB.id) {
  throw new Error(`one-seat invariant failed: ${JSON.stringify(secondSeat)}`);
}

a.send({ t: "ensemble", k: "claim", slot: 1 });
const occupied = await a.next(
  (m) => m.t === "ensemble" && m.k === "claim" && m.slot === 1 && m.ok === false,
  "occupied denial"
);
if (occupied.ok !== false || occupied.id !== welcomeB.id) {
  throw new Error(`occupied-seat invariant failed: ${JSON.stringify(occupied)}`);
}

b.close();
const released = await a.next((m) => m.t === "ensemble" && m.k === "release" && m.slot === 1, "disconnect release");
if (!released.ok || released.id !== welcomeB.id) throw new Error(`disconnect cleanup failed: ${JSON.stringify(released)}`);
a.close();

console.log(JSON.stringify({
  ok: true,
  owners: { piano: welcomeA.id, steel: welcomeB.id },
  note: { slot: note.slot, step: note.step, velocity: note.velocity },
  deniedSecondSeat: true,
  deniedOccupiedSeat: true,
  disconnectReleased: true
}, null, 2));
