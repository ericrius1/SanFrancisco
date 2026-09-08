# Volumetric sky

Clouds are enabled by default. Their module and WGSL load after the arrival reveal has settled for two seconds, then warm through the existing render compile gate. Changing the tunable definition invalidates that group's previous saved overrides, so the old off-by-default setting does not survive this release.

Open `/` → **advanced → lighting → volumetric clouds**. Controls include average coverage, optical density, cloud size, billowy shapes, wispy edges, base altitude, layer depth, wind speed/direction, shape evolution, evolving weather, cycle duration, and weather variety. Disable evolving weather to hold a chosen cloud type; wind and shape movement have independent controls.

The default twelve-minute cycle smoothly blends six weather fronts, including a mostly clear spell. Coverage, density, scale, billow, wisps and depth change together. Regional noise creates local gaps and variations in cloud form, while wind advects the field and slow domain changes reshape it. The director never overwrites the saved slider values. Set weather variety to zero for a constant climate or average coverage to zero with evolution off for a completely clear sky.

Rendering remains WebGPU-only: 8–12 ray steps, three coherent density-noise octaves, one sun-density sample, a small HDR target pair, and reprojected history. Slow climate changes retain history; abrupt edits, camera jumps, altitude changes and time-of-day jumps invalidate it. The existing laptop profile and resolution governor determine cloud resolution.

Validation: `node --experimental-strip-types tools/cloud-evolution-probe.mjs` checks clear periods, form diversity, continuity, bounds and manual settings. `node tools/clouds-birds-browser-probe.mjs` checks default activation, moving weather uniforms, Tweakpane bindings, clear/wispy/billowy renders and nearby birds outside the old city grid. Set `SF_PROBE_URL` for another server. `tools/cloud-budget-probe.mjs` measures serialized GPU timing; the tested daytime view added 1.46 ms over clear sky on this Mac (adapter-dependent).
