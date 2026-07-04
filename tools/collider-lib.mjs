// Shared collider-baking math: min-area rects + concave-footprint decomposition.
//
// One min-area rect per building is what physics ships, but a rect over a
// concave footprint (L/C/U blocks, stadium rings) swallows the courtyard: the
// player sprays paint onto thin air and vehicles slam into invisible walls
// there. Instead of one rect, recursively split bad footprints in the rect's
// own frame and re-fit — a ring decomposes into a handful of thin slabs that
// hug the real walls. Convex footprints keep their single rect (ratio gate).

function polySignedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i];
    const [x2, z2] = poly[(i + 1) % poly.length];
    s += x1 * z2 - x2 * z1;
  }
  return s / 2;
}

/** Signed-area magnitude of a polygon (shoelace). */
export function polyArea(poly) {
  return Math.abs(polySignedArea(poly));
}

/** Smallest-area oriented rect over the poly (edge-direction sweep). */
export function minAreaRect(poly) {
  let best = null;
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i];
    const [x2, z2] = poly[(i + 1) % poly.length];
    const len = Math.hypot(x2 - x1, z2 - z1);
    if (len < 0.5) continue;
    const ux = (x2 - x1) / len;
    const uz = (z2 - z1) / len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [px, pz] of poly) {
      const u = px * ux + pz * uz;
      const v = -px * uz + pz * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = {
        area,
        cx: cu * ux - cv * uz,
        cz: cu * uz + cv * ux,
        hx: (maxU - minU) / 2,
        hz: (maxV - minV) / 2,
        yaw: Math.atan2(-uz, ux) // rotation about +Y taking +X onto (ux,uz)
      };
    }
  }
  return best;
}

// world <-> rect-local, matching the runtime's collider frame exactly
// (physics.ts rotates world into the box frame with the same signs)
const toLocal = (r, cos, sin, x, z) => [(x - r.cx) * cos - (z - r.cz) * sin, (x - r.cx) * sin + (z - r.cz) * cos];
const toWorld = (r, cos, sin, u, v) => [r.cx + u * cos + v * sin, r.cz - u * sin + v * cos];

/** Sutherland–Hodgman clip of a polygon against a half-plane keep(u,v) >= 0. */
function clipPoly(pts, side) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const da = side(a);
    const db = side(b);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/**
 * Clip to the half-plane side(p) >= 0, returning each connected piece as its
 * own simple polygon. Sutherland–Hodgman alone joins disjoint lobes of a
 * concave polygon with bridge edges along the cut line; a min-rect over that
 * bridged ring spans the open gap between lobes (an X-shaped block decomposed
 * into 40 thin boxes laced across its own plaza). Instead, walk the ring
 * collecting kept chains, then stitch chain ends pairwise along the cut line:
 * sorted by position on the line, consecutive crossing pairs bound the
 * polygon-interior intervals, so each pair joins exactly one chain tail to one
 * chain head (Jordan). Any degeneracy falls back to the bridged ring —
 * coverage is sacred, spill is merely ugly.
 */
function clipComponents(pts, side, lineT) {
  const n = pts.length;
  // bias points sitting exactly on the line to the kept side: no zero signs,
  // so touching-without-crossing never registers as a crossing
  const d = pts.map((p) => {
    const s = side(p);
    return Math.abs(s) < 1e-7 ? 1e-7 : s;
  });
  if (!d.some((v) => v > 0)) return [];

  let cur = null;
  let first = null;
  const chains = [];
  const cross = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const da = d[i];
    const db = d[(i + 1) % n];
    if (da > 0) {
      if (!cur) {
        cur = { pts: [] };
        chains.push(cur);
        if (i === 0) first = cur;
      }
      cur.pts.push(a);
    }
    if (da > 0 !== db > 0) {
      const t = da / (da - db);
      const ip = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (da > 0) {
        cur.pts.push(ip);
        cross.push({ t: lineT(ip), end: "tail", chain: cur });
        cur = null;
      } else {
        cur = { pts: [ip] };
        chains.push(cur);
        cross.push({ t: lineT(ip), end: "head", chain: cur });
      }
    }
  }
  if (cross.length === 0) return [pts.slice()]; // wholly on the kept side
  // ring wrap: the walk ended mid-chain and vertex 0 opened a chain — same chain
  if (cur && first && cur !== first) {
    first.pts = [...cur.pts, ...first.pts];
    for (const c of cross) if (c.chain === cur) c.chain = first;
    chains.splice(chains.indexOf(cur), 1);
  }

  const bridged = () => {
    const ring = clipPoly(pts, side);
    return ring.length >= 3 ? [ring] : [];
  };
  if (cross.length % 2 !== 0) return bridged();

  cross.sort((x, y) => x.t - y.t);
  const polys = [];
  for (let k = 0; k + 1 < cross.length; k += 2) {
    const A = cross[k];
    const B = cross[k + 1];
    if (A.end === B.end) return bridged(); // pairing broke — degenerate input
    const tail = A.end === "tail" ? A : B;
    const head = A === tail ? B : A;
    if (tail.chain === head.chain) {
      polys.push(tail.chain.pts); // ring closes
      tail.chain.pts = null;
    } else {
      const merged = tail.chain;
      if (!merged.pts || !head.chain.pts) return bridged();
      merged.pts = [...merged.pts, ...head.chain.pts];
      const gone = head.chain;
      for (const c of cross) if (c.chain === gone) c.chain = merged;
      gone.pts = null;
    }
  }
  for (const c of chains) if (c.pts) return bridged(); // unconsumed chain — bail
  return polys.filter((p) => p.length >= 3 && polyArea(p) > 0.5);
}

