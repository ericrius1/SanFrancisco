import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const PORT = 20_000 + (process.pid % 1000);
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
      this.messages.push(JSON.parse(String(raw)));
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
  const thrower = new Client("Ball Thrower");
  const friend = new Client("Ball Friend");
  clients.push(thrower, friend);
  await Promise.all([thrower.ready, friend.ready]);
  const throwerWelcome = await thrower.waitFor((message) => message.t === "welcome", "thrower welcome");
  const friendWelcome = await friend.waitFor((message) => message.t === "welcome", "friend welcome");

  const release = [373.24, 84.61, 2704.83, 4.5, 7.25, -12.75];
  const throwId = 41;
  thrower.send({ t: "ball", k: "throw", n: throwId, d: release });
  const relayed = await friend.waitFor(
    (message) => message.t === "ball" && message.k === "throw",
    "friend ball throw"
  );
  assert.equal(relayed.id, throwerWelcome.id, "relay did not stamp the thrower's id");
  assert.equal(relayed.n, throwId, "relay changed the stable throw id");
  assert.deepEqual(relayed.d, release, "relay changed the ball release state");

  await assert.rejects(
    thrower.waitFor((message) => message.t === "ball" && message.k === "throw", "sender ball echo", 200),
    /timed out/,
    "thrower should not receive its own locally spawned ball back"
  );

  friend.send({ t: "ball", k: "pickup", owner: throwerWelcome.id, n: throwId });
  const [ownerPickup, pickerPickup] = await Promise.all([
    thrower.waitFor((message) => message.t === "ball" && message.k === "pickup", "owner pickup result"),
    friend.waitFor((message) => message.t === "ball" && message.k === "pickup", "picker pickup result")
  ]);
  assert.deepEqual(ownerPickup, pickerPickup, "owner and picker received different transfer results");
  assert.equal(pickerPickup.ok, true, "valid pickup was rejected");
  assert.equal(pickerPickup.id, friendWelcome.id, "relay did not stamp the picker id");
  assert.equal(pickerPickup.owner, throwerWelcome.id, "relay changed the original owner id");
  assert.equal(pickerPickup.n, throwId, "relay changed the picked-up throw id");

  // The registry deletion is the arbitration point: a racing/duplicate request
  // gets a targeted rejection and can never mint a second held ball.
  friend.send({ t: "ball", k: "pickup", owner: throwerWelcome.id, n: throwId });
  const duplicate = await friend.waitFor(
    (message) => message.t === "ball" && message.k === "pickup" && message.ok === false,
    "duplicate pickup rejection"
  );
  assert.equal(duplicate.id, friendWelcome.id, "pickup rejection was stamped for another player");

  thrower.send({ t: "ball", k: "throw", n: 42, d: [1, 2, 3] });
  await assert.rejects(
    friend.waitFor(
      (message) => message.t === "ball" && message.k === "throw" && message.n === 42,
      "malformed ball relay",
      200
    ),
    /timed out/,
    "relay accepted a malformed ball packet"
  );

  console.log("multiplayer ball probe passed");
} finally {
  for (const client of clients) client.close();
  relay.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => relay.once("exit", resolve)),
    delay(2000).then(() => relay.kill("SIGKILL"))
  ]);
}
