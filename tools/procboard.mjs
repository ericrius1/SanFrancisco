#!/usr/bin/env node
// procboard — tiny localhost dashboard listing every process related to this
// repo (main checkout + .claude/worktrees/*): dev servers, probe scripts,
// headless browsers, ffmpeg renders. Shows which worktree each process
// belongs to, what spawned it, listening ports, CPU/mem, and a kill button.
//
// Audio is reported from real CoreAudio state (`pmset -g assertions`), not
// guessed from argv: a process appears under "playing audio" only when it
// holds a "Playing audio" power assertion or coreaudiod has an audio-out
// device context open for it. Browsers reach the board a second way too —
// any process with a TCP connection to a repo dev-server port is pulled in
// and attributed to that port's worktree, which is how an ordinary Chrome
// window with a localhost tab (no repo path in its argv) shows up at all.
//
//   node tools/procboard.mjs [port]     (default 5599, binds 127.0.0.1 only)

import { execFile } from "node:child_process";
import http from "node:http";

const PORT = Number(process.argv[2]) || 5599;
const REPO_MARKER = "codeprojects/sanfrancisco";
const WORKTREE_RE = /\.claude\/worktrees\/([^/\s"']+)/;

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => resolve(stdout || ""));
  });

// ---------------------------------------------------------------- scanning

async function psTable() {
  const out = await run("ps", ["-axo", "pid=,ppid=,pcpu=,pmem=,etime=,command="]);
  const rows = new Map();
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    rows.set(Number(m[1]), {
      pid: Number(m[1]),
      ppid: Number(m[2]),
      cpu: Number(m[3]),
      mem: Number(m[4]),
      etime: m[5],
      command: m[6]
    });
  }
  return rows;
}

async function listeningPorts() {
  const out = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]);
  const byPid = new Map();
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n")) {
      const port = Number(line.slice(1).split(":").pop());
      if (!Number.isFinite(port)) continue;
      if (!byPid.has(pid)) byPid.set(pid, new Set());
      byPid.get(pid).add(port);
    }
  }
  return byPid;
}

// Real audio state. `pmset -g assertions` reports two independent facts:
//   pid 20763(Google Chrome): [...] NoIdleSleepAssertion named: "Playing audio"
//   pid 188(coreaudiod): [...] PreventUserIdleSystemSleep named: "...preventuseridlesleep"
//        Created for PID: 21478.
//        Resources: audio-out BuiltInSpeakerDevice
// The first names the app that is *actively playing*; the second names the pid
// (often a helper) holding an output device context. Both matter: Chrome holds
// the assertion on the browser process while its audio-service helper owns the
// device.
async function audioState() {
  const out = await run("pmset", ["-g", "assertions"]);
  const playing = new Set();
  const output = new Set();
  const input = new Set();
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const owner = lines[i].match(/^\s*pid (\d+)\(([^)]*)\):/);
    if (!owner) continue;
    const ownerPid = Number(owner[1]);
    if (/named:\s*"Playing audio"/i.test(lines[i])) playing.add(ownerPid);
    // Indented continuation lines belong to this assertion.
    let target = ownerPid;
    let resources = "";
    for (let j = i + 1; j < lines.length && /^\s+(Created for PID|Resources|Timeout)/.test(lines[j]); j++) {
      const created = lines[j].match(/Created for PID:\s*(\d+)/);
      if (created) target = Number(created[1]);
      const res = lines[j].match(/Resources:\s*(.+?)\s*$/);
      if (res) resources = res[1];
    }
    if (/audio-out/.test(resources)) output.add(target);
    if (/audio-in/.test(resources)) input.add(target);
  }
  return { playing, output, input };
}

