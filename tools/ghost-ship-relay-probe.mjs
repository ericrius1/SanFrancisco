import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { WebSocket } from "ws";

const port = await new Promise((resolvePort, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return reject(new Error("no free relay port"));
    const value = address.port;
    server.close(() => resolvePort(value));
  });
});

const relay = spawn(process.execPath, ["server/server.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"]
});

const output = [];
relay.stdout.on("data", (chunk) => output.push(String(chunk)));
relay.stderr.on("data", (chunk) => output.push(String(chunk)));

function waitForRelay() {
  return new Promise((resolveReady, reject) => {
    const deadline = Date.now() + 10_000;
    const poll = () => {
      if (output.join("").includes("[sf-server] http://")) return resolveReady();
      if (relay.exitCode !== null) return reject(new Error(`relay exited ${relay.exitCode}: ${output.join("")}`));
      if (Date.now() >= deadline) return reject(new Error(`relay startup timed out: ${output.join("")}`));
      setTimeout(poll, 25);
    };
    poll();
  });
}

function nextMessage(ws, predicate, timeout = 5_000) {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("websocket message timed out"));
    }, timeout);
    const onMessage = (raw) => {
      const message = JSON.parse(String(raw));
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolveMessage(message);
    };
    ws.on("message", onMessage);
  });
}

const sockets = [];
try {
  await waitForRelay();
  for (const name of ["Ghost Captain", "Deck Witness"]) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(ws);
    await new Promise((resolveOpen, reject) => {
      ws.once("open", resolveOpen);
      ws.once("error", reject);
    });
    const welcome = nextMessage(ws, (message) => message.t === "welcome");
    ws.send(JSON.stringify({ t: "hi", name }));
    await welcome;
  }

  const captainIdMessage = nextMessage(sockets[0], (message) => message.t === "snap");
  sockets[0].send(JSON.stringify({
    t: "s",
    d: [0, 1, 2, 3, 0, 0, 0, 1, 0, -1001, 12]
  }));
  const firstSnap = await captainIdMessage;
  const captainRow = firstSnap.ps.find((row) => row[1] === 0 && row[10] === -1001);
  const captainId = captainRow?.[0];
  assert(Number.isInteger(captainId), "relay did not retain the public world-ride id");

  const witnessSnap = await nextMessage(
    sockets[1],
    (message) => message.t === "snap" && message.ps.some((row) => row[0] === captainId && row[11] === 12)
  );
  const witnessRow = witnessSnap.ps.find((row) => row[0] === captainId);
  assert.equal(witnessRow[10], -1001);
  assert.equal(witnessRow[11], 12);

  // Seat 13 is outside the public deck contract and must not replace state.
  sockets[0].send(JSON.stringify({
    t: "s",
    d: [0, 99, 2, 3, 0, 0, 0, 1, 0, -1001, 13]
  }));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 180));
  const afterInvalid = await nextMessage(
    sockets[1],
    (message) => message.t === "snap" && message.ps.some((row) => row[0] === captainId)
  );
  const retained = afterInvalid.ps.find((row) => row[0] === captainId);
  assert.equal(retained[1], 0, "invalid seat packet replaced the accepted mode");
  assert.equal(retained[2], 1, "invalid seat packet replaced the accepted position");
  assert.equal(retained[11], 12, "invalid seat packet replaced the accepted deck station");

  console.log("ghost ship relay: reserved ride id and deck stations 1..12 passed");
} finally {
  for (const socket of sockets) socket.close();
  relay.kill("SIGTERM");
}
