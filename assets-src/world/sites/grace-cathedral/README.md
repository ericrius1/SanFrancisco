# Grace Cathedral authored project

`grace-cathedral.blend` is the canonical, independently editable Blender source
for the Nob Hill cathedral. Its `SITE_grace_cathedral` collection is linked into
the human-facing San Francisco master composition and exported separately as
`/regions/grace-cathedral.glb` for proximity streaming in the WebGPU world.

The project uses real-world scale and placement. The visual model includes the
French Gothic cruciform massing, twin east-façade towers, central flèche,
polygonal apse, flying buttresses, a walkable west-rising nave, rib vaulting,
clerestory windows, organ, choir, labyrinth, pews, and the Doors of Paradise.

Official architectural reference:

- <https://gracecathedral.org/architecture/>
- <https://gracecathedral.org/the-cathedrals-treasures/>
- <https://gracecathedral.org/visit-/>

The stained-glass plates are original generated artwork. Run:

```sh
node tools/build-grace-cathedral-textures.mjs
```

to regenerate the production color textures and their raised-lead tangent-space
normal maps from `textures/source/`. Then rebuild the Blender source and publish
the game asset with:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --python tools/create-grace-cathedral-site.py -- --repo "$PWD"
npm run bake:site -- --site grace-cathedral
```

The two source plates are original generated artwork, not reproductions of the
cathedral's existing windows:

- `rose-window-gpt-image.png`: a centered twelve-petal Gothic rose with a
  sunlike center and quatrefoil tracery, faceted Connick-inspired cobalt,
  turquoise, ruby, amber, and violet glass, and raised dark lead/cement.
- `angel-lancet-gpt-image.png`: an abstract angel among stars and leaves with
  subtle San Francisco sun, fog, and bridge motifs, using the same blue-led
  faceted-glass language in a pointed lancet composition.

The runtime light shafts are not baked into the GLB. They are a bounded,
disposable in-world enhancement created only after this authored region becomes
resident and only rendered while a visitor is close to the interior.
