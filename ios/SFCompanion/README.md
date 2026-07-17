# SF Companion (iOS)

Companion iPhone app for the San Francisco world: announces "{user} entered
the world" with speech + notification banners, and shows who's in the world
live. Full documentation: [`docs/COMPANION_APP.md`](../../docs/COMPANION_APP.md).

## Build

```sh
brew install xcodegen   # once
xcodegen generate       # regenerates SFCompanion.xcodeproj from project.yml
open SFCompanion.xcodeproj
```

Then run on a simulator, or select your team under Signing & Capabilities and
run on a device.

## Layout

- `project.yml` — xcodegen spec (the `.xcodeproj` is generated)
- `Sources/SFCompanionApp.swift` — entry point
- `Sources/WorldMonitor.swift` — state machine: config → SSE → UI + announcer
- `Sources/ConfigService.swift` — endpoint resolution (override → GitHub raw
  config → cache → server config → baked default)
- `Sources/SSEClient.swift` — reconnecting server-sent-events listener
- `Sources/Announcer.swift` — speech, local notifications, background keep-alive
- `Sources/PushRegistrar.swift` — optional APNs token registration

Launch arguments for headless testing:
`-serverOverride http://127.0.0.1:8787` and `-skipNotificationPrompt 1`.
