// Shared, cached loader for the vendored BuildingGenerator kit. The kit.glb +
// manifest + textures are staged under /public/buildinggen/. We load them exactly
// once for the whole app (one shared promise) and hand every generated building the
// same Kit instance — the kit builds InstancedMeshes per part, so buildings that
// share part meshes still share GPU geometry.
//
// Graceful fallback: if the assets 404 (kit not staged / stripped from a deploy),
// the promise resolves to `null` and callers return an inert stub so the app still
// boots.
import { Kit } from "../../../vendor/BuildingGenerator/src/kit";

const BASE = "/buildinggen";

let kitPromise: Promise<Kit | null> | null = null;

/** Load (or reuse) the shared Kit. Resolves to null if the assets are missing. */
export function loadBuildingKit(): Promise<Kit | null> {
  if (kitPromise) return kitPromise;
  kitPromise = (async () => {
    try {
      // Probe the manifest first so a missing kit fails fast & quietly.
      const probe = await fetch(`${BASE}/kit_manifest.json`, { method: "HEAD" });
      if (!probe.ok) throw new Error(`kit manifest ${probe.status}`);
      const kit = new Kit();
      await kit.load(
        `${BASE}/kit.glb`,
        `${BASE}/kit_manifest.json`,
        `${BASE}/textures`
      );
      // The app lights the world through a custom sun + a faint SkyEnvNode
      // (scene.environmentIntensity ≈ 0.075), so the kit's standard PBR materials
      // read dark on faces the sun doesn't hit — especially in dense blocks where
      // buildings shadow each other. Lift per-material env response so shadowed
      // facades catch more sky fill and match the baked city's ambient.
      for (const name of ["building", "floor"] as const) {
        const m = kit.materials?.[name] as { envMapIntensity?: number } | undefined;
        if (m) m.envMapIntensity = 4;
      }
      return kit;
    } catch (err) {
      console.warn(
        "[buildings] kit assets unavailable — generated buildings disabled.",
        err
      );
      return null;
    }
  })();
  return kitPromise;
}
