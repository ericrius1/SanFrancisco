import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const PORT = 19_000 + (process.pid % 1000);
const relay = spawn(process.execPath, ["server/server.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"]
});

let relayLog = "";
relay.stdout.on("data", (chunk) => (relayLog += chunk));
relay.stderr.on("data", (chunk) => (relayLog += chunk));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForRelay() {
  const deadline = Date.now() + 5000;
  while (!relayLog.includes("[sf-server] http://")) {
    if (relay.exitCode !== null) throw new Error(`relay exited ${relay.exitCode}\n${relayLog}`);
    if (Date.now() >= deadline) throw new Error(`relay did not start\n${relayLog}`);
    await delay(20);
  }
}

class Client {
  socket;
  messages = [];
  waiters = [];

  constructor(name) {
    this.socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    this.socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      this.messages.push(message);
      this.#drain();
    });
    this.ready = new Promise((resolve, reject) => {
      this.socket.once("open", () => {
        this.socket.send(JSON.stringify({ t: "hi", name }));
        resolve();
      });
      this.socket.once("error", reject);
    });
  }

  #drain() {
    for (let i = 0; i < this.waiters.length; i++) {
      const waiter = this.waiters[i];
      const index = this.messages.findIndex(waiter.predicate);
      if (index < 0) continue;
      clearTimeout(waiter.timer);
      this.waiters.splice(i--, 1);
      waiter.resolve(this.messages.splice(index, 1)[0]);
    }
  }

  waitFor(predicate, label, timeoutMs = 4000) {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new Error(`timed out waiting for ${label}; queued=${JSON.stringify(this.messages)}`));
        }, timeoutMs)
      };
      this.waiters.push(waiter);
    });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  close() {
    this.socket.close();
  }
}

const clients = [];
try {
  await waitForRelay();
  const a = new Client("Rake A");
  const b = new Client("Rake B");
  clients.push(a, b);
  await Promise.all([a.ready, b.ready]);
  const welcomeA = await a.waitFor((message) => message.t === "welcome", "A welcome");
  await b.waitFor((message) => message.t === "welcome", "B welcome");

  const state = [
    0,
    -2344,
    80,
    2166.5,
    0,
    0,
    0,
    1,
    1.2,
    0,
    1,
    1,
    -2344.2,
    79.12,
    2166.1,
    0,
    1,
    0,
    1,
    0
  ];
  const stroke = [-2344.3, 2166.3, -2344.2, 2166.1, 1, 0, 0, -1, 1];
  a.send({ t: "s", d: state });
  a.send({ t: "rake", d: [stroke] });

  const [echoA, echoB] = await Promise.all([
    a.waitFor((message) => message.t === "rake", "sender rake echo"),
    b.waitFor((message) => message.t === "rake", "peer rake echo")
  ]);
  assert.equal(echoA.session, echoB.session, "clients received different sand sessions");
  assert.deepEqual(echoA.d, echoB.d, "sender and peer received different ordered strokes");
  assert.deepEqual(echoA.d[0].slice(1), stroke, "relay changed valid stroke data");

  const snapshot = await b.waitFor(
    (message) =>
      message.t === "snap" &&
      message.ps.some((row) => row[0] === welcomeA.id && row.length === 21),
    "held-rake presence snapshot"
  );
  const rakePresence = snapshot.ps.find((row) => row[0] === welcomeA.id);
  assert.equal(rakePresence[11], 1, "engaged rake flag was not preserved");
  assert.equal(rakePresence[12], 1, "dragging rake flag was not preserved");

  const late = new Client("Rake Late");
  clients.push(late);
  await late.ready;
  const lateWelcome = await late.waitFor((message) => message.t === "welcome", "late welcome");
  assert.equal(lateWelcome.sand.session, echoA.session, "late join received another sand session");
  assert.deepEqual(
    lateWelcome.sand.stamps.at(-1),
    echoA.d[0],
    "late join did not receive the ordered shared stroke history"
  );

  console.log("multiplayer rake probe passed");
} finally {
  for (const client of clients) client.close();
  relay.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => relay.once("exit", resolve)),
    delay(2000).then(() => relay.kill("SIGKILL"))
  ]);
}
