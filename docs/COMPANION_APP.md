# SF Companion — iOS notifications app

A small SwiftUI iPhone app that announces world arrivals: when someone enters
the San Francisco world it shows a banner and *speaks* "{user} entered the
world." It also shows who's in the world right now and a recent activity feed.

- App sources: `ios/SFCompanion/` (xcodegen project)
- Server module: `server/companion.mjs` (mounted by `server/server.mjs`)
- Backend pointer: `companion/config.json` (fetched from GitHub raw)

## Architecture — designed to survive a backend switch

```
game client ──ws /ws──▶ relay (server.mjs)
                          │  join/leave hooks
                          ▼
                   companion.mjs hub
                    ├── GET  /companion/config     backend descriptor
                    ├── GET  /companion/events     SSE: hello / join / leave
                    ├── POST /companion/register   APNs token (optional)
                    └── APNs sender (only when APNS_* env vars set)
                          ▲
iOS app ── resolves config ── listens on SSE ── speaks + notifies
```

The iOS app never hardcodes endpoints. At launch it resolves, in order:

1. **Manual server override** (Settings → Server override) — power users, local dev.
2. **Remote config**: `https://raw.githubusercontent.com/ericrius1/SanFrancisco/main/companion/config.json`
   — lives in the repo, *not* on the backend, so it stays reachable while a
   backend moves.
3. **Cached** last-good config.
4. The current default server's own `/companion/config`.
5. Built-in default (`https://sanfrancisco.up.railway.app`).

### Switching backends with zero app update

1. Stand the relay up elsewhere (any host that runs `server/server.mjs`, or a
   new backend that re-implements the tiny contract below).
2. Edit `companion/config.json` → set `baseUrl` to the new host. Push to `main`.
3. Done. Apps pick up the new home on next launch (GitHub raw caches ~5 min).

If the new backend isn't this Node server, it only needs to serve:

- `GET /companion/config` → `{ v, world, events: {kind:"sse", path}, register: {path} }`
- `GET /companion/events` → SSE stream with events:
  - `hello` — `{ "type":"hello", "players":[{"id":1,"name":"Eric"}], "ts":0 }` on connect
  - `join` — `{ "type":"join", "id":1, "name":"Eric", "players":[…], "ts":0 }`
  - `leave` — same shape
  - comment lines (`: ping`) as keep-alive every ~25 s
- optionally `POST /companion/register` `{token, platform}` for push.

The app's transport is also swappable in code: `SSEClient.swift` is one
implementation behind the `events.kind` config field — a future backend could
declare a different kind and ship a sibling client without touching the rest.

## Notification behavior on iOS

| App state | What happens |
|---|---|
| Foreground | Spoken announcement ("Eric entered the world") + feed update |
| Background, "Background listening" ON | SSE stays alive via silent audio session → spoken announcement + banner notification |
| Background, toggle OFF | iOS suspends the socket; catches up when reopened |
| Killed / force-quit | Only APNs push can reach the device (see below) |

## Optional: real push (APNs) for when the app is closed

Server side is already wired but dormant. To activate, set these on the
Railway service (or wherever the relay runs):

- `APNS_TEAM_ID` — Apple Developer team id
- `APNS_KEY_ID` — key id of an APNs auth key (.p8)
- `APNS_P8` — the .p8 file contents (or `APNS_P8_BASE64`)
- `APNS_TOPIC` — the app bundle id (`com.ericrius1.sfcompanion`)
- `APNS_ENV` — `production` (default) or `sandbox` for dev builds

Requires an Apple Developer Program membership and a build signed with the
push entitlement. Without any of this, the app still fully works in
foreground/background-listening modes.

## Building & distributing the app

```sh
cd ios/SFCompanion
xcodegen generate          # regenerate SFCompanion.xcodeproj after editing project.yml
open SFCompanion.xcodeproj # build & run from Xcode (free account works for personal devices)
```

"Anyone can download" requires Apple's channels (this can't be automated from
the repo):

1. Join the Apple Developer Program ($99/yr) with your Apple ID.
2. In Xcode: Signing & Capabilities → select your team (bundle id can stay or
   change — if it changes, update `APNS_TOPIC` too).
3. Product → Archive → Distribute → **TestFlight** (public link, up to 10 000
   testers, ~1 day review) or **App Store** (full review).

## Testing locally

```sh
node server/server.mjs                  # relay on :8787
# simulator app pointed at it:
xcrun simctl launch booted com.ericrius1.sfcompanion -serverOverride "http://127.0.0.1:8787"
# fake a join:
node -e 'import("ws").then(({default:W})=>{const w=new W("ws://127.0.0.1:8787/ws");w.on("open",()=>w.send(JSON.stringify({t:"hi",name:"Eric"})))})'
# watch the raw feed:
curl -N http://127.0.0.1:8787/companion/events
```