// pid -> Set of localhost ports it has an established connection TO. Used to
// find browsers pointed at a dev server: their argv never mentions the repo.
async function localConnections() {
  const out = await run("lsof", ["-nP", "-iTCP", "-sTCP:ESTABLISHED", "-Fpn"]);
  const byPid = new Map();
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n")) {
      // "127.0.0.1:50150->127.0.0.1:5599" or "[::1]:51224->[::1]:5179"
      const m = line.slice(1).match(/->(\[::1\]|127\.0\.0\.1):(\d+)$/);
      if (!m) continue;
      if (!byPid.has(pid)) byPid.set(pid, new Set());
      byPid.get(pid).add(Number(m[2]));
    }
  }
  return byPid;
}

async function cwds(pids) {
  if (!pids.length) return new Map();
  const out = await run("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"]);
  const byPid = new Map();
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n")) byPid.set(pid, line.slice(1));
  }
  return byPid;
}

function shortName(command) {
  const first = (command.match(/^(?:"[^"]+"|\S+)/) || [command])[0].replaceAll('"', "");
  const base = first.split("/").pop() || first;
  if (/Google Chrome|Chromium|chrome/i.test(command) && /--type=/.test(command)) return "chrome-helper";
  return base;
}

// Stable slug used for CSS + counting.
function classify(row) {
  const c = row.command;
  if (/vite/.test(c) && /node/.test(shortName(c))) return "vite";
  if (/--headless/.test(c)) return "chrome-headless";
  if (/Google Chrome for Testing|playwright|puppeteer/i.test(c)) return "chrome-test";
  if (/Chromium|Google Chrome|chrome/i.test(c)) return "chrome";
  if (/tools\/[\w-]+\.mjs/.test(c)) return "probe";
  if (/esbuild/.test(c)) return "esbuild";
  if (/ffmpeg/.test(c)) return "ffmpeg";
  if (/tsc|typescript/.test(c)) return "tsc";
  if (/server\.mjs|relay/.test(c)) return "server";
  if (/node/.test(shortName(c))) return "node";
  return "other";
}

const APP_BUNDLE = /\/Applications\/(?:Utilities\/)?([^/]+?)(?: \d[\d. ]*[^/]*)?\.app\//;

// What the row is called on screen. "Claude" / "VLC" beats a generic "other"
// when the whole question is which window is making noise.
function displayKind(row, slug) {
  const bundle = row.command.match(APP_BUNDLE);
  if (!bundle) return slug;
  const app = bundle[1];
  if (/--utility-sub-type=audio/.test(row.command)) return app + " audio";
  if (/--type=/.test(row.command)) return app + " helper";
  return app;
}

// A worktree match anywhere (command, cwd, ancestors) must beat the "main"
// fallback: worktree processes often exec binaries out of the main repo's
// node_modules, so a repo path in argv alone does not mean "main".
function worktreeNameOf(text) {
  return text?.match(WORKTREE_RE)?.[1] ?? null;
}

const INTERESTING_ANCESTOR = /claude|codex|cursor|code(?!sign)|iterm|terminal|warp|zellij|tmux|node/i;

function ancestry(rows, pid) {
  const chain = [];
  let cur = rows.get(pid)?.ppid ?? 0;
  let hops = 0;
  while (cur > 1 && hops < 12) {
    const row = rows.get(cur);
    if (!row) break;
    const name = shortName(row.command);
    if (chain[chain.length - 1]?.name !== name) chain.push({ pid: row.pid, name });
    cur = row.ppid;
    hops++;
  }
  return chain;
}

function originLabel(chain) {
  const named = chain.filter((c) => INTERESTING_ANCESTOR.test(c.name));
  const top = named[named.length - 1];
  const parent = chain[0];
  if (!parent) return "—";
  if (top && top.name !== parent.name) return `${parent.name} (pid ${parent.pid}) ← ${top.name}`;
  return `${parent.name} (pid ${parent.pid})`;
}

let lastScanPids = new Set();
const OTHER_APPS = "other apps · not this repo";

// GUI apps the user drives themselves. One of these can land in a worktree
// group legitimately — Claude.app hosting a preview pane on :5240 is "viewing"
// that worktree — but the board kills without confirming, and killing the
// editor/chat window you are reading this from (or a DAW holding unsaved work)
// is not a recoverable click. Dev processes are fair game; windows are not.
const USER_APP = /\/Applications\/[^/]*(Claude|Google Chrome|Chromium|Safari|Firefox|Arc|Visual Studio Code|Cursor|iTerm|Terminal|Ableton|Logic|VLC|Spotify|Music|Blender)[^/]*\.app\//i;
function userFacingApp(row) {
  // Automation browsers are disposable no matter where they live.
  if (/--headless|Google Chrome for Testing|playwright|puppeteer/i.test(row.command)) return false;
  return USER_APP.test(row.command);
}

// Walk up to the user-visible app: a Chrome Helper's audio belongs to "Google
// Chrome", not to an anonymous helper pid.
function appRoot(rows, pid) {
  let cur = pid;
  for (let hops = 0; hops < 12; hops++) {
    const row = rows.get(cur);
    if (!row || row.ppid <= 1) break;
    const parent = rows.get(row.ppid);
    if (!parent) break;
    // Stop before crossing out of the app bundle into a shell/launcher.
    if (!/Helper|--type=/.test(row.command) && !/\.app\//.test(parent.command)) break;
    cur = row.ppid;
  }
  return cur;
}

async function scan() {
  const [rows, ports, audio, conns] = await Promise.all([
    psTable(),
    listeningPorts(),
    audioState(),
    localConnections()
  ]);

  const children = new Map();
  for (const row of rows.values()) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }

  // Which local ports are served by a repo process, and by which worktree.
  const repoRootPids = [...rows.values()]
    .filter((row) => row.command.includes(REPO_MARKER))
    .map((row) => row.pid);
  const portOwner = new Map();

  const included = new Set();
  const queue = [...repoRootPids];
  while (queue.length) {
    const pid = queue.pop();
    if (included.has(pid)) continue;
    included.add(pid);
    for (const kid of children.get(pid) || []) queue.push(kid);
  }

  // Clients of a repo dev server: an everyday Chrome window with a localhost
  // tab has no repo path anywhere in its argv, so nothing above finds it.
  const devPorts = new Set();
  for (const pid of included) for (const port of ports.get(pid) || []) devPorts.add(port);
  const clientPorts = new Map();
  for (const [pid, targets] of conns) {
    const hits = [...targets].filter((port) => devPorts.has(port) && port !== PORT);
    if (!hits.length) continue;
    const owner = appRoot(rows, pid);
    if (!clientPorts.has(owner)) clientPorts.set(owner, new Set());
    for (const port of hits) clientPorts.get(owner).add(port);
    included.add(owner);
    included.add(pid);
  }

  // Anything actually making sound, repo-related or not — the whole point is
  // that nothing playing audio can hide from this board.
  const audioPids = new Set([...audio.playing, ...audio.output]);
  const audioOwners = new Map();
  for (const pid of audioPids) {
    if (!rows.has(pid)) continue;
    const owner = appRoot(rows, pid);
    if (!audioOwners.has(owner)) audioOwners.set(owner, new Set());
    audioOwners.get(owner).add(pid);
    included.add(owner);
  }

  included.delete(process.pid);

  const needCwd = [...included].filter((pid) => {
    const row = rows.get(pid);
    return row && (!WORKTREE_RE.test(row.command) || !row.command.includes(REPO_MARKER));
  });
  const cwdMap = await cwds(needCwd.slice(0, 64));

  // Attribute each served port to its worktree, so a client can be labelled.
  const procWorktree = (pid) => {
    const row = rows.get(pid);
    if (!row) return null;
    const cwd = cwdMap.get(pid) || "";
    let wt = worktreeNameOf(row.command) || worktreeNameOf(cwd);
    for (const link of ancestry(rows, pid)) {
      if (wt) break;
      wt = worktreeNameOf(rows.get(link.pid)?.command || "");
    }
    if (!wt && (row.command.includes(REPO_MARKER) || cwd.includes(REPO_MARKER))) wt = "main";
    return wt;
  };
  for (const pid of included) {
    const wt = procWorktree(pid);
    if (!wt) continue;
    for (const port of ports.get(pid) || []) portOwner.set(port, wt);
  }

  const procs = [];
  for (const pid of included) {
    const row = rows.get(pid);
    if (!row) continue;
    const chain = ancestry(rows, pid);
    const servedPorts = [...(ports.get(pid) || [])].sort((a, b) => a - b);
    const links = [...(clientPorts.get(pid) || [])]
      .sort((a, b) => a - b)
      .map((port) => ({ port, worktree: portOwner.get(port) || "?" }));

    let worktree = procWorktree(pid);
    // A browser with no repo path of its own belongs to whatever it is viewing.
    if (!worktree && links.length) {
      const tally = new Map();
      for (const link of links) tally.set(link.worktree, (tally.get(link.worktree) || 0) + 1);
      worktree = [...tally].sort((a, b) => b[1] - a[1])[0][0];
    }

    const holders = audioOwners.get(pid);
    const audioSelf = audioPids.has(pid);
    const playing = audio.playing.has(pid) || (holders && [...holders].some((h) => audio.playing.has(h)));
    const outputs = audio.output.has(pid) || (holders && [...holders].some((h) => audio.output.has(h)));
    const capturing = audio.input.has(pid) || (holders && [...holders].some((h) => audio.input.has(h)));
    const viaPids = holders ? [...holders].filter((h) => h !== pid) : [];

    const repoRelated = Boolean(worktree);
    const isApp = userFacingApp(row);
    const slug = classify(row);
    procs.push({
      pid,
      kind: slug,
      label: displayKind(row, slug),
      worktree: worktree || OTHER_APPS,
      repoRelated,
      // A window pointed at a dev server, not a process the repo spawned.
      viewer: isApp && links.length > 0,
      userApp: isApp,
      cpu: row.cpu,
      mem: row.mem,
      etime: row.etime,
      ports: servedPorts,
      links,
      origin: originLabel(chain),
      audio: Boolean(playing || outputs || audioSelf),
      audioPlaying: Boolean(playing),
      audioOutput: Boolean(outputs),
      audioInput: Boolean(capturing),
      audioVia: viaPids,
      killable: repoRelated && !isApp && pid !== process.pid,
      self: pid === process.pid,
      command: row.command.length > 400 ? row.command.slice(0, 400) + " …" : row.command
    });
  }
  procs.sort((a, b) =>
    Number(b.audio) - Number(a.audio) || b.cpu - a.cpu || a.pid - b.pid);
  lastScanPids = new Set(procs.filter((p) => p.killable).map((p) => p.pid));
  return procs;
}

// ------------------------------------------------------------------ server

const PAGE = `<!doctype html><meta charset="utf-8">
<title>SF procboard</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 24px; background: #0d1117; color: #dbe2ea;
         font: 13px/1.5 "SF Mono", ui-monospace, Menlo, monospace; }
  h1 { font-size: 16px; margin: 0 0 4px; color: #fff; }
  .sub { color: #7d8590; margin-bottom: 18px; }
  .group { margin-bottom: 22px; border: 1px solid #21262d; border-radius: 10px;
           overflow: hidden; background: #11161d; }
  .group > header { padding: 8px 14px; background: #161c24; font-weight: 600;
                    color: #9ecbff; display: flex; justify-content: space-between; }
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: 6px 10px; text-align: left; vertical-align: top;
           border-top: 1px solid #1b212a; }
  th { color: #7d8590; font-weight: 500; border-top: none; }
  tr:hover td { background: #151b23; }
  .kind { display: inline-block; padding: 1px 7px; border-radius: 20px;
          font-size: 11px; background: #1f2937; color: #9ecbff; }
  .kind.vite { background: #0f2e1f; color: #6fdd8b; }
  .kind.chrome-headless, .kind.chrome-test, .kind.chrome { background: #33230f; color: #f0b35f; }
  .kind.probe { background: #2a1f38; color: #c9a6ff; }
  .kind.ffmpeg { background: #341a1a; color: #ff9f9f; }
  .cpu-hot { color: #ff7b72; font-weight: 700; }
  .cpu-warm { color: #f0b35f; }
  .audio { color: #ff7b72; font-size: 11px; }
  #spotlight { margin-bottom: 26px; border: 1px solid #f0883e; border-radius: 10px;
               background: linear-gradient(180deg, #2a1608, #14171d 60%); overflow: hidden; }
  #spotlight > header { padding: 10px 14px; background: #40230c; color: #ffd7a8;
                        font-weight: 700; display: flex; justify-content: space-between;
                        align-items: center; letter-spacing: .02em; }
  #spotlight.quiet { border-color: #21262d; background: #11161d; }
  #spotlight.quiet > header { background: #161c24; color: #6fdd8b; font-weight: 600; }
  .live { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
          background: #ff7b72; margin-right: 8px; animation: blink 1s infinite; }
  @keyframes blink { 50% { opacity: .25; } }
  .tag { display: inline-block; padding: 1px 7px; border-radius: 20px; font-size: 11px;
         margin-right: 4px; background: #40230c; color: #ffb457; border: 1px solid #7a4a17;
         white-space: nowrap; }
  #spotlight td:nth-child(3), #spotlight td:nth-child(4) { min-width: 150px; }
  #spotlight .cmd { max-width: 360px; }
  .kind { white-space: nowrap; }
  .tag.out { background: #3a1414; color: #ff9f9f; border-color: #7d2b2b; }
  .tag.mic { background: #10263a; color: #79c0ff; border-color: #1f4b73; }
  .tag.foreign { background: #22262d; color: #9aa4b2; border-color: #363b44; }
  .link { display: inline-block; padding: 1px 7px; border-radius: 20px; font-size: 11px;
          background: #0f2e1f; color: #6fdd8b; margin-right: 4px; }
  .nokill { color: #6e7681; font-size: 11px; }
  .cmd { color: #7d8590; max-width: 520px; overflow: hidden; text-overflow: ellipsis;
         white-space: nowrap; }
  .cmd:hover { white-space: normal; word-break: break-all; }
  a { color: #58a6ff; text-decoration: none; }
  button { background: #21262d; color: #ff7b72; border: 1px solid #30363d;
           border-radius: 6px; padding: 2px 10px; cursor: pointer; font: inherit; font-size: 11px; }
  button:hover { background: #ff7b72; color: #0d1117; }
  .selfrow { color: #6fdd8b; font-size: 11px; }
  #meta { color: #7d8590; font-size: 12px; margin-bottom: 14px; }
  #meta label { margin-left: 14px; cursor: pointer; }
  .empty { padding: 30px; text-align: center; color: #7d8590; }
  tr.dying td { opacity: 0.35; text-decoration: line-through; }
  .killgroup { color: #7d8590; }
  .killgroup:hover { background: #ff7b72; color: #0d1117; }
  #toasts { position: fixed; right: 20px; bottom: 20px; display: flex;
            flex-direction: column; gap: 8px; z-index: 9; }
  .toast { background: #161c24; border: 1px solid #30363d; border-left: 3px solid #6fdd8b;
           border-radius: 8px; padding: 8px 14px; font-size: 12px; color: #dbe2ea;
           box-shadow: 0 6px 20px #0008; animation: pop .18s ease-out; }
  .toast.bad { border-left-color: #ff7b72; color: #ff7b72; }
  @keyframes pop { from { opacity: 0; transform: translateY(6px); } }
</style>
<h1>SF procboard</h1>
<div class="sub">processes touching codeprojects/sanfrancisco — grouped by worktree</div>
<div id="meta">loading… <label><input type="checkbox" id="pause"> pause refresh</label></div>
<div id="spotlight"></div>
<div id="root"></div>
<div id="toasts"></div>
<script>
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const OTHER_APPS = ${JSON.stringify(OTHER_APPS)};
// Rows killed but not yet gone from a scan: keep them struck-through so the
// list never flashes a process back in as if the kill missed.
const dying = new Set();

function toast(text, bad) {
  const el = document.createElement("div");
  el.className = "toast" + (bad ? " bad" : "");
  el.textContent = text;
  document.getElementById("toasts").append(el);
  setTimeout(() => el.remove(), 4000);
}

async function kill(pid, force, label) {
  dying.add(pid);
  for (const el of document.querySelectorAll('[data-pid="' + pid + '"]')) el.classList.add("dying");
  try {
    const res = await fetch("/api/kill", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pid, force }) });
    const json = await res.json();
    if (json.ok) toast((force ? "SIGKILL " : "killed ") + (label || "pid " + pid));
    else { dying.delete(pid); toast("could not kill pid " + pid + (json.error ? " — " + json.error : ""), true); }
  } catch {
    dying.delete(pid);
    toast("kill request failed for pid " + pid, true);
  }
  setTimeout(refresh, 400);
}

function killGroup(worktree) {
  const targets = (window.__procs || []).filter((p) =>
    p.worktree === worktree && p.killable && !dying.has(p.pid));
  for (const p of targets) kill(p.pid, false, p.label + " " + p.pid);
}
function audioTags(p) {
  let out = "";
  if (p.audioPlaying) out += "<span class='tag'>&#128266; playing audio</span>";
  if (p.audioOutput) out += "<span class='tag out'>audio-out device</span>";
  if (p.audioInput) out += "<span class='tag mic'>&#127908; mic</span>";
  if (p.viewer) out += "<span class='tag foreign'>viewing this repo</span>";
  if (p.audioVia.length) out += "<span class='tag foreign'>via helper " + p.audioVia.join(", ") + "</span>";
  return out;
}
function portCells(p) {
  const served = p.ports.map((x) =>
    '<a target="_blank" href="http://localhost:' + x + '/?autostart=1">:' + x + "</a>").join(" ");
  const viewing = p.links.map((l) =>
    "<span class='link' title='serving worktree: " + esc(l.worktree) + "'>&#8594; :" + l.port +
    " " + esc(l.worktree) + "</span>").join(" ");
  return [served, viewing].filter(Boolean).join("<br>") || "—";
}
function actionCell(p) {
  if (p.self) return "";
  if (p.killable) {
    return "<button onclick='kill(" + p.pid + ",false)'>kill</button> " +
      "<button onclick='kill(" + p.pid + ",true)'>-9</button>";
  }
  if (p.viewer) {
    const ports = p.links.map((l) => ":" + l.port).join(", ");
    return "<span class='nokill'>your window &mdash; close its<br>tab on " + ports +
      ", or kill the<br>server below</span>";
  }
  if (p.userApp) return "<span class='nokill'>your app &mdash;<br>quit it yourself</span>";
  return "<span class='nokill'>not this repo</span>";
}
function row(p, showWorktree) {
  const cpuCls = p.cpu > 60 ? "cpu-hot" : p.cpu > 20 ? "cpu-warm" : "";
  // data-pid, not id: an audio process is rendered twice (spotlight + group).
  return "<tr data-pid='" + p.pid + "'" + (dying.has(p.pid) ? " class='dying'" : "") + ">" +
    "<td><span class='kind " + p.kind + "'>" + esc(p.label) + "</span>" +
    (p.audio && !showWorktree ? "<div class='audio'>&#128266; playing</div>" : "") +
    (p.self ? "<div class='selfrow'>this dashboard</div>" : "") + "</td>" +
    "<td>" + p.pid + "</td>" +
    (showWorktree ? "<td>" + esc(p.worktree) + "</td><td>" + audioTags(p) + "</td>" : "") +
    "<td>" + portCells(p) + "</td>" +
    "<td class='" + cpuCls + "'>" + p.cpu.toFixed(1) + "%</td>" +
    "<td>" + p.mem.toFixed(1) + "%</td>" +
    "<td>" + p.etime + "</td>" +
    "<td>" + esc(p.origin) + "</td>" +
    "<td class='cmd' title='" + esc(p.command) + "'>" + esc(p.command) + "</td>" +
    "<td>" + actionCell(p) + "</td></tr>";
}
function renderSpotlight(procs) {
  const noisy = procs.filter((p) => p.audio);
  const el = document.getElementById("spotlight");
  if (!noisy.length) {
    el.className = "quiet";
    el.innerHTML = "<header><span>&#128263; nothing is playing audio</span></header>";
    return;
  }
  el.className = "";
  const repo = noisy.filter((p) => p.repoRelated).length;
  el.innerHTML = "<header><span><span class='live'></span>" + noisy.length +
    " process" + (noisy.length > 1 ? "es" : "") + " playing audio right now</span><span>" +
    (repo ? repo + " from this repo" : "none from this repo") + "</span></header><table>" +
    "<tr><th>kind</th><th>pid</th><th>worktree</th><th>audio</th><th>ports</th><th>cpu</th>" +
    "<th>mem</th><th>up</th><th>origin</th><th>command</th><th></th></tr>" +
    noisy.map((p) => row(p, true)).join("") + "</table>";
}
function render(procs) {
  window.__procs = procs;
  const live = new Set(procs.map((p) => p.pid));
  for (const pid of dying) if (!live.has(pid)) dying.delete(pid);
  renderSpotlight(procs);
  const groups = new Map();
  for (const p of procs) {
    if (!groups.has(p.worktree)) groups.set(p.worktree, []);
    groups.get(p.worktree).push(p);
  }
  const order = [...groups.keys()].sort((a, b) => {
    if (a === "main") return -1;
    if (b === "main") return 1;
    // Unrelated apps are context, not work — keep them last.
    if (a === OTHER_APPS) return 1;
    if (b === OTHER_APPS) return -1;
    return a.localeCompare(b);
  });
  let html = "";
  for (const wt of order) {
    const list = groups.get(wt);
    const cpu = list.reduce((s, p) => s + p.cpu, 0);
    const killable = list.filter((p) => p.killable).length;
    const noisy = list.filter((p) => p.audio).length;
    html += "<div class='group'><header><span>" + esc(wt) +
      (noisy ? " <span class='tag'>&#128266; " + noisy + "</span>" : "") + "</span><span>" +
      list.length + " proc · " + cpu.toFixed(0) + "% cpu" +
      (killable ? " <button class='killgroup' onclick=\\"killGroup('" + esc(wt) + "')\\">kill all " +
        killable + "</button>" : "") + "</span></header><table>" +
      "<tr><th>kind</th><th>pid</th><th>ports</th><th>cpu</th><th>mem</th><th>up</th><th>origin</th><th>command</th><th></th></tr>" +
      list.map((p) => row(p, false)).join("") + "</table></div>";
  }
  document.getElementById("root").innerHTML =
    html || "<div class='empty'>no repo-related processes found</div>";
  const chrome = procs.filter((p) => p.kind.startsWith("chrome")).length;
  const audio = procs.filter((p) => p.audio).length;
  document.getElementById("meta").firstChild.textContent =
    procs.length + " processes · " + chrome + " chrome · " + audio + " playing audio · " +
    "updated " + new Date().toLocaleTimeString() + " ";
}
async function refresh() {
  if (document.getElementById("pause").checked) return;
  try {
    const res = await fetch("/api/procs");
    render(await res.json());
  } catch {}
}
refresh();
setInterval(refresh, 3000);
</script>`;

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?"))) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
    } else if (req.method === "GET" && req.url === "/api/procs") {
      const procs = await scan();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(procs));
    } else if (req.method === "POST" && req.url === "/api/kill") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { pid, force } = JSON.parse(body || "{}");
      // Only allow killing pids surfaced by the latest scan, never ourselves.
      if (!Number.isInteger(pid) || pid === process.pid || !lastScanPids.has(pid)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "pid not in current scan" }));
        return;
      }
      let ok = true;
      try {
        process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      } catch {
        ok = false;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok }));
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(err));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`procboard http://localhost:${PORT}/`);
});
