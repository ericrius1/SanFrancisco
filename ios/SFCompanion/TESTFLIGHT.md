# Getting SF Companion onto TestFlight

The app is code-complete and builds cleanly for the simulator. The remaining
steps all require signing in to Apple and a paid membership, so they must be
done by a human — they can't be automated from a headless environment (a build
attempt here failed with *"No Account for Team… No profiles found"*, i.e. the
Apple auth wall).

## One-time prerequisites (you, in a browser / Xcode)

1. **Apple Developer Program** — enroll the Apple ID (`ericrius1@gmail.com`) at
   <https://developer.apple.com/programs/> ($99/yr). TestFlight is **not**
   available on a free Apple ID.
2. **App record** — in App Store Connect (<https://appstoreconnect.apple.com>)
   → Apps → **+** → New App. Platform iOS, bundle id
   `com.ericrius1.sfcompanion`, pick a name (e.g. "SF Companion").

## Easiest path — Xcode Organizer (recommended)

```sh
cd ios/SFCompanion
xcodegen generate
open SFCompanion.xcodeproj
```

1. Select the **SFCompanion** target → **Signing & Capabilities** → check
   *Automatically manage signing* → choose your Team. Xcode creates the
   distribution certificate + provisioning profile for you.
2. Toolbar device selector → **Any iOS Device (arm64)**.
3. Menu **Product → Archive**. When it finishes, the Organizer opens.
4. **Distribute App → TestFlight & App Store → Upload**. Follow the prompts.
5. After ~5–15 min processing, the build shows in App Store Connect →
   **TestFlight**. Add it to a group and share the public link.

## Scripted path — once enrolled

`distribute.sh` archives + uploads without the GUI. It needs an App Store
Connect **API key** for auth:

1. App Store Connect → Users and Access → **Integrations / Keys** → generate an
   API key (App Manager role). Download the `.p8` **once**.
2. Put it at `~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8`.
3. Run:

```sh
cd ios/SFCompanion
export ASC_KEY_ID=<KEYID>
export ASC_ISSUER_ID=<ISSUER-UUID>   # shown above the keys list
./distribute.sh
```

Or `./distribute.sh archive` to only build the archive and hand off to the
Organizer.

## Push notifications on TestFlight (optional)

Local-notification arrivals work as soon as the app is installed. For the
*app-closed* APNs path, additionally:

1. Enable the **Push Notifications** capability on the target (adds an
   entitlements file — Xcode does this in Signing & Capabilities).
2. Set the server's `APNS_*` env vars (see
   [`docs/COMPANION_APP.md`](../../docs/COMPANION_APP.md)); use `APNS_ENV=sandbox`
   for TestFlight/dev builds, `production` for App Store.
```
