import * as THREE from "three/webgpu";
import type { WorldMap } from "../../world/heightmap";
import { createAuthoredTreePatch } from "../../world/vegetation/authoredTrees";
import { createAuthoredFlowerPatch, type AuthoredFlowerPlacement } from "../../world/vegetation/authoredFlowers";
import { TIDAL_CHOIR_CENTER } from "./meta";
/** Botanical intent only. SiteFoliageStreamer owns admission, warmup and exit. */
export function createChoirVegetation(map: WorldMap) {
    const { x: cx, z: cz } = TIDAL_CHOIR_CENTER;
    const trees = createAuthoredTreePatch([
        { id: "choir-cypress", design: { species: "windswept-monterey-cypress", seed: 9224, controls: { height: 10, crownDensity: 0.95, windResponse: 0.65 }, sink: 0.15 } },
    ], Array.from({ length: 6 }, (_, i) => {
        const angle = Math.PI * (0.9 + i * 0.2);
        const x = cx + Math.cos(angle) * 27, z = cz + Math.sin(angle) * 27;
        return { x, y: map.groundTop(x, z), z, yaw: 1 + i * 0.09, scale: 0.82 + i * 0.04, archetype: "choir-cypress" };
    }), { name: "tidal_choir_cypress", chunkSize: 48, visibleDistance: 650, nearRadius: 65, nearExitRadius: 85, nearMax: 8 });
    const placements: AuthoredFlowerPlacement[] = [];
    for (let i = 0; i < 96; i++) {
        const angle = i * 2.399963;
        const radius = 18 + (i % 8) * 0.75;
        const x = cx + Math.cos(angle) * radius, z = cz + Math.sin(angle) * radius;
        placements.push({ x, y: map.groundTop(x, z) - 0.03, z, yaw: angle, scale: 0.65 + (i % 4) * 0.09, species: i % 3 ? "poppy" : "lupine", tint: (i % 11) / 11 });
    }
    const flowers = createAuthoredFlowerPatch(placements, { name: "tidal_choir_flowers" });
    const group = new THREE.Group();
    group.name = "tidal_choir_vegetation";
    group.add(trees.group, flowers.group);
    return { group, ready: trees.ready, update: trees.update, dispose() { trees.dispose(); flowers.dispose(); group.removeFromParent(); } };
}
