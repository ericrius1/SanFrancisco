# Verification pass — archery + pickleball + Goldman clubhouse

Headless end-to-end verification of the three freshly-integrated minigame
overhauls. All three render and play correctly in-game. NO app code needed
fixing — the only trivial issue found was in my own probe (wrong DEV-hook path)
and was fixed there.

## Files changed
- `tools/archery-verify-probe.mjs` (NEW — verification probe, all three sites)
- `tools/archery-draw-closeup.mjs` (NEW — focused player draw-pose re-shoot)

No `src/**` files were modified. Screenshots + results.json written under
`.data/archery-verify/` (gitignored). Own vite ran on port 5232 / relay 8792,
freed after each run; the human's 5179 was never touched.

## How verified
Booted the app once headless (Chrome WebGPU/metal, `?autostart&fullfps`),
drove `window.__sf.tick(dt)` (which runs `siteGate.update` → wakes each site),
teleported to each location, read `__archery`/`__sf` state, and captured +
read every screenshot. Zero console errors / page exceptions across the whole
run.

## 1. Archery — PASS (most thoroughly checked)
Teleported to the shooting line (world ≈ (-5547, 2079), 14 m upstream of the
(-5533, 2079) field centre, facing downrange +X).

- **Site wakes:** `__archery.stats()` → `awake:true, visible:true`,
  `npcPhases:["idle","idle"]` (two NPC archers on the outer lanes). Correct.
  NOTE: `stats()`/`fire()` live on `window.__archery`, NOT `__archery.game`
  (the task brief said `.game.stats()` — minor doc drift; `.game` is the
  ArcheryGame instance).
- **Scoring driven:** `__archery.fire(2,0,0)` then three offset shots into
  different rings. End array went `[-1,-1,-1,-1,-1,-1]` → `[10,8,6,4,-1,-1]`,
  `endTotal 28`, `grandTotal 28`, `stuck 4`. Ring scoring is exact: dead-centre
  = GOLD 10, then 8/6/4 as offsets walk outward. Arrows stuck in the face (4
  stuck instances).
- **Screenshots read:**
  - `archery_range_overview.jpg` — 5 target butts downrange, white shooting-line
    strips, rack/rail/hay furniture, an archer figure on the line, "Press E —
    pick up a bow" prompt. Range reads well.
  - `archery_arrows_stuck.jpg` — lane-2 face with gold/red/blue/black/white
    rings, two arrows stuck near centre + one low, "BLACK +4" scoring toast.
    Ring face + arrow-stick both confirmed. A second target visible behind.
  - `archery_draw_profile.jpg` / `archery_draw_front.jpg` — player in the archer
    pose; an **NPC archer at full draw** (yellow shirt, bow drawn) clearly
    visible on the outer lane behind — confirms the NPC draw path renders.
  - `archery_draw_close_frontleft.jpg` / `_side.jpg` — close-up confirming the
    **bow is gripped in the player's (left) hand**: a proper recurve bow held
    vertically/extended in the mitt. Grip-system deliverable satisfied; pose
    reads as an archer holding a drawn bow.
- **Freeze when idle:** teleported far (0,0) + let arrows resolve → `awake:false,
  visible:false, flying:0`, and `updatesRan` held at 168 across 30 further ticks
  (early-return confirmed). `playerEngaged` (held bow OR arrows in flight) is the
  keep-awake gate, verified by code + the flying counter.

Verdict: fun and correct. Deterministic scoring works, arrows stick and score
by ring, NPCs animate + draw, the player gets a bow in hand, and the site
freezes cleanly when abandoned.

## 2. Pickleball — PASS (visual confirm of the 8/8 probe)
Teleported to the Goldman mini-courts (-1330, 2140).
- State: `pickleballAmbient` present, **4 visible ambient courts, 8 avatar
  athletes, 8 paddle-face meshes, 4 balls airborne** mid-rally. Score chip
  mounted + shown ("PICKLEBALL 1 – 0" with the serving-side dot).
- Takeover: `pickleballAmbient.getInteraction(playerPos)` near a 14A athlete →
  `{ref:"14A", side:0, prompt:"E — take over near player", d:1.78}`.
- Screenshots: `pickleball_courts.jpg` — several blue mini-courts with
  distinctly-outfitted **real avatar rigs** (not box figures) rallying, "POINT —
  NEAR SIDE" banner, score chip, "E — take over near player" prompt.
  `pickleball_grip.jpg` — athlete with a yellow paddle **gripped in-hand**,
  second athlete rallying behind.

Verdict: looks right and lively — avatar athletes, paddles in hand, HUD +
banner + takeover prompt all rendering.

## 3. Goldman clubhouse — PASS
Teleported near the Taube clubhouse (frame centre -1363.78, 2197.26).
- **Floor grounded (overlay fix works):** `groundOverlay(cx,cz)` = 74.94 vs base
  terrain 74.25 → floor sits ~0.7 m ABOVE grade (raised pavilion floor, not
  flattened/sunk). Player teleported inside reported a floor-overlay height, not
  a clip. `goldenGateTennis.update()` present and driven per frame.
- Screenshots:
  - `clubhouse_exterior.jpg` — long glass-ribbon pavilion with dark mullions +
    roof overhang, NPCs visible through the glass, a member outside on the path,
    door ramp. Enterable pavilion, not a solid slab.
  - `clubhouse_interior_a/b/c.jpg` — interior floor with green rug runners,
    columns, glass wall onto the courts, **reception desk** (dark counter with 3
    ball tubes/monitor), pro-shop wall shelves, benches, and **NPC members** —
    including one carrying a **racket clasped in hand** — plus the receptionist
    near the desk. Floor grounded, ceiling/light strips overhead.

Verdict: correct and inviting — enterable, furnished, staffed, floor properly
grounded. The pre-existing golf-vs-tennis single-overlay clash flagged in the
clubhouse audit did NOT manifest here (floor overlay resolved correctly at the
time/place tested).

## Open risks / notes (none blocking)
- Task-brief doc drift only: archery DEV hook is `window.__archery.stats()` /
  `.fire()`, not `.game.stats()`. Worth correcting in any follow-up docs.
- The golf/tennis ground-overlay clash (clubhouse audit Open Risk #1) is a
  latent structural issue — not reproduced in this session, but if the Presidio
  golf region loads and replaces the tennis overlay, the clubhouse floor
  grounding could regress. Structural (heightmap overlay list), out of scope to
  fix here — flagging per instructions.
- Pickleball night-empties / day-restore was already asserted by the existing
  pickleball probe (8/8); not re-driven visually here.

## Test results
- `node tools/archery-verify-probe.mjs` — completed, **0 page errors**, all
  state assertions as above, 9 screenshots.
- `node tools/archery-draw-closeup.mjs` — completed, 3 draw close-ups.
- Ports 5232 / 8792 confirmed free after both runs.
