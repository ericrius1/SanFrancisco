# Browser testing

- Run browser testing headlessly or in the background. Do not open browser instances in the Codex app unless the user explicitly asks for an interactive/visible browser.
- Local development auto-enters the world with a generated name once the world is ready. Agents do not need to fill in or submit the start form.
- When testing a preview or production build, open it with `?autostart=1` (preserving any existing query parameters).
- Use `?startscreen=1` only when the start/loading experience itself is under test.

# Runnable feature handoffs

- When a feature is completed in a git worktree, keep a local preview running from that exact worktree and share a clickable `http://localhost:<port>/?autostart=1` link in the final response (verify it returns 200 first). A filesystem path, worktree path, screenshot, or render link is not a substitute for the running link.
- Use a plain background/session dev server. Do NOT set up OS-level services (launchd, LaunchAgents, cron, etc.) to make the preview outlive the session — the user prefers to just ask for a fresh link if the server has stopped.
- The main-repo dev server on the default port (5179) serves the MAIN repo, not the worktree, so start the worktree preview on its own port (the `sf-verify` launch config uses 5240).

# Video rendering

- Use the system `video-rendering` skill for video work.
- Publish approved videos to `/Users/eric/videos/my creations/sf/renders/cinematics` and keep only final MP4 files there.
- Keep frames, review MP4s, manifests, audits, contacts, posters, probes, logs, and temporary encodes under `.data/`; do not create platform-specific publish folders.
