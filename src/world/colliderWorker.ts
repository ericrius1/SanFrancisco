// Collider fetch + JSON.parse off the main thread: downtown tiles carry up to
// ~280 KB of collider JSON, and lexing that mid-flight was a per-tile frame
// spike. The worker parses, patches the per-box derived fields (yaw trig +
// sub-box ordinal, see BuildingCollider), and ships a flat Float64Array back —
// the main thread only unpacks numbers, never touches the JSON text.

// 13 doubles per box: i,p,x,y,z,hx,hy,hz,yaw,cosYaw,sinYaw,s,vol
export const COLLIDER_FIELDS = 13;

type RawCollider = {
  i: number;
  p: number;
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  yaw: number;
  vol: number;
};

self.onmessage = async (e: MessageEvent<{ id: number; url: string }>) => {
  const { id, url } = e.data;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status}`);
    const list = (await r.json()) as RawCollider[];
    const buf = new Float64Array(list.length * COLLIDER_FIELDS);
    const seen = new Map<number, number>();
    for (let k = 0; k < list.length; k++) {
      const c = list[k];
      const s = seen.get(c.i) ?? 0;
      seen.set(c.i, s + 1);
      const o = k * COLLIDER_FIELDS;
      buf[o] = c.i;
      buf[o + 1] = c.p;
      buf[o + 2] = c.x;
      buf[o + 3] = c.y;
      buf[o + 4] = c.z;
      buf[o + 5] = c.hx;
      buf[o + 6] = c.hy;
      buf[o + 7] = c.hz;
      buf[o + 8] = c.yaw;
      buf[o + 9] = Math.cos(c.yaw);
      buf[o + 10] = Math.sin(c.yaw);
      buf[o + 11] = s;
      buf[o + 12] = c.vol;
    }
    (self as unknown as Worker).postMessage({ id, buf }, [buf.buffer]);
  } catch {
    (self as unknown as Worker).postMessage({ id, buf: null });
  }
};
