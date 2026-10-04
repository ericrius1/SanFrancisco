import { cos, float, sin, smoothstep, vec2 } from "three/tsl";
import { OCEAN_BEACH_SURF } from "../oceanBeachWaves";
import { PACIFIC_SWELL } from "./pacificSwell";

// TSL node generics fight composition; `any` is the local idiom (see water.ts).
type N = any;

/**
 * GPU twin of pacificSwell.ts. Returns the swell height and its analytic
 * slope (dh/dx, dh/dz) so the shading normal tilts with the geometry — the
 * crests read on the flat far sheets too, where nothing is displaced.
 * `floorHeight` is the bathymetry under the point (the bay floor texture).
 */
export function pacificSwellNode(x: N, z: N, t: N, floorHeight: N): { height: N; slope: N } {
  const s = PACIFIC_SWELL;
  const u = x.sub(z.mul(0.45));
  const open = smoothstep(float(s.uBay), float(s.uOpen), u);
  const b = OCEAN_BEACH_SURF;
  const f = s.stripFeather;
  const inStrip = smoothstep(b.minX - f, b.minX, x)
    .mul(smoothstep(b.maxX, b.maxX + f, x).oneMinus())
    .mul(smoothstep(b.minZ - f, b.minZ, z))
    .mul(smoothstep(b.maxZ, b.maxZ + f, z).oneMinus());
  const shoal = smoothstep(float(s.shoalMin), float(s.shoalMax), floorHeight.negate());
  const gain = open.mul(inStrip.oneMinus()).mul(shoal);
  let height: N = float(0);
  let slope: N = vec2(0, 0);
  for (const tr of s.trains) {
    const phase = x.mul(tr.k * tr.dx).add(z.mul(tr.k * tr.dz)).sub(t.mul(tr.w)).add(tr.p);
    height = height.add(sin(phase).mul(tr.a));
    const c = cos(phase).mul(tr.a * tr.k);
    slope = slope.add(vec2(c.mul(tr.dx), c.mul(tr.dz)));
  }
  return { height: height.mul(gain), slope: slope.mul(gain) };
}
