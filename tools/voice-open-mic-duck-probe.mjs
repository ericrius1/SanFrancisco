// Real-browser contract for the open-mic world duck (src/net/voice.ts ->
// AudioEngine.setMicDuck).
//
// Anything our own speakers play while the microphone is live is echo that the
// browser's canceller has to remove before the far end hears us, and it cannot
// do that for a loud sustained bed: an AEC models a LINEAR echo path, while a
// laptop speaker reproducing a 59 Hz drone is anything but. Riding the
// hoverboard puts exactly that drone at the top of the mix, which is why voice
// chat crackled for the far end while a player was on the board.
//
// So: two real peers on a live call, page A riding the board, master bus
// recorded with A's mic off vs on. Pass = the world's spill drops hard while
// transmitting and the voice the player hears does not move.
//
// Run against a worktree preview:
//   SF_PROBE_URL=http://localhost:5240 node tools/voice-open-mic-duck-probe.mjs
//
// SF_FAKE_WAV points Chrome's fake capture device at a speech-like wav; without
// it the fake device's test tone is used, which is fine for this measurement
// since the assertion is about the world bus, not about voice quality.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE_URL = process.env.SF_PROBE_URL ?? "http://localhost:49585";
const WAV = process.env.SF_FAKE_WAV;
const PHASE_MS = Number(process.env.SF_RECORD_MS ?? 6000);

const chrome = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
].find((c) => c && existsSync(c));
if (!chrome) throw new Error("Chrome not found; set CHROME_BIN");

const INIT = () => {
  const P = { pcs: [], sources: [], edges: [] };
  window.__probe = P;
  const OrigPC = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends OrigPC {
    constructor(...a) {
      super(...a);
      P.pcs.push(this);
    }
  };
  const origSrc = AudioContext.prototype.createMediaStreamSource;
  AudioContext.prototype.createMediaStreamSource = function (stream) {
    const node = origSrc.call(this, stream);
    P.sources.push({ node, ctx: this, stream });
    return node;
  };
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    P.edges.push({ from: this, to: dest });
    return origConnect.call(this, dest, ...rest);
  };
};

const WORKLET = `
class Rec extends AudioWorkletProcessor {
  constructor(o){ super(); this.max=o.processorOptions.maxFrames; this.buf=new Float32Array(this.max); this.n=0; this.sent=false; }
  process(inputs){
    if (this.n >= this.max) { if (!this.sent){ this.sent=true; this.port.postMessage({done:true, pcm:this.buf.slice(0,this.n)}); } return true; }
    const ch = inputs[0] && inputs[0][0];
    const take = Math.min(128, this.max - this.n);
    if (ch) this.buf.set(ch.subarray(0, take), this.n);
    this.n += take;
    return true;
  }
}
registerProcessor('rec', Rec);
`;

const args = [
  "--enable-unsafe-webgpu",
  "--enable-features=WebGPUDeveloperFeatures",
  "--use-angle=metal",
  "--autoplay-policy=no-user-gesture-required",
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream"
];
if (WAV) args.push(`--use-file-for-fake-audio-capture=${WAV}`);

const browser = await chromium.launch({ executablePath: chrome, headless: true, args });

