# Baked assets: worktrees, main, and staying in sync

Some of this repo is authored by hand and some of it is **baked**. Baked
artifacts have a source, a command, and an output — and the only hard problem
they create is telling whether a given checkout's output still matches its
source. Two real failures motivated the system described here:

- A freshly merged `main` could not build. Its terrain tile bake was three days
  older than the source data it came from. The contract test that guards it
  self-heals only when the bake is **missing**, so a merely *stale* bake sailed
  past and then failed an assertion several steps later with no hint that a
  rebake was the fix.
- Nothing checked that a committed `.glb` was actually baked from the committed
  `.blend` beside it. Edit a site in a worktree, commit the source without
  re-baking, merge, and `main` ships a model that does not match its authoring
  file — silently, indefinitely.

## The ledger

`data/asset-ledger/<artifact>.json` records, for one baked artifact, the
content fingerprint of every input and every output at the moment it was baked.
It is committed, so it travels through a merge exactly like code does.

One file per artifact, deliberately. Two worktrees baking two different sites
must never conflict; two worktrees baking the **same** site must — that is a
genuine disagreement about which bake is authoritative, and git should say so
rather than quietly pick one.

Fingerprints resolve Git LFS pointers. The site `.blend` files are LFS-tracked,
so a checkout holds either the real model or a 131-byte text pointer depending
on whether its LFS objects were ever fetched. An LFS pointer's `oid sha256` is
the SHA-256 of the real content, so reading it through gives one fingerprint
that is identical either way — otherwise every unfetched checkout would report
false drift.

## Two kinds of artifact

|  | outputs tracked? | on drift |
| --- | --- | --- |
| Blender site bake (`.blend` → `.glb`) | yes | **error** — a rebake is a content change that belongs in a commit, and it needs Blender |
| Terrain tiles (`.bin` → `public/data/terrain/`) | no, gitignored | **healed** — every checkout generates its own; a stale one is nobody's decision |

`npm run build` runs `assets-check --heal`, which fixes the second kind and
fails loudly on the first, naming the artifact, the file and the exact command.

An input that is still an unfetched LFS pointer is reported as a **note**, never
a failure: the baked outputs are committed, so the app builds and runs fine
without ever fetching the source model. It only blocks a rebake of that one
artifact.

## Commands

```bash
npm run assets:check    # verify; non-zero exit on drift
npm run assets:heal     # additionally rebake what is safe to rebake (build uses this)
npm run assets:list     # every registered artifact and its state
```

## Editing a Blender site in a worktree

```bash
git lfs pull                                   # only if the .blend is still a pointer
open assets-src/world/sites/<site>.blend       # author
npm run bake:region -- --site <site>           # bake + publish + record
git add assets-src public data data/asset-ledger
git commit                                     # source, outputs and ledger together
```

Committing all three together is the whole contract. Merging that branch carries
the model, everything published from it, and the proof they match — so `main`'s
build passes for the same reason the worktree's did. Miss the rebake and every
machine says so by name on the next build.

Registering a new baked artifact means calling `recordBake()` from its baker
(see `tools/asset-ledger.mjs`); the check picks it up automatically.
