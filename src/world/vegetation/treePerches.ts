import { Vector3, type Object3D, type BufferGeometry } from 'three/webgpu';

/** Metadata only. Tree residency owns these providers; wildlife never loads trees. */
export interface TreePerch { x: number; y: number; z: number; active(): boolean; }
const providers = new Set<{ root: Object3D; bounds: {x:number;z:number;radius:number}; points(): readonly Vector3[]; available(): boolean }>();
const branchCache = new WeakMap<BufferGeometry, Vector3 | null>();
function visible(root: Object3D) {
  let current: Object3D | null = root;
  while (current) { if (!current.visible) return false; if (current.type === 'Scene') return true; current = current.parent; }
  return false;
}
/** Pick an upward-facing surface on an outer branch, never a guessed canopy blob. */
export function branchPerch(geometry: BufferGeometry): Vector3 | null {
  if (branchCache.has(geometry)) return branchCache.get(geometry)!;
  const p = geometry.getAttribute('position'), n = geometry.getAttribute('normal');
  geometry.computeBoundingBox(); const box = geometry.boundingBox!;
  const height = box.max.y - box.min.y;
  let best: Vector3 | null = null, score = -Infinity;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), radius = Math.hypot(p.getX(i), p.getZ(i));
    if (y < box.min.y + height * .42 || y > box.min.y + height * .88 || n.getY(i) < .65 || radius < .5) continue;
    const s = radius + y * .08;
    if (s > score) { score = s; best = new Vector3(p.getX(i), y, p.getZ(i)); }
  }
  branchCache.set(geometry, best); return best;
}
export function registerTreePerches(root: Object3D, bounds: {x:number;z:number;radius:number}, points: () => readonly Vector3[], available = () => true) {
  const provider = { root, bounds, points, available }; providers.add(provider);
  return () => { providers.delete(provider); };
}
export function nearbyTreePerches(x: number, z: number, radius: number, limit = 12): TreePerch[] {
  const candidates: { point: Vector3; root: Object3D; available: () => boolean; distance: number }[] = [];
  for (const provider of providers) {
    if (!visible(provider.root) || !provider.available()) continue;
    provider.root.updateWorldMatrix(true, false);
    const center = new Vector3(provider.bounds.x,0,provider.bounds.z).applyMatrix4(provider.root.matrixWorld);
    const scale = new Vector3().setFromMatrixScale(provider.root.matrixWorld).length();
    if (Math.hypot(center.x-x,center.z-z)>radius+provider.bounds.radius*scale) continue;
    for (const local of provider.points()) {
      const point = local.clone().applyMatrix4(provider.root.matrixWorld);
      const distance = Math.hypot(point.x - x, point.z - z);
      if (distance < radius) candidates.push({ point, root: provider.root, available: provider.available, distance });
    }
  }
  return candidates.sort((a,b) => a.distance-b.distance).slice(0,limit).map(({point,root,available}) => ({x:point.x,y:point.y,z:point.z,active:()=>visible(root)&&available()}));
}