/** Distance from a point to the polygon boundary; 0 if the point is inside. */
function distOutside(px, pz, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  if (inside) return 0;
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    const dx = xj - xi;
    const dz = zj - zi;
    const L2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((px - xi) * dx + (pz - zi) * dz) / L2));
    d = Math.min(d, Math.hypot(px - (xi + t * dx), pz - (zi + t * dz)));
  }
  return d;
}

/** Worst distance a rect's corner/edge-midpoint pokes OUTSIDE the footprint. */
function rectOvershoot(rect, poly) {
  const cos = Math.cos(rect.yaw);
  const sin = Math.sin(rect.yaw);
  let worst = 0;
  for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const [x, z] = toWorld(rect, cos, sin, u * rect.hx, v * rect.hz);
    worst = Math.max(worst, distOutside(x, z, poly));
  }
  return worst;
}

/**
 * Decompose one footprint into 1..maxBoxes oriented rects, best-first: always
 * split whichever piece wastes the most area, so the box budget chases the
 * phantom instead of bisecting blindly. A piece splits while its rect wastes
 * real area — relatively (rect/poly > ratioGate) OR absolutely
 * (rect - poly > absGate m², so a 20 000 m² block at 1.25× cover still sheds
 * its 5 000 m² phantom plaza) OR while any rect edge pokes further than
 * overGate metres outside the WHOLE building footprint (area gates miss the
 * metre-scale spill on curved/diagonal walls — the wall the player face-plants
 * into on an open sidewalk). Candidate cuts run through the rect center AND
 * every reflex vertex on both rect axes (a cut flush with the concave corner
 * peels a courtyard in one split where center bisection dithers); the pair of
 * child rects wasting least wins. A piece whose every cut degenerates keeps
 * its own rect — coverage is sacred, spill is merely ugly. Returns rects in
 * the same {cx, cz, hx, hz, yaw} shape as minAreaRect.
 */
export function decomposeFootprint(
  poly,
  { ratioGate = 1.3, maxDepth = 10, minArea = 30, absGate = 25, maxBoxes = 72, overGate = 2.0 } = {}
) {
  const mkNode = (pts, depth) => {
    const rect = minAreaRect(pts);
    if (!rect) return null;
    const pa = polyArea(pts);
    // overshoot vs the ROOT footprint: a piece's rect legitimately spills into
    // sibling territory (still building interior); only outside-the-building
    // spill is a phantom wall
    return { pts, depth, pa, rect, waste: rect.area - pa, over: rectOvershoot(rect, poly), dead: false };
  };

  const wantsSplit = (n) =>
    !n.dead &&
    n.depth < maxDepth &&
    ((n.pa >= minArea && (n.rect.area / n.pa > ratioGate || n.waste > absGate)) || (n.pa >= 8 && n.over > overGate));

  const trySplit = (node) => {
    const { rect, pts } = node;
    const cos = Math.cos(rect.yaw);
    const sin = Math.sin(rect.yaw);
    const local = pts.map(([x, z]) => toLocal(rect, cos, sin, x, z));

    // candidate cuts: [axis, offset] — rect center plus reflex-vertex lines
    const cands = [
      [0, 0],
      [1, 0]
    ];
    const seen = new Set(["0:0", "1:0"]);
    const n = local.length;
    const wind = Math.sign(polySignedArea(local)) || 1;
    for (let i = 0; i < n; i++) {
      const a = local[(i + n - 1) % n];
      const b = local[i];
      const c = local[(i + 1) % n];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (cross * wind >= -1e-9) continue; // convex corner — no cut
      for (const axis of [0, 1]) {
        const key = `${axis}:${Math.round(b[axis] * 2)}`;
        if (!seen.has(key)) {
          seen.add(key);
          cands.push([axis, b[axis]]);
        }
      }
    }

    let best = null;
    for (const [axis, off] of cands) {
      const h = axis === 0 ? rect.hx : rect.hz;
      if (Math.abs(off) > h - 0.6) continue; // sliver cut hugging the border
      const lineT = axis === 0 ? (p) => p[1] : (p) => p[0];
      const lo = clipComponents(local, (p) => off - p[axis], lineT);
      const hi = clipComponents(local, (p) => p[axis] - off, lineT);
      if (lo.length === 0 || hi.length === 0) continue;
      const kids = [];
      let score = 0;
      for (const piece of [...lo, ...hi]) {
        const back = piece.map(([u, v]) => toWorld(rect, cos, sin, u, v));
        const kid = mkNode(back, node.depth + 1);
        if (!kid) {
          score = Infinity;
          break;
        }
        kids.push(kid);
        // score the box as physics will ship it — the 0.8 half-extent clamp
        // turns a sliver's "cheap" rect into a fat phantom ribbon
        score += 4 * Math.max(kid.rect.hx, 0.8) * Math.max(kid.rect.hz, 0.8);
      }
      if (kids.length < 2 || !Number.isFinite(score)) continue;
      if (!best || score < best.score) best = { score, kids };
    }
    return best ? best.kids : null;
  };

  const root = mkNode(poly, 0);
  if (!root) return [];
  const nodes = [root];
  // priority folds metre-overshoot in with area waste (3 m of phantom sidewalk
  // wall ≈ 45 m² of phantom plaza) so the budget chases both failure modes
  const prio = (n) => Math.max(n.waste, n.over * 15);
  while (nodes.length < maxBoxes) {
    let pick = null;
    for (const n of nodes) if (wantsSplit(n) && (!pick || prio(n) > prio(pick))) pick = n;
    if (!pick) break;
    const kids = trySplit(pick);
    if (!kids) {
      pick.dead = true; // unsplittable — keeps its rect
      continue;
    }
    nodes.splice(nodes.indexOf(pick), 1, ...kids);
  }
  return nodes.map((n) => n.rect);
}