async function openPage(bctx, label) {
  const page = await bctx.newPage({ viewport: { width: 900, height: 600 } });
  await page.addInitScript(INIT);
  page.on("pageerror", (e) => console.log(`[${label}] pageerror`, e.message));
  await page.goto(`${BASE_URL}/?autostart=1`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.waitForFunction(() => window.__sf?.voice, null, { timeout: 180_000 });
  return page;
}

const ctxA = await browser.newContext({ permissions: ["microphone"] });
const ctxB = await browser.newContext({ permissions: ["microphone"] });

try {
  const [a, b] = await Promise.all([openPage(ctxA, "A"), openPage(ctxB, "B")]);
  // B talks the whole time; A is the one riding and toggling its mic
  await b.evaluate(() => window.__sf.voice.setMic(true));
  await a.evaluate(() => window.__sf.voice.setMic(true));
  await a.waitForFunction(() => window.__sf.voice.debugState().peers.some((p) => p.hasAudio), null, {
    timeout: 90_000
  });
  await a.evaluate(() => window.__sf.switchMode("board"));
  await a.waitForTimeout(2500);
  await a.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", key: "w", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", key: "w", bubbles: true }));
  });
  await a.waitForTimeout(3000);
  console.log("page A riding the board, mode =", await a.evaluate(() => window.__sf.player?.mode));

  await a.evaluate(async ({ workletSrc }) => {
    const P = window.__probe;
    // A retried/dropped peer leaves a closed pc and an orphaned source node
    // behind, and both still match a naive search while emitting silence. Take
    // the newest live one at each step.
    const live = P.pcs.filter(
      (c) =>
        c.connectionState === "connected" &&
        c.getReceivers().some((r) => r.track?.kind === "audio" && r.track.readyState === "live")
    );
    const pc = live[live.length - 1];
    if (!pc) throw new Error("no connected peer connection");
    const track = pc.getReceivers().find((r) => r.track?.kind === "audio").track;
    const matches = P.sources.filter((s) =>
      s.stream.getAudioTracks().some((t) => t.id === track.id)
    );
    P.appSrc = matches[matches.length - 1];
    if (!P.appSrc) throw new Error("no source node for the remote stream");
    const ctx = P.appSrc.ctx;
    P.ctx = ctx;
    P.master = P.edges.filter((e) => e.to === ctx.destination).map((e) => e.from)[0];
    await ctx.audioWorklet.addModule(
      URL.createObjectURL(new Blob([workletSrc], { type: "text/javascript" }))
    );
    P.sink = ctx.createGain();
    P.sink.gain.value = 0;
    P.sink.connect(ctx.destination);
    P.record = (node, ms) => {
      const frames = Math.floor((ms / 1000) * ctx.sampleRate);
      const rec = new AudioWorkletNode(ctx, "rec", {
        processorOptions: { maxFrames: frames },
        numberOfOutputs: 1
      });
      node.connect(rec);
      rec.connect(P.sink);
      return new Promise((res) => {
        rec.port.onmessage = (e) => {
          if (!e.data.done) return;
          try { node.disconnect(rec); } catch {}
          rec.disconnect();
          res({ sampleRate: ctx.sampleRate, pcm: Array.from(e.data.pcm) });
        };
      });
    };
  }, { workletSrc: WORKLET });

  async function phase(label, micOn) {
    await a.evaluate((on) => window.__sf.voice.setMic(on), micOn);
    await a.waitForTimeout(2500); // let the group gains ease
    const duck = await a.evaluate(() => window.__sf.voice.debugState().worldDuck);
    const [master, voiceIn] = await Promise.all([
      a.evaluate((m) => window.__probe.record(window.__probe.master, m), PHASE_MS),
      a.evaluate((m) => window.__probe.record(window.__probe.appSrc.node, m), PHASE_MS)
    ]);
    return { label, micOn, duck, master, voiceIn };
  }

  // The far end goes quiet first, so the master bus carries ONLY the world —
  // otherwise the remote voice (which is deliberately not ducked) dilutes the
  // spill measurement, and its fundamental sits in the same band as the drone.
  await b.evaluate(() => window.__sf.voice.setMic(false));
  await a.waitForTimeout(1500);
  const off = await phase("mic OFF", false);
  const on = await phase("mic ON", true);

  // now the far end talks again, to confirm the duck leaves voice alone
  await b.evaluate(() => window.__sf.voice.setMic(true));
  await a.waitForTimeout(2000);
  const voiceOff = await phase("voice, mic OFF", false);
  const voiceOn = await phase("voice, mic ON", true);
  off.voiceIn = voiceOff.voiceIn;
  on.voiceIn = voiceOn.voiceIn;

  for (const p of [off, on]) {
    console.log(
      `\n${p.label}  debugState.worldDuck=${p.duck}\n` +
        `  master      rms=${rms(p.master).toFixed(4)}  sub-200Hz=${low(p.master).toFixed(4)}\n` +
        `  voice heard rms=${rms(p.voiceIn).toFixed(4)}`
    );
  }

  const spillDrop = 20 * Math.log10(low(on.master) / low(off.master));
  const masterDrop = 20 * Math.log10(rms(on.master) / rms(off.master));
  const voiceDelta = 20 * Math.log10(rms(on.voiceIn) / rms(off.voiceIn));
  console.log(
    `\nwith the mic open: board drone (sub-200Hz) ${spillDrop.toFixed(1)} dB, ` +
      `whole mix ${masterDrop.toFixed(1)} dB, voice ${voiceDelta.toFixed(1)} dB`
  );

  assert.equal(off.duck, 1, "world should be at full level with the mic off");
  assert.ok(on.duck < 1, `world should duck with the mic on (got ${on.duck})`);
  assert.ok(spillDrop < -6, `board drone should drop >6 dB while transmitting (got ${spillDrop.toFixed(1)})`);
  assert.ok(Math.abs(voiceDelta) < 2.5, `voice must stay put (moved ${voiceDelta.toFixed(1)} dB)`);
  console.log("\nopen-mic world duck: PASS");
} finally {
  await browser.close();
}

function rms(rec) {
  let s = 0;
  for (const v of rec.pcm) s += v * v;
  return Math.sqrt(s / rec.pcm.length);
}

function low(rec) {
  // 4th-order lowpass at 200 Hz — where the hoverboard drone lives
  let y = Float64Array.from(rec.pcm);
  for (const Q of [0.5412, 1.3066]) {
    const w = (2 * Math.PI * 200) / rec.sampleRate;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Q);
    const b0 = (1 - cw) / 2;
    const b1 = 1 - cw;
    const b2 = (1 - cw) / 2;
    const a0 = 1 + alpha;
    const a1 = -2 * cw;
    const a2 = 1 - alpha;
    const o = new Float64Array(y.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const xi = y[i];
      const yi = (b0 / a0) * xi + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
      x2 = x1; x1 = xi; y2 = y1; y1 = yi; o[i] = yi;
    }
    y = o;
  }
  let s = 0;
  for (const v of y) s += v * v;
  return Math.sqrt(s / y.length);
}
