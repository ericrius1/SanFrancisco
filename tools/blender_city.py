# San Francisco city builder. Runs inside Blender (4.x) via MCP.
# Coordinates: game/local frame is X east, Z south, Y up (three.js).
# Blender is Z-up: blender_pos = (x, -z, y). glTF export flips back.
#
# Usage from MCP:
#   import sys; sys.path.insert(0, "/Users/eric/codeprojects/sanfrancisco/tools")
#   import blender_city as bc; import importlib; importlib.reload(bc)
#   bc.load_data(); bc.build_preview(); bc.build_all(); bc.export_all()

import bpy
import json
import math
import os
import struct
import time

import numpy as np
from mathutils import Vector
from mathutils.geometry import delaunay_2d_cdt

ROOT = "/Users/eric/codeprojects/sanfrancisco"
CITY_JSON = os.path.join(ROOT, "data/city/city.json")
HEIGHT_BIN = os.path.join(ROOT, "public/data/heightmap.bin")
SURFACE_BIN = os.path.join(ROOT, "public/data/surface.bin")
META_JSON = os.path.join(ROOT, "public/data/meta.json")
TILES_OUT = os.path.join(ROOT, "public/tiles")

# ------------------------------------------------------------------- palettes

def srgb_to_linear(c):
    out = []
    for v in c:
        v /= 255.0
        out.append(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4)
    return tuple(out)

PALETTES = [
    srgb_to_linear((136, 158, 176)),  # 0 glass tower blue-gray
    srgb_to_linear((232, 226, 213)),  # 1 white stucco
    srgb_to_linear((221, 210, 184)),  # 2 cream
    srgb_to_linear((217, 184, 168)),  # 3 pastel rose
    srgb_to_linear((185, 201, 178)),  # 4 pastel mint
    srgb_to_linear((179, 195, 205)),  # 5 pale blue
    srgb_to_linear((176, 117, 85)),   # 6 terracotta brick
    srgb_to_linear((201, 177, 137)),  # 7 warm tan
    srgb_to_linear((168, 162, 154)),  # 8 gray commercial
]
ROOF_MULT = 0.72
ROAD_COLOR = srgb_to_linear((58, 61, 66))
ROAD_MAJOR_COLOR = srgb_to_linear((70, 73, 78))
PARK_COLOR = srgb_to_linear((109, 143, 94))
PIER_COLOR = srgb_to_linear((146, 129, 108))
SAND_COLOR = srgb_to_linear((217, 203, 168))
URBAN_GROUND = srgb_to_linear((183, 176, 164))
GRASS_GROUND = srgb_to_linear((124, 152, 102))
ROCK_COLOR = srgb_to_linear((142, 134, 120))
BAY_SHALLOW = srgb_to_linear((199, 189, 157))
BAY_DEEP = srgb_to_linear((60, 105, 96))
INTL_ORANGE = srgb_to_linear((192, 62, 42))
STEEL_GRAY = srgb_to_linear((139, 143, 148))
WHITE_QUARTZ = srgb_to_linear((222, 217, 206))
SALESFORCE_GLASS = srgb_to_linear((152, 178, 194))
COIT_COLOR = srgb_to_linear((207, 200, 184))
COIT_BASE = srgb_to_linear((189, 181, 164))
COIT_TRIM = srgb_to_linear((221, 215, 200))
COIT_DARK = srgb_to_linear((56, 51, 45))
FERRY_COLOR = srgb_to_linear((214, 205, 185))
SUTRO_RED = srgb_to_linear((196, 78, 60))
SUTRO_WHITE = srgb_to_linear((235, 232, 226))
PFA_COLOR = srgb_to_linear((199, 178, 153))
PFA_TRIM = srgb_to_linear((216, 199, 172))
PFA_DOME = srgb_to_linear((173, 103, 68))
GATE_GREEN = srgb_to_linear((70, 116, 84))
GATE_STONE = srgb_to_linear((168, 158, 146))
GATE_RED = srgb_to_linear((176, 52, 40))
FERRY_TRIM = srgb_to_linear((236, 230, 216))
FERRY_DARK = srgb_to_linear((88, 80, 70))
ALC_WALL = srgb_to_linear((214, 208, 196))
ALC_ROOF = srgb_to_linear((188, 176, 158))
ALC_RUST = srgb_to_linear((152, 108, 82))
ALC_DARK = srgb_to_linear((90, 84, 74))

DATA = {}
TERRAIN_HEIGHT_PROCESS_VERSION = 1


def log(msg):
    print("[bc] " + msg, flush=True)


# ------------------------------------------------------------------ data load

def load_data():
    t0 = time.time()
    with open(CITY_JSON) as f:
        DATA["city"] = json.load(f)
    with open(META_JSON) as f:
        DATA["meta"] = json.load(f)
    grid = DATA["meta"]["grid"]
    W, H = grid["width"], grid["height"]
    DATA["grid"] = grid
    terrain_meta = DATA["meta"].get("terrain", {})
    if terrain_meta.get("heightEncoding") == "int16":
        hm_i16 = np.fromfile(HEIGHT_BIN, dtype=np.int16).reshape(H, W)
        hm = terrain_meta["heightBase"] + hm_i16.astype(np.float32) * terrain_meta["heightQuant"]
    else:
        hm = np.fromfile(HEIGHT_BIN, dtype=np.float32).reshape(H, W)
    sf = np.fromfile(SURFACE_BIN, dtype=np.uint8).reshape(H, W)
    DATA["height"] = hm
    DATA["surface"] = sf
    # Ocean Beach used to be relaxed only in Blender memory, so the beauty GLB
    # could differ by metres from the runtime heightmap/collision surface. Bake
    # that operation into the committed heightmap exactly once, then immediately
    # decode the quantized result back into DATA so every exported vertex matches
    # what WorldMap will sample.
    if terrain_meta.get("heightProcessVersion") != TERRAIN_HEIGHT_PROCESS_VERSION:
        smooth_coast()
        persist_processed_heightmap()
    else:
        DATA["coast_smoothed"] = True
        log(f"terrain height process v{TERRAIN_HEIGHT_PROCESS_VERSION}: already canonical")
    log(f"loaded city.json tiles={len(DATA['city']['tiles'])} heightmap {W}x{H} in {time.time()-t0:.1f}s")
    return {"tiles": len(DATA["city"]["tiles"])}


def _dilate(mask):
    """4-neighbour binary dilation (no scipy dependency)."""
    out = mask.copy()
    out[1:, :] |= mask[:-1, :]
    out[:-1, :] |= mask[1:, :]
    out[:, 1:] |= mask[:, :-1]
    out[:, :-1] |= mask[:, 1:]
    return out


def _box_blur(a, radius=1):
    """Separable box blur over a float array, `radius` cells each way, edge-clamped."""
    out = a.astype(np.float32)
    for _ in range(radius):
        acc = out.copy()
        acc[1:, :] += out[:-1, :]
        acc[:-1, :] += out[1:, :]
        acc[:, 1:] += out[:, :-1]
        acc[:, :-1] += out[:, 1:]
        cnt = np.full(out.shape, 5.0, np.float32)
        cnt[0, :] -= 1; cnt[-1, :] -= 1; cnt[:, 0] -= 1; cnt[:, -1] -= 1
        out = acc / cnt
    return out


# Coastal relax: how far to grow the sand band, how hard to smooth, and the
# height window it applies over (never touch the deep bay floor or high bluffs).
COAST_DILATE = 7
COAST_SMOOTH_ITERS = 5
COAST_HEIGHT_WINDOW = 20.0


def smooth_coast():
    """Relax the height field across the sandy coastal band so beaches read as a
    clean shoaling slope instead of blocky 8/16 m steps — the low-poly beach that
    lets the flat ocean clip through. Localized to sand plus the adjacent shallow
    water and backshore, feathered so inland terrain and the deep bay are left
    exactly as-is. Idempotent + cached. Feeds BOTH the visual terrain mesh and
    (when re-encoded) the physics heightmap, so ground and water stay matched."""
    if DATA.get("coast_smoothed"):
        return DATA["coast_band"]
    hm = DATA["height"]
    sf = DATA["surface"]
    band = sf == 2  # sand
    for _ in range(COAST_DILATE):
        band = _dilate(band)
    band &= np.abs(hm) < COAST_HEIGHT_WINDOW  # keep off the deep bay + tall bluffs
    feather = _box_blur(band.astype(np.float32), 3)  # soft 0..1 edge
    sm = hm
    for _ in range(COAST_SMOOTH_ITERS):
        sm = _box_blur(sm, 1)
    DATA["height"] = hm * (1 - feather) + sm * feather
    DATA["coast_band"] = band
    DATA["coast_smoothed"] = True
    log(f"coast smooth: relaxed {int(band.sum())} coastal cells")
    return band


def persist_processed_heightmap():
    """Atomically commit Blender's processed height surface for runtime parity.

    This is part of the terrain bake, not a legacy migration: prepare-city emits
    a fresh unprocessed DEM and removes the marker; the next Blender terrain bake
    applies the one current process and writes the current schema again.
    """
    terrain = DATA["meta"].setdefault("terrain", {})
    hm = DATA["height"]
    encoding = terrain.get("heightEncoding")
    height_tmp = HEIGHT_BIN + ".tmp"
    if encoding == "int16":
        base = float(terrain["heightBase"])
        quant = float(terrain["heightQuant"])
        encoded = np.rint((hm - base) / quant)
        if encoded.min() < np.iinfo(np.int16).min or encoded.max() > np.iinfo(np.int16).max:
            raise ValueError("processed heightfield exceeds int16 terrain encoding")
        encoded = encoded.astype(np.int16)
        encoded.tofile(height_tmp)
        # Use the exact quantized samples for the mesh that runtime will decode.
        DATA["height"] = base + encoded.astype(np.float32) * quant
    else:
        np.asarray(hm, dtype=np.float32).tofile(height_tmp)
        DATA["height"] = np.asarray(hm, dtype=np.float32)
    os.replace(height_tmp, HEIGHT_BIN)

    terrain["heightProcessVersion"] = TERRAIN_HEIGHT_PROCESS_VERSION
    meta_tmp = META_JSON + ".tmp"
    with open(meta_tmp, "w") as f:
        json.dump(DATA["meta"], f, indent=2)
        f.write("\n")
    os.replace(meta_tmp, META_JSON)
    log(
        f"terrain height process v{TERRAIN_HEIGHT_PROCESS_VERSION}: "
        "committed canonical visual/physics heightmap"
    )


def sample_height(xs, zs):
    """Vectorized bilinear sample of game-frame (x, z) arrays -> heights."""
    grid = DATA["grid"]
    hm = DATA["height"]
    W, H = grid["width"], grid["height"]
    cell, minx, minz = grid["cellSize"], grid["minX"], grid["minZ"]
    fx = np.clip((np.asarray(xs) - minx) / cell, 0, W - 2)
    fy = np.clip((np.asarray(zs) - minz) / cell, 0, H - 2)
    ix = fx.astype(np.int32)
    iy = fy.astype(np.int32)
    ax = fx - ix
    ay = fy - iy
    h00 = hm[iy, ix]
    h10 = hm[iy, ix + 1]
    h01 = hm[iy + 1, ix]
    h11 = hm[iy + 1, ix + 1]
    return (h00 * (1 - ax) + h10 * ax) * (1 - ay) + (h01 * (1 - ax) + h11 * ax) * ay


# ----------------------------------------------------------------- primitives

def get_material():
    mat = bpy.data.materials.get("CityVC")
    if mat is None:
        mat = bpy.data.materials.new("CityVC")
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        bsdf = nodes.get("Principled BSDF")
        attr = nodes.new("ShaderNodeVertexColor")
        attr.layer_name = "Col"
        links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
        bsdf.inputs["Roughness"].default_value = 0.85
    return mat


def get_water_material():
    mat = bpy.data.materials.get("WATER")
    if mat is None:
        mat = bpy.data.materials.new("WATER")
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        bsdf.inputs["Base Color"].default_value = (0.1, 0.45, 0.42, 1)
        bsdf.inputs["Roughness"].default_value = 0.1
    return mat


def ensure_collection(name, parent=None):
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
        (parent or bpy.context.scene.collection).children.link(coll)
    return coll


def make_mesh_object(
    name,
    verts,
    faces,
    corner_colors,
    collection,
    vert_bids=None,
    smooth_face_count=0,
    corner_normals=None,
):
    """verts: [(bx,by,bz)...] blender coords; faces: index lists;
    corner_colors: flat list of (r,g,b,1) per face corner, same order as faces.
    vert_bids: optional per-vertex float building index -> exported as _BID.
    smooth_face_count: leading polygons that use interpolated/custom normals.
    corner_normals: optional per-face-corner custom normals, aligned with loops.
    """
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    if corner_colors is not None:
        col = mesh.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
        flat = np.asarray(corner_colors, dtype=np.float32).reshape(-1)
        col.data.foreach_set("color", flat)
    if vert_bids is not None:
        attr = mesh.attributes.new("_BID", "FLOAT", "POINT")
        attr.data.foreach_set("value", np.asarray(vert_bids, dtype=np.float32))
    if smooth_face_count:
        for poly in mesh.polygons:
            poly.use_smooth = poly.index < smooth_face_count
    if corner_normals is not None:
        if len(corner_normals) != len(mesh.loops):
            raise ValueError(
                f"{name}: {len(corner_normals)} custom corner normals != {len(mesh.loops)} loops"
            )
        # Zero vectors preserve Blender's generated face normal, which is what
        # the hard chunk skirts want. Terrain top loops carry deterministic
        # global heightfield normals so adjacent chunks shade identically.
        mesh.normals_split_custom_set(corner_normals)
    mesh.materials.append(get_material())
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def poly_area_signed(poly):
    a = 0.0
    n = len(poly)
    for i in range(n):
        x1, z1 = poly[i]
        x2, z2 = poly[(i + 1) % n]
        a += x1 * z2 - x2 * z1
    return a / 2.0


# --------------------------------------------------------------- tile builders

def build_tile_buildings(key, tile, collection):
    verts = []
    faces = []
    colors = []
    bids = []
    for bi, b in enumerate(tile.get("buildings", [])):
        poly = b["poly"]
        n = len(poly)
        if n < 3:
            continue
        bid = float(b.get("i", bi))
        base = b["base"]
        top = b["top"]
        color = PALETTES[b.get("p", 8) % len(PALETTES)]
        # jitter per building for variety
        jit = 0.86 + ((b["id"] * 2654435761) % 1000) / 1000.0 * 0.28
        wall = (min(color[0] * jit, 1.0), min(color[1] * jit, 1.0), min(color[2] * jit, 1.0), 1.0)
        roof = (wall[0] * ROOF_MULT, wall[1] * ROOF_MULT, wall[2] * ROOF_MULT, 1.0)

        # blender coords: (x, -z). Ensure CCW in blender frame for outward walls.
        bpoly = [(p[0], -p[1]) for p in poly]
        if poly_area_signed(bpoly) < 0:
            bpoly.reverse()
        i0 = len(verts)
        for (bx, by) in bpoly:
            verts.append((bx, by, base))
        for (bx, by) in bpoly:
            verts.append((bx, by, top))
        bids.extend([bid] * (n * 2))
        for i in range(n):
            j = (i + 1) % n
            faces.append((i0 + i, i0 + j, i0 + n + j, i0 + n + i))
            colors.extend([wall, wall, wall, wall])
        faces.append(tuple(i0 + n + i for i in range(n)))
        colors.extend([roof] * n)
    if not verts:
        return None
    return make_mesh_object(f"bld_{key}", verts, faces, colors, collection, vert_bids=bids)


ROAD_SUBSTEP = 12.0


def densify_polyline(pts, step=ROAD_SUBSTEP):
    """Insert points so no segment exceeds `step` metres. OSM nodes sit at
    intersections/curves only, so a straight block over a hill crest used to be
    one 100m+ segment — the ribbon tunnelled into the rise (or floated over the
    dip) because heights are sampled per point."""
    out = [pts[0]]
    for i in range(len(pts) - 1):
        x1, z1 = pts[i]
        x2, z2 = pts[i + 1]
        n = max(1, int(math.ceil(math.hypot(x2 - x1, z2 - z1) / step)))
        for s in range(1, n + 1):
            t = s / n
            out.append((x1 + (x2 - x1) * t, z1 + (z2 - z1) * t))
    return out


def build_tile_roads(key, tile, collection):
    verts = []
    faces = []
    colors = []
    meta = DATA["meta"]
    for road in tile.get("roads", []):
        pts = road["pts"]
        if len(pts) < 2:
            continue
        pts = densify_polyline(pts)
        w = road["w"] / 2.0
        color = ROAD_MAJOR_COLOR if road.get("major") else ROAD_COLOR
        c4 = (color[0], color[1], color[2], 1.0)
        xs = np.array([p[0] for p in pts], dtype=np.float64)
        zs = np.array([p[1] for p in pts], dtype=np.float64)
        hs = np.maximum(sample_height(xs, zs), 0.15) + 0.3
        gg_mask = None
        if road.get("bridge"):
            hs = np.maximum(hs, bridge_deck_heights(xs, zs, meta))
            # the Golden Gate deck gets its own modelled roadway
            # (lm_bridge_goldengate + runtime asphalt) — the flat OSM ribbon is
            # wider than the deck and pokes out both sides, so suppress it there
            gg = meta["bridges"][0]
            ggh = bridge_deck_heights(xs, zs, {"bridges": [gg]})
            gg_mask = ggh > -1e8
        n = len(pts)
        # per-point perpendicular (average of segment normals)
        dxs = np.gradient(xs)
        dzs = np.gradient(zs)
        lens = np.hypot(dxs, dzs)
        lens[lens < 1e-6] = 1.0
        nx = -dzs / lens
        nz = dxs / lens
        i0 = len(verts)
        for i in range(n):
            lx = xs[i] + nx[i] * w
            lz = zs[i] + nz[i] * w
            rx = xs[i] - nx[i] * w
            rz = zs[i] - nz[i] * w
            verts.append((lx, -lz, hs[i]))
            verts.append((rx, -rz, hs[i]))
        for i in range(n - 1):
            if gg_mask is not None and (gg_mask[i] or gg_mask[i + 1]):
                continue
            a = i0 + i * 2
            faces.append((a, a + 2, a + 3, a + 1))
            colors.extend([c4, c4, c4, c4])
    if not verts:
        return None
    return make_mesh_object(f"road_{key}", verts, faces, colors, collection)


def bridge_deck_heights(xs, zs, meta):
    """Max deck height over all bridges for given points (else -inf)."""
    out = np.full(len(xs), -1e9)
    for br in meta["bridges"]:
        line = br["line"]
        for i in range(len(line) - 1):
            x1, z1, h1 = line[i]
            x2, z2, h2 = line[i + 1]
            dx, dz = x2 - x1, z2 - z1
            ll = dx * dx + dz * dz
            t = np.clip(((xs - x1) * dx + (zs - z1) * dz) / ll, 0, 1)
            px = x1 + t * dx
            pz = z1 + t * dz
            d = np.hypot(xs - px, zs - pz)
            hh = h1 + t * (h2 - h1)
            near = d < br["width"] * 1.2
            out = np.where(near, np.maximum(out, hh), out)
    return out


PARK_LIFT = 0.15
PARK_GRID = 8.0  # interior point spacing = heightmap resolution


def conforming_park(poly):
    """Constrained-Delaunay triangulation of a park polygon with interior
    steiner points every PARK_GRID metres, so the lawn can drape over the
    heightmap. The old single flat n-gon spanned the whole hill as one plate —
    it jutted out of the downhill side and buried itself uphill.
    poly: [(x, z)...] game frame. Returns (pts_blender_2d, tri_faces) or None."""
    n = len(poly)
    if n < 3:
        return None
    # blender 2D frame (x, -z) so CCW faces come out facing +Z up
    pts = [Vector((float(x), float(-z))) for x, z in poly]
    minx = min(p[0] for p in poly)
    maxx = max(p[0] for p in poly)
    minz = min(p[1] for p in poly)
    maxz = max(p[1] for p in poly)
    gxs = np.arange(math.floor(minx / PARK_GRID) * PARK_GRID + PARK_GRID, maxx, PARK_GRID)
    gzs = np.arange(math.floor(minz / PARK_GRID) * PARK_GRID + PARK_GRID, maxz, PARK_GRID)
    if gxs.size and gzs.size:
        gx, gz = np.meshgrid(gxs, gzs)
        px = gx.ravel()
        pz = gz.ravel()
        inside = np.zeros(px.shape, dtype=bool)
        for i in range(n):
            x1, z1 = poly[i]
            x2, z2 = poly[(i + 1) % n]
            if z1 == z2:
                continue
            hit = ((z1 > pz) != (z2 > pz)) & (px < (x2 - x1) * (pz - z1) / (z2 - z1) + x1)
            inside ^= hit
        for x, z in zip(px[inside], pz[inside]):
            pts.append(Vector((float(x), float(-z))))
    try:
        vout, _, tris, _, _, _ = delaunay_2d_cdt(pts, [], [list(range(n))], 1, 1e-4)
    except Exception:
        return None
    if not tris:
        return None
    return [(v.x, v.y) for v in vout], tris


def build_tile_green(key, tile, collection):
    verts = []
    faces = []
    colors = []
    c4 = (PARK_COLOR[0], PARK_COLOR[1], PARK_COLOR[2], 1.0)
    skipped = 0
    for k, poly in enumerate(tile.get("green", [])):
        res = conforming_park(poly)
        if res is None:
            skipped += 1
            continue
        pts2d, tris = res
        # nested lawns (park + playground + garden rings) all drape the same
        # terrain now — stagger the lift so coincident layers don't z-fight
        lift = PARK_LIFT + (k % 4) * 0.05
        xs = np.array([p[0] for p in pts2d])
        zs = np.array([-p[1] for p in pts2d])
        hs = sample_height(xs, zs) + lift
        i0 = len(verts)
        for i, (bx, by) in enumerate(pts2d):
            verts.append((bx, by, float(hs[i])))
        for tri in tris:
            faces.append(tuple(i0 + i for i in tri))
            colors.extend([c4] * len(tri))
    if skipped:
        log(f"grn_{key}: skipped {skipped} degenerate park polys")
    for poly in tile.get("piers", []):
        n = len(poly)
        if n < 3:
            continue
        bpoly = [(p[0], -p[1]) for p in poly]
        if poly_area_signed(bpoly) < 0:
            bpoly.reverse()
        c4p = (PIER_COLOR[0], PIER_COLOR[1], PIER_COLOR[2], 1.0)
        dark = (c4p[0] * 0.6, c4p[1] * 0.6, c4p[2] * 0.6, 1.0)
        i0 = len(verts)
        for (bx, by) in bpoly:
            verts.append((bx, by, 1.0))
        for (bx, by) in bpoly:
            verts.append((bx, by, 3.6))
        for i in range(n):
            j = (i + 1) % n
            faces.append((i0 + i, i0 + j, i0 + n + j, i0 + n + i))
            colors.extend([dark] * 4)
        faces.append(tuple(i0 + n + i for i in range(n)))
        colors.extend([c4p] * n)
    if not verts:
        return None
    return make_mesh_object(f"grn_{key}", verts, faces, colors, collection)


def build_tile(key, collection=None):
    tile = DATA["city"]["tiles"].get(key)
    if tile is None:
        return None
    coll = collection or ensure_collection(f"tile_{key}")
    objs = []
    for fn in (build_tile_buildings, build_tile_roads, build_tile_green):
        o = fn(key, tile, coll)
        if o:
            objs.append(o)
    return objs


# ------------------------------------------------------------------- terrain

TERRAIN_CHUNK = 3200
TERRAIN_STEP = 8


def build_terrain_chunk(cx, cz, collection):
    """One full-resolution 8 m heightfield chunk with skirts + vertex colors.

    Every top vertex is a canonical runtime heightmap sample. Custom normals use
    global central differences, so the top shades smoothly without the per-face
    normal splits that previously quadrupled many exported positions, and chunk
    edges receive the same normal from both neighbours. Skirts remain hard/flat.
    """
    grid = DATA["grid"]
    minx, minz, cell = grid["minX"], grid["minZ"], grid["cellSize"]
    W, H = grid["width"], grid["height"]
    hm = DATA["height"]
    sf = DATA["surface"]
    QX = W - 1
    QY = H - 1
    quads_per_chunk = TERRAIN_CHUNK // TERRAIN_STEP
    q0x = cx * quads_per_chunk
    q0y = cz * quads_per_chunk
    q1x = min(q0x + quads_per_chunk, QX)
    q1y = min(q0y + quads_per_chunk, QY)
    if q0x >= QX or q0y >= QY:
        return None

    verts = []
    faces = []
    colors = []
    corner_normals = []
    vertex_normals = []
    vidx = {}

    def vert(ix, iy):
        """ix, iy: heightmap (8m) lattice indices. Dedupes shared corners."""
        k = vidx.get((ix, iy))
        if k is None:
            k = len(verts)
            verts.append((minx + ix * cell, -(minz + iy * cell), float(hm[iy, ix])))
            x0, x1 = max(0, ix - 1), min(W - 1, ix + 1)
            y0, y1 = max(0, iy - 1), min(H - 1, iy + 1)
            dhdx = float(hm[iy, x1] - hm[iy, x0]) / ((x1 - x0) * cell)
            dhdz = float(hm[y1, ix] - hm[y0, ix]) / ((y1 - y0) * cell)
            # Blender frame is (game X, -game Z, game Y).
            nx, ny, nz = -dhdx, dhdz, 1.0
            inv = 1.0 / math.sqrt(nx * nx + ny * ny + nz * nz)
            vertex_normals.append((nx * inv, ny * inv, nz * inv))
            vidx[(ix, iy)] = k
        return k

    def col_at(ix, iy):
        s = sf[iy, ix]
        h = hm[iy, ix]
        if s == 3:
            t = min(max((-h - 1.5) / 13.0, 0), 1)
            return (
                BAY_SHALLOW[0] + (BAY_DEEP[0] - BAY_SHALLOW[0]) * t,
                BAY_SHALLOW[1] + (BAY_DEEP[1] - BAY_SHALLOW[1]) * t,
                BAY_SHALLOW[2] + (BAY_DEEP[2] - BAY_SHALLOW[2]) * t,
                1.0,
            )
        if s == 2:
            return (SAND_COLOR[0], SAND_COLOR[1], SAND_COLOR[2], 1.0)
        if s == 1:
            return (GRASS_GROUND[0], GRASS_GROUND[1], GRASS_GROUND[2], 1.0)
        if h > 120:
            return (ROCK_COLOR[0], ROCK_COLOR[1], ROCK_COLOR[2], 1.0)
        return (URBAN_GROUND[0], URBAN_GROUND[1], URBAN_GROUND[2], 1.0)

    def emit_quad(ax, ay, bx, by, cx_, cy_, dx, dy):
        # winding matches the old grid: (i,j) (i,j+1) (i+1,j+1) (i+1,j) in
        # blender's mirrored frame keeps normals up
        face = (vert(ax, ay), vert(bx, by), vert(cx_, cy_), vert(dx, dy))
        faces.append(face)
        colors.extend([col_at(ax, ay), col_at(bx, by), col_at(cx_, cy_), col_at(dx, dy)])
        corner_normals.extend(vertex_normals[i] for i in face)

    for qy in range(q0y, q1y):
        for qx in range(q0x, q1x):
            emit_quad(qx, qy, qx, qy + 1, qx + 1, qy + 1, qx + 1, qy)

    if not faces:
        return None

    top_face_count = len(faces)

    # Skirts hang from the chunk border ring. Their zero custom normals preserve
    # Blender's hard face normals instead of blending the vertical wall into the
    # smoothly shaded terrain top.
    skirt_drop = 40.0

    def add_skirt(border_keys):
        ring = [vidx[k] for k in border_keys if k in vidx]
        if len(ring) < 2:
            return
        base_idx = len(verts)
        for k in ring:
            v = verts[k]
            verts.append((v[0], v[1], v[2] - skirt_drop))
        col = (URBAN_GROUND[0] * 0.5, URBAN_GROUND[1] * 0.5, URBAN_GROUND[2] * 0.5, 1.0)
        for t in range(len(ring) - 1):
            a, b = ring[t], ring[t + 1]
            c, d = base_idx + t + 1, base_idx + t
            faces.append((d, c, b, a))
            colors.extend([col] * 4)
            corner_normals.extend([(0.0, 0.0, 0.0)] * 4)

    ix0 = q0x
    ix1 = q1x
    iy0 = q0y
    iy1 = q1y
    add_skirt([(ix, iy0) for ix in range(ix0, ix1 + 1)])
    add_skirt([(ix, iy1) for ix in range(ix0, ix1 + 1)])
    add_skirt([(ix0, iy) for iy in range(iy0, iy1 + 1)])
    add_skirt([(ix1, iy) for iy in range(iy0, iy1 + 1)])

    return make_mesh_object(
        f"terrain_{cx}_{cz}",
        verts,
        faces,
        colors,
        collection,
        smooth_face_count=top_face_count,
        corner_normals=corner_normals,
    )


def build_terrain(collection=None):
    grid = DATA["grid"]
    coll = collection or ensure_collection("terrain")
    n_cx = math.ceil(((grid["width"] - 1) * grid["cellSize"]) / TERRAIN_CHUNK)
    n_cz = math.ceil(((grid["height"] - 1) * grid["cellSize"]) / TERRAIN_CHUNK)
    made = 0
    for cz in range(int(n_cz)):
        for cx in range(int(n_cx)):
            build_terrain_chunk(cx, cz, coll)
            made += 1
    log(f"terrain chunks: {made}")
    return made


def build_water():
    grid = DATA["grid"]
    minx, minz, cell = grid["minX"], grid["minZ"], grid["cellSize"]
    w = grid["width"] * cell
    h = grid["height"] * cell
    coll = ensure_collection("water")
    mesh = bpy.data.meshes.new("WATER_bay")
    margin = 3000
    x0, x1 = minx - margin, minx + w + margin
    z0, z1 = minz - margin, minz + h + margin
    verts = [(x0, -z0, 0), (x1, -z0, 0), (x1, -z1, 0), (x0, -z1, 0)]
    mesh.from_pydata(verts, [], [(0, 3, 2, 1)])
    mesh.update()
    mesh.materials.append(get_water_material())
    obj = bpy.data.objects.new("WATER_bay", mesh)
    coll.objects.link(obj)
    return obj


# ------------------------------------------------------------------ landmarks

def lm_collection():
    return ensure_collection("landmarks")


# Landmark physics proxies. Landmarks are always-resident meshes outside the
# OSM tile pipeline, so bake-colliders.mjs can't see them — the builders below
# emit explicit box proxies alongside the visuals (same locals, so a visual
# tweak updates its collider in the same rebake). Written to
# data/landmark-colliders.json; bake-colliders.mjs merges them into the
# per-tile collider files with i >= 100000 (runtime: always alive, never
# fracturable). GAME frame: x east, z south, y up; game yaw happens to equal
# the blender-frame yaw used by the visual helpers (y_blender = -z_game flips
# both the axis and the angle sign).
LM_COLLIDERS = []


def cbox(lm, x, z, y0, y1, hx, hz, yaw=0.0):
    LM_COLLIDERS.append({
        "lm": lm,
        "x": round(x, 1), "z": round(z, 1),
        "y": round((y0 + y1) / 2, 1), "hy": round((y1 - y0) / 2, 1),
        "hx": round(hx, 1), "hz": round(hz, 1),
        "yaw": round(yaw, 3),
    })


def ccyl(lm, x, z, y0, y1, r, k=8, t=1.5):
    """Cylinder wall proxy: k tangent slabs forming a k-gon ring (hollow —
    fine for shafts/pedestals nobody stands inside). Face plane splits the
    polygon-vs-circumradius error so slabs neither poke nor sink > ~0.6 m."""
    face = r * (1 + math.cos(math.pi / k)) / 2
    rc = face - t
    hx = r * math.sin(math.pi / k) + t
    for j in range(k):
        phi = 2 * math.pi * j / k
        cbox(lm, x + rc * math.cos(phi), z + rc * math.sin(phi), y0, y1,
             hx, t, yaw=math.pi / 2 - phi)


def write_lm_colliders():
    path = os.path.join(ROOT, "data/landmark-colliders.json")
    with open(path, "w") as f:
        json.dump(LM_COLLIDERS, f)
    log(f"landmark colliders: {len(LM_COLLIDERS)} boxes -> {path}")


def add_box(verts, faces, colors, cx, cy, cz, hx, hy, hz, color, yaw=0.0):
    """Blender-frame box (cx, cy=blender y, cz=height center)."""
    i0 = len(verts)
    ca, sa = math.cos(yaw), math.sin(yaw)
    for dz in (-hz, hz):
        for (dx, dy) in ((-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)):
            rx = dx * ca - dy * sa
            ry = dx * sa + dy * ca
            verts.append((cx + rx, cy + ry, cz + dz))
    quads = [
        (3, 2, 1, 0), (4, 5, 6, 7),
        (1, 5, 4, 0), (2, 6, 5, 1), (3, 7, 6, 2), (0, 4, 7, 3),
    ]
    c4 = (color[0], color[1], color[2], 1.0)
    for q in quads:
        faces.append(tuple(i0 + k for k in q))
        colors.extend([c4] * 4)


def add_cylinder(verts, faces, colors, cx, cy, z0, z1, r, color, seg=14, r_top=None, cap_bottom=True):
    i0 = len(verts)
    r2 = r if r_top is None else r_top
    for i in range(seg):
        a = 2 * math.pi * i / seg
        verts.append((cx + r * math.cos(a), cy + r * math.sin(a), z0))
    for i in range(seg):
        a = 2 * math.pi * i / seg
        verts.append((cx + r2 * math.cos(a), cy + r2 * math.sin(a), z1))
    c4 = (color[0], color[1], color[2], 1.0)
    for i in range(seg):
        j = (i + 1) % seg
        # bottom ring is CCW seen from +Z, so walk bottom->top for outward normals
        faces.append((i0 + i, i0 + j, i0 + seg + j, i0 + seg + i))
        colors.extend([c4] * 4)
    faces.append(tuple(i0 + seg + i for i in range(seg)))
    colors.extend([c4] * seg)
    if cap_bottom:
        faces.append(tuple(i0 + seg - 1 - i for i in range(seg)))
        colors.extend([c4] * seg)


def add_fluted_cylinder(verts, faces, colors, cx, cy, z0, z1, r0, r1, flutes, depth, color):
    """Vertical-ribbed tapered shaft (Coit-style fluting): alternating
    ridge/valley radii read as concave channels under flat shading."""
    n = flutes * 2
    i0 = len(verts)
    c4 = (color[0], color[1], color[2], 1.0)
    for (r, z) in ((r0, z0), (r1, z1)):
        for i in range(n):
            a = 2 * math.pi * i / n
            rr = r if i % 2 == 0 else r - depth
            verts.append((cx + rr * math.cos(a), cy + rr * math.sin(a), z))
    for i in range(n):
        j = (i + 1) % n
        faces.append((i0 + i, i0 + j, i0 + n + j, i0 + n + i))
        colors.extend([c4] * 4)
    faces.append(tuple(i0 + n + i for i in range(n)))
    colors.extend([c4] * n)
    faces.append(tuple(i0 + n - 1 - i for i in range(n)))
    colors.extend([c4] * n)


def _arc_wall_quad(verts, faces, colors, cx, cy, r, a0, a1, zb0, zb1, z_top, c4):
    """One cylindrical wall strip; bottom edge heights may differ per side."""
    i0 = len(verts)
    verts.append((cx + r * math.cos(a0), cy + r * math.sin(a0), zb0))
    verts.append((cx + r * math.cos(a1), cy + r * math.sin(a1), zb1))
    verts.append((cx + r * math.cos(a1), cy + r * math.sin(a1), z_top))
    verts.append((cx + r * math.cos(a0), cy + r * math.sin(a0), z_top))
    faces.append((i0, i0 + 1, i0 + 2, i0 + 3))
    colors.extend([c4] * 4)


def add_arcade(verts, faces, colors, cx, cy, z_floor, z_top, r, n_arch,
               z_sill, z_spring, rise, open_frac, color, arch_seg=5):
    """Cylindrical gallery wall pierced by arched openings. Piers between
    openings run full height; each opening has a sill wall below z_sill and a
    semicircular arch head (apex z_spring+rise) hanging from z_top. Pair with
    a darker inner core cylinder so openings read as shadowed voids."""
    c4 = (color[0], color[1], color[2], 1.0)
    step = 2 * math.pi / n_arch
    half_open = step * open_frac / 2
    for k in range(n_arch):
        a_mid = k * step
        # pier: from end of this opening to start of the next
        _arc_wall_quad(verts, faces, colors, cx, cy, r,
                       a_mid + half_open, a_mid + step - half_open,
                       z_floor, z_floor, z_top, c4)
        # sill below the opening
        _arc_wall_quad(verts, faces, colors, cx, cy, r,
                       a_mid - half_open, a_mid + half_open,
                       z_floor, z_floor, z_sill, c4)
        # arch head strips across the opening
        for s in range(arch_seg):
            t0 = -1 + 2 * s / arch_seg
            t1 = -1 + 2 * (s + 1) / arch_seg
            zb0 = z_spring + rise * math.sqrt(max(0.0, 1 - t0 * t0))
            zb1 = z_spring + rise * math.sqrt(max(0.0, 1 - t1 * t1))
            _arc_wall_quad(verts, faces, colors, cx, cy, r,
                           a_mid + t0 * half_open, a_mid + t1 * half_open,
                           zb0, zb1, z_top, c4)


def add_frustum(verts, faces, colors, cx, cy, z0, z1, h0, h1, color, yaw=0.0):
    """Watertight 4-sided tapered prism: half-width h0 at z0 -> h1 at z1."""
    i0 = len(verts)
    ca, sa = math.cos(yaw), math.sin(yaw)
    for (h, z) in ((h0, z0), (h1, z1)):
        for (dx, dy) in ((-h, -h), (h, -h), (h, h), (-h, h)):
            rx = dx * ca - dy * sa
            ry = dx * sa + dy * ca
            verts.append((cx + rx, cy + ry, z))
    quads = [
        (3, 2, 1, 0), (4, 5, 6, 7),
        (1, 5, 4, 0), (2, 6, 5, 1), (3, 7, 6, 2), (0, 4, 7, 3),
    ]
    c4 = (color[0], color[1], color[2], 1.0)
    for q in quads:
        faces.append(tuple(i0 + k for k in q))
        colors.extend([c4] * 4)


def catenary_points(p0, p1, sag, steps):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        x = p0[0] + (p1[0] - p0[0]) * t
        y = p0[1] + (p1[1] - p0[1]) * t
        z = p0[2] + (p1[2] - p0[2]) * t - sag * 4 * t * (1 - t)
        pts.append((x, y, z))
    return pts


def add_tube(verts, faces, colors, pts, r, color):
    """Square tube along pts (blender frame)."""
    c4 = (color[0], color[1], color[2], 1.0)
    rings = []
    for i, p in enumerate(pts):
        if i < len(pts) - 1:
            d = (pts[i + 1][0] - p[0], pts[i + 1][1] - p[1], pts[i + 1][2] - p[2])
        else:
            d = (p[0] - pts[i - 1][0], p[1] - pts[i - 1][1], p[2] - pts[i - 1][2])
        dl = math.sqrt(d[0] ** 2 + d[1] ** 2 + d[2] ** 2) or 1
        d = (d[0] / dl, d[1] / dl, d[2] / dl)
        up = (0, 0, 1) if abs(d[2]) < 0.9 else (1, 0, 0)
        sx = (d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0])
        sl = math.sqrt(sx[0] ** 2 + sx[1] ** 2 + sx[2] ** 2) or 1
        sx = (sx[0] / sl * r, sx[1] / sl * r, sx[2] / sl * r)
        sy = (d[1] * sx[2] - d[2] * sx[1], d[2] * sx[0] - d[0] * sx[2], d[0] * sx[1] - d[1] * sx[0])
        syl = math.sqrt(sy[0] ** 2 + sy[1] ** 2 + sy[2] ** 2) or 1
        sy = (sy[0] / syl * r, sy[1] / syl * r, sy[2] / syl * r)
        i0 = len(verts)
        for (ax, ay) in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            verts.append((p[0] + sx[0] * ax + sy[0] * ay, p[1] + sx[1] * ax + sy[1] * ay, p[2] + sx[2] * ax + sy[2] * ay))
        rings.append(i0)
    for k in range(len(rings) - 1):
        a, b = rings[k], rings[k + 1]
        for e in range(4):
            f = (e + 1) % 4
            faces.append((a + e, a + f, b + f, b + e))
            colors.extend([c4] * 4)


def build_suspension_bridge(br, verts, faces, colors, color, tower_color=None, lm=None):
    tower_color = tower_color or color
    line = br["line"]
    wpts = [(p[0], -p[1], p[2]) for p in line]
    # deck
    for i in range(len(wpts) - 1):
        a, b = wpts[i], wpts[i + 1]
        seg_len = math.dist((a[0], a[1]), (b[0], b[1]))
        steps = max(1, int(seg_len / 60))
        for s in range(steps):
            t0, t1 = s / steps, (s + 1) / steps
            m0 = (a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0, a[2] + (b[2] - a[2]) * t0)
            m1 = (a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1, a[2] + (b[2] - a[2]) * t1)
            cx, cy, cz = (m0[0] + m1[0]) / 2, (m0[1] + m1[1]) / 2, (m0[2] + m1[2]) / 2
            yaw = math.atan2(m1[1] - m0[1], m1[0] - m0[0])
            ln = math.dist((m0[0], m0[1]), (m1[0], m1[1])) / 2 + 0.5
            add_box(verts, faces, colors, cx, cy, cz - br["deckThickness"] / 2,
                    ln, br["width"] / 2, br["deckThickness"] / 2, color, yaw=yaw)
            if lm:
                # roadway only (towers/cables stay ghost by request); blender
                # yaw equals game yaw here, blender y flips to game -z
                cbox(lm, cx, -cy, cz - br["deckThickness"], cz,
                     ln, br["width"] / 2, yaw=yaw)
            # side parapets keep cars on the roadway: low visual curb, with a
            # taller invisible lip on the collider so a bouncing chassis can't
            # vault it. Inside the suspender line (off = width/2 + 1.5).
            po = br["width"] / 2 - 0.55
            ppx, ppy = -math.sin(yaw), math.cos(yaw)
            for sgn in (-1, 1):
                rx = cx + ppx * po * sgn
                ry = cy + ppy * po * sgn
                add_box(verts, faces, colors, rx, ry, cz + 0.62,
                        ln, 0.3, 0.62, tower_color, yaw=yaw)
                if lm:
                    cbox(lm, rx, -ry, cz, cz + 1.7, ln, 0.35, yaw=yaw)
    # towers
    th = br["towerHeight"]
    for (tx, tz) in br["towers"]:
        ty = -tz
        # find deck height near tower
        deck_h = min(line, key=lambda p: (p[0] - tx) ** 2 + (p[1] - tz) ** 2)[2]
        # two legs perpendicular to bridge direction
        i_near = min(range(len(line) - 1), key=lambda i: (line[i][0] - tx) ** 2 + (line[i][1] - tz) ** 2)
        dx = line[i_near + 1][0] - line[i_near][0]
        dz = line[i_near + 1][1] - line[i_near][1]
        dl = math.hypot(dx, dz) or 1
        px, pz = -dz / dl, dx / dl  # perpendicular in game frame
        off = br["width"] / 2 + 1.5
        for sgn in (-1, 1):
            lx = tx + px * off * sgn
            ly = -(tz + pz * off * sgn)
            add_cylinder(verts, faces, colors, lx, ly, -8, th, 3.4, tower_color, seg=8, r_top=2.2)
        # cross braces
        for frac in (0.35, 0.62, 0.86):
            bz = th * frac
            bx = (tx + px * off) ; by = -(tz + pz * off)
            cx2 = (tx - px * off); cy2 = -(tz - pz * off)
            mx, my = (bx + cx2) / 2, (by + cy2) / 2
            brace_len = math.dist((bx, by), (cx2, cy2)) / 2
            yaw = math.atan2(cy2 - by, cx2 - bx)
            add_box(verts, faces, colors, mx, my, bz, brace_len, 1.6, 2.6, tower_color, yaw=yaw)
        void_ = deck_h
    # main cables between tower tops (and to anchors = line endpoints)
    tower_tops = []
    for (tx, tz) in br["towers"]:
        tower_tops.append((tx, -tz, th))
    anchors = [wpts[0], wpts[-1]]
    cable_nodes = [ (anchors[0][0], anchors[0][1], anchors[0][2] + 2) ] + tower_tops + [ (anchors[1][0], anchors[1][1], anchors[1][2] + 2) ]
    # perpendicular offset for two cables
    dx = wpts[-1][0] - wpts[0][0]
    dy = wpts[-1][1] - wpts[0][1]
    dl = math.hypot(dx, dy) or 1
    px, py = -dy / dl, dx / dl
    off = br["width"] / 2 + 1.5
    for sgn in (-1, 1):
        for k in range(len(cable_nodes) - 1):
            a = cable_nodes[k]
            b = cable_nodes[k + 1]
            span = math.dist((a[0], a[1]), (b[0], b[1]))
            sag = max(6.0, span * 0.095) if a[2] > 50 and b[2] > 50 else max(4.0, span * 0.05)
            pts = catenary_points(
                (a[0] + px * off * sgn, a[1] + py * off * sgn, a[2]),
                (b[0] + px * off * sgn, b[1] + py * off * sgn, b[2]),
                sag, max(6, int(span / 40)))
            add_tube(verts, faces, colors, pts, 0.9, color)
            # suspenders
            for (sx, sy, sz) in pts[1:-1]:
                deck_z = bridge_deck_heights(np.array([sx]), np.array([-sy]), DATA["meta"])[0]
                if deck_z > -1e8 and sz > deck_z:
                    add_box(verts, faces, colors, sx, sy, (sz + deck_z) / 2, 0.25, 0.25, (sz - deck_z) / 2, color)


def _bridge_line_samples(wpts, spacing):
    """Sample the deck polyline (blender frame) at ~spacing arclength.
    Returns (x, y, z, yaw, px, py): yaw along span, (px, py) unit perpendicular."""
    out = []
    for i in range(len(wpts) - 1):
        a, b = wpts[i], wpts[i + 1]
        seg_len = math.dist((a[0], a[1]), (b[0], b[1]))
        n = max(1, int(seg_len / spacing))
        yaw = math.atan2(b[1] - a[1], b[0] - a[0])
        px, py = -math.sin(yaw), math.cos(yaw)
        for s in range(n + (1 if i == len(wpts) - 2 else 0)):
            t = s / n
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t,
                        a[2] + (b[2] - a[2]) * t, yaw, px, py))
    return out


def add_span_prism(verts, faces, colors, m0, m1, off, hy, zb, zt, color):
    """Sheared box following the deck line (no stair-stepping on slopes):
    m0/m1 = (x, y, z_line) blender-frame subsegment endpoints, off = signed
    perpendicular offset of the strip centre, hy = half width, zb/zt =
    bottom/top offsets from the line height at each end."""
    yaw = math.atan2(m1[1] - m0[1], m1[0] - m0[0])
    px_, py_ = -math.sin(yaw), math.cos(yaw)
    i0 = len(verts)
    for (mx, my, mz) in (m0, m1):
        cxo, cyo = mx + px_ * off, my + py_ * off
        for dy in (-hy, hy):
            for dz in (zb, zt):
                verts.append((cxo + px_ * dy, cyo + py_ * dy, mz + dz))
    # end0 verts 0..3, end1 verts 4..7; per-end order (-hy,zb),(-hy,zt),(hy,zb),(hy,zt)
    quads = [
        (2, 6, 4, 0),  # bottom
        (1, 5, 7, 3),  # top
        (0, 4, 5, 1),  # -hy side
        (2, 3, 7, 6),  # +hy side
        (0, 1, 3, 2),  # start cap
        (4, 6, 7, 5),  # end cap
    ]
    c4 = (color[0], color[1], color[2], 1.0)
    for q in quads:
        faces.append(tuple(i0 + k for k in q))
        colors.extend([c4] * 4)


def build_golden_gate(br, verts, faces, colors, color, lm=None):
    """High-detail art-deco Golden Gate. Same collider footprint as
    build_suspension_bridge (roadway + parapet lips only; towers/cables ghost).
    Extra detail: stepped tower legs + recessed portal struts, base piers,
    under-deck stiffening truss, curb railing + lamp posts (posts line up with
    the goldenGateLights sprite anchors), denser cables + suspenders."""
    ORANGE = color
    DEEP = tuple(c * 0.55 for c in color)          # shadowed steel / recesses
    BRIGHT = tuple(min(1.0, c * 1.22) for c in color)
    line = br["line"]
    wpts = [(p[0], -p[1], p[2]) for p in line]
    width = br["width"]
    th = br["towerHeight"]
    dth = br["deckThickness"]
    TRUSS_DEPTH = 7.6

    # ------------------------------------------------------ deck + colliders
    # visuals are sheared prisms that follow the line exactly (no stair-steps
    # poking through the sloped asphalt); colliders stay yaw-only boxes, so on
    # grades they substep until each riser is < 0.4 m
    po = width / 2 - 0.55
    for i in range(len(wpts) - 1):
        a, b = wpts[i], wpts[i + 1]
        seg_len = math.dist((a[0], a[1]), (b[0], b[1]))
        steps = max(1, int(seg_len / 60))
        for s in range(steps):
            t0, t1 = s / steps, (s + 1) / steps
            m0 = (a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0, a[2] + (b[2] - a[2]) * t0)
            m1 = (a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1, a[2] + (b[2] - a[2]) * t1)
            yaw = math.atan2(m1[1] - m0[1], m1[0] - m0[0])
            ppx, ppy = -math.sin(yaw), math.cos(yaw)
            add_span_prism(verts, faces, colors, m0, m1, 0, width / 2, -dth, 0, ORANGE)
            for sgn in (-1, 1):
                # curb + open railing (thin handrail above the curb)
                add_span_prism(verts, faces, colors, m0, m1, po * sgn, 0.28, 0.0, 0.84, ORANGE)
                add_span_prism(verts, faces, colors, m0, m1, po * sgn, 0.09, 1.21, 1.35, BRIGHT)
                # under-deck stiffening truss: edge girder + bottom chord
                go = (width / 2 - 0.4) * sgn
                add_span_prism(verts, faces, colors, m0, m1, go, 0.32, -dth - 1.4, -dth, ORANGE)
                add_span_prism(verts, faces, colors, m0, m1, go, 0.32, -TRUSS_DEPTH - 0.5, -TRUSS_DEPTH + 0.5, ORANGE)
            if lm:
                nsub = max(1, int(math.ceil(abs(m1[2] - m0[2]) / 0.4)))
                for k in range(nsub):
                    k0, k1 = k / nsub, (k + 1) / nsub
                    cx = m0[0] + (m1[0] - m0[0]) * (k0 + k1) / 2
                    cy = m0[1] + (m1[1] - m0[1]) * (k0 + k1) / 2
                    cz = m0[2] + (m1[2] - m0[2]) * (k0 + k1) / 2
                    ln = math.dist((m0[0], m0[1]), (m1[0], m1[1])) / (2 * nsub) + 0.5
                    cbox(lm, cx, -cy, cz - dth, cz, ln, width / 2, yaw=yaw)
                    for sgn in (-1, 1):
                        rx, ry = cx + ppx * po * sgn, cy + ppy * po * sgn
                        cbox(lm, rx, -ry, cz, cz + 1.7, ln, 0.35, yaw=yaw)

    # truss verticals + X diagonals + transverse floor beams, fixed 26 m bays
    bays = _bridge_line_samples(wpts, 26)
    for k, (sx, sy, sz, yaw, px, py) in enumerate(bays):
        for sgn in (-1, 1):
            gx, gy = sx + px * (width / 2 - 0.4) * sgn, sy + py * (width / 2 - 0.4) * sgn
            add_box(verts, faces, colors, gx, gy, sz - dth / 2 - TRUSS_DEPTH / 2 + 0.6,
                    0.28, 0.28, TRUSS_DEPTH / 2 - 1.4, DEEP, yaw=yaw)
        if k + 1 < len(bays):
            nx, ny, nz = bays[k + 1][0], bays[k + 1][1], bays[k + 1][2]
            for sgn in (-1, 1):
                ax_, ay_ = sx + px * (width / 2 - 0.4) * sgn, sy + py * (width / 2 - 0.4) * sgn
                bx_, by_ = nx + px * (width / 2 - 0.4) * sgn, ny + py * (width / 2 - 0.4) * sgn
                hi, lo = sz - dth - 1.2, nz - TRUSS_DEPTH + 0.4
                if k % 2 == 0:
                    add_tube(verts, faces, colors, [(ax_, ay_, hi), (bx_, by_, lo)], 0.18, DEEP)
                else:
                    add_tube(verts, faces, colors, [(ax_, ay_, lo), (bx_, by_, hi)], 0.18, DEEP)
        # transverse floor beam
        add_box(verts, faces, colors, sx, sy, sz - TRUSS_DEPTH, 0.3, width / 2 - 0.5, 0.4, DEEP, yaw=yaw)

    # lamp posts on the curb, 23 m pitch — matches goldenGateLights DECK_SPACING
    for (sx, sy, sz, yaw, px, py) in _bridge_line_samples(wpts, 23):
        for sgn in (-1, 1):
            lx_, ly_ = sx + px * (width / 2 - 0.55) * sgn, sy + py * (width / 2 - 0.55) * sgn
            add_box(verts, faces, colors, lx_, ly_, sz + 1.05, 0.09, 0.09, 1.05, ORANGE, yaw=yaw)
            add_box(verts, faces, colors, lx_, ly_, sz + 2.2, 0.17, 0.17, 0.16, BRIGHT, yaw=yaw)

    # railing pickets so the handrail visibly stands on the curb
    for (sx, sy, sz, yaw, px, py) in _bridge_line_samples(wpts, 7.66):
        for sgn in (-1, 1):
            kx_, ky_ = sx + px * po * sgn, sy + py * po * sgn
            add_box(verts, faces, colors, kx_, ky_, sz + 1.02, 0.06, 0.06, 0.34, ORANGE, yaw=yaw)

    # --------------------------------------------------------------- towers
    for (tx, tz) in br["towers"]:
        ty = -tz
        deck_h = min(line, key=lambda p: (p[0] - tx) ** 2 + (p[1] - tz) ** 2)[2]
        i_near = min(range(len(line) - 1), key=lambda i: (line[i][0] - tx) ** 2 + (line[i][1] - tz) ** 2)
        dx = line[i_near + 1][0] - line[i_near][0]
        dz = line[i_near + 1][1] - line[i_near][1]
        dl = math.hypot(dx, dz) or 1
        pxg, pzg = -dz / dl, dx / dl              # perpendicular, game frame
        pxb, pyb = pxg, -pzg                      # blender frame
        yaw_p = math.atan2(pyb, pxb)              # box long-axis across bridge
        off = width / 2 + 1.5

        # pier + fender at the waterline
        pier_top = deck_h - 16
        add_box(verts, faces, colors, tx, ty, (pier_top - 12) / 2, off + 5.0, 8.5,
                (pier_top + 12) / 2, DEEP, yaw=yaw_p)
        add_box(verts, faces, colors, tx, ty, -1.0, off + 7.5, 11.0, 4.0, DEEP, yaw=yaw_p)

        # stepped legs: frustum per storey, setback at each portal strut
        levels = [deck_h + (th - deck_h) * f for f in (0.30, 0.55, 0.78)]
        storeys = [pier_top] + levels + [th + 2.0]
        halfw = [4.0, 3.5, 3.05, 2.65, 2.3]
        for sgn in (-1, 1):
            lx_ = tx + pxb * off * sgn
            ly_ = ty + pyb * off * sgn
            for si in range(len(storeys) - 1):
                add_frustum(verts, faces, colors, lx_, ly_, storeys[si], storeys[si + 1],
                            halfw[si], halfw[si + 1], ORANGE, yaw=yaw_p)
                # art-deco vertical ribs on the outer face of each storey
                mid_h = (halfw[si] + halfw[si + 1]) / 2
                rib_off = mid_h + 0.22
                add_box(verts, faces, colors,
                        lx_ + pxb * rib_off * sgn, ly_ + pyb * rib_off * sgn,
                        (storeys[si] + storeys[si + 1]) / 2, 0.25, 1.1,
                        (storeys[si + 1] - storeys[si]) / 2 - 0.8, DEEP, yaw=yaw_p)
            # saddle housing + cap
            add_box(verts, faces, colors, lx_, ly_, th + 3.0, 2.7, 2.7, 1.1, BRIGHT, yaw=yaw_p)
            add_frustum(verts, faces, colors, lx_, ly_, th + 4.1, th + 5.6, 2.1, 1.2, ORANGE, yaw=yaw_p)

        # portal struts: stepped, with dark recessed panel (art-deco)
        depths = [6.5, 5.5, 4.6, 3.8]
        strut_z = levels + [th - 4.0]
        for i2, lz in enumerate(strut_z):
            d = depths[i2]
            add_box(verts, faces, colors, tx, ty, lz, off, 1.5, d / 2, ORANGE, yaw=yaw_p)
            add_box(verts, faces, colors, tx, ty, lz, off - 2.2, 1.58, d / 2 - 0.8, DEEP, yaw=yaw_p)
            add_box(verts, faces, colors, tx, ty, lz + d / 2 + 0.45, off - 1.0, 1.3, 0.45, ORANGE, yaw=yaw_p)

        # below-deck X bracing between legs
        aL = (tx - pxb * off, ty - pyb * off)
        aR = (tx + pxb * off, ty + pyb * off)
        add_tube(verts, faces, colors, [(aL[0], aL[1], pier_top + 1), (aR[0], aR[1], deck_h - 3)], 0.5, DEEP)
        add_tube(verts, faces, colors, [(aR[0], aR[1], pier_top + 1), (aL[0], aL[1], deck_h - 3)], 0.5, DEEP)

        # aviation beacon mast, centred on the top strut (sprite sits at th+4)
        add_cylinder(verts, faces, colors, tx, ty, th - 2.0, th + 3.6, 0.38, BRIGHT, seg=8, r_top=0.22)

    # ------------------------------------------- main cables and suspenders
    tower_tops = [(txy[0], -txy[1], th) for txy in br["towers"]]
    anchors = [wpts[0], wpts[-1]]
    cable_nodes = [(anchors[0][0], anchors[0][1], anchors[0][2] + 2)] + tower_tops + \
                  [(anchors[1][0], anchors[1][1], anchors[1][2] + 2)]
    dx = wpts[-1][0] - wpts[0][0]
    dy = wpts[-1][1] - wpts[0][1]
    dl = math.hypot(dx, dy) or 1
    px, py = -dy / dl, dx / dl
    off = width / 2 + 1.5
    for sgn in (-1, 1):
        for k in range(len(cable_nodes) - 1):
            a = cable_nodes[k]
            b = cable_nodes[k + 1]
            span = math.dist((a[0], a[1]), (b[0], b[1]))
            sag = max(6.0, span * 0.095) if a[2] > 50 and b[2] > 50 else max(4.0, span * 0.05)
            pts = catenary_points(
                (a[0] + px * off * sgn, a[1] + py * off * sgn, a[2]),
                (b[0] + px * off * sgn, b[1] + py * off * sgn, b[2]),
                sag, max(10, int(span / 22)))
            add_tube(verts, faces, colors, pts, 0.95, ORANGE)
            for (sx, sy, sz) in pts[1:-1]:
                deck_z = bridge_deck_heights(np.array([sx]), np.array([-sy]), DATA["meta"])[0]
                if deck_z > -1e8 and sz > deck_z + 2.5:
                    # cable band + slim suspender; the rod runs past the deck
                    # into the truss depth so it never ends hanging in air
                    add_box(verts, faces, colors, sx, sy, sz, 1.15, 1.15, 0.45, DEEP)
                    bot = deck_z - 3.0
                    add_box(verts, faces, colors, sx, sy, (sz + bot) / 2, 0.14, 0.14, (sz - bot) / 2, ORANGE)
                    # bracket arm tying the rod back to the deck edge girder
                    dcx, dcy = sx - px * off * sgn, sy - py * off * sgn
                    bo = (width / 2 - 0.7 + off + 0.2) / 2
                    add_box(verts, faces, colors, dcx + px * bo * sgn, dcy + py * bo * sgn,
                            deck_z - 0.55, (off + 0.2 - (width / 2 - 0.7)) / 2 + 0.15, 0.22, 0.4,
                            ORANGE, yaw=math.atan2(py, px))


def build_landmarks():
    """One named object per landmark so the runtime can address them
    individually (e.g. the Salesforce crown gets its own material)."""
    coll = lm_collection()
    meta = DATA["meta"]
    made = []

    def emit(name, verts, faces, colors):
        made.append(make_mesh_object(name, verts, faces, colors, coll))

    def ground(x, z):
        return float(sample_height(np.array([x]), np.array([z]))[0])

    LM_COLLIDERS.clear()

    # Golden Gate + Bay Bridge
    verts, faces, colors = [], [], []
    build_golden_gate(meta["bridges"][0], verts, faces, colors, INTL_ORANGE, lm="goldengate")
    emit("lm_bridge_goldengate", verts, faces, colors)
    verts, faces, colors = [], [], []
    build_suspension_bridge(meta["bridges"][1], verts, faces, colors, STEEL_GRAY, lm="baybridge")
    emit("lm_bridge_bay", verts, faces, colors)

    # Transamerica Pyramid (3680, 32): smooth 4-side frustum + spire + wings
    verts, faces, colors = [], [], []
    tx, tz = 3680, 32
    g = ground(tx, tz)
    ty = -tz
    add_box(verts, faces, colors, tx, ty, g + 30, 27, 27, 30, WHITE_QUARTZ)  # podium-ish base mass
    add_frustum(verts, faces, colors, tx, ty, g + 60, g + 256, 26, 2.0, WHITE_QUARTZ)
    add_cylinder(verts, faces, colors, tx, ty, g + 256, g + 280, 2.2, WHITE_QUARTZ, seg=8, r_top=0.4)
    # wings
    add_box(verts, faces, colors, tx + 24, ty, g + 90, 4, 10, 90, WHITE_QUARTZ)
    add_box(verts, faces, colors, tx - 24, ty, g + 90, 4, 10, 90, WHITE_QUARTZ)
    # colliders: base slab + 3-step frustum + wings
    cbox("transamerica", tx, tz, g, g + 60, 27, 27)
    cbox("transamerica", tx, tz, g + 60, g + 130, 21, 21)
    cbox("transamerica", tx, tz, g + 130, g + 195, 13, 13)
    cbox("transamerica", tx, tz, g + 195, g + 252, 6, 6)
    cbox("transamerica", tx + 24, tz, g, g + 180, 4, 10)
    cbox("transamerica", tx - 24, tz, g, g + 180, 4, 10)
    emit("lm_transamerica", verts, faces, colors)

    # Salesforce Tower (4117, 33): watertight tapered shaft; the crown (the LED
    # "Day for Night" band) is a separate shell so the game can light it up.
    # crown starts below the shaft top and is slightly wider, so the two caps
    # never share a plane (no z-fighting at the seam)
    verts, faces, colors = [], [], []
    sx, sz = 4117, 33
    g = ground(sx, sz)
    sy = -sz
    add_cylinder(verts, faces, colors, sx, sy, g, g + 250, 27, SALESFORCE_GLASS, seg=24, r_top=22)
    ccyl("salesforce", sx, sz, g, g + 250, 24.5, k=8, t=2.0)
    ccyl("salesforce", sx, sz, g + 250, g + 303, 14, k=8, t=1.5)  # crown shell
    emit("lm_salesforce", verts, faces, colors)

    verts, faces, colors = [], [], []
    crown_glass = srgb_to_linear((120, 138, 152))
    add_cylinder(verts, faces, colors, sx, sy, g + 249.4, g + 296, 22.15, crown_glass, seg=24, r_top=13.5)
    add_cylinder(verts, faces, colors, sx, sy, g + 296, g + 305, 13.5, crown_glass, seg=24, r_top=8.5)
    emit("lm_salesforce_crown", verts, faces, colors)

    # Coit Tower (3366, -1360). Art-deco memorial: two-tier pedestal (sunk deep
    # so the decimated hill mesh can't open a gap under it), fluted tapered
    # shaft, arched observation gallery, stepped-back arched lantern.
    verts, faces, colors = [], [], []
    cx, cz = 3366, -1360
    g = ground(cx, cz)
    cy = -cz
    # pedestal — starts 14 m below heightmap ground
    add_cylinder(verts, faces, colors, cx, cy, g - 14, g + 4, 16.0, COIT_BASE, seg=20)
    add_cylinder(verts, faces, colors, cx, cy, g + 4, g + 5.1, 16.9, COIT_TRIM, seg=20)
    add_cylinder(verts, faces, colors, cx, cy, g + 5.1, g + 9.2, 12.8, COIT_BASE, seg=20)
    add_cylinder(verts, faces, colors, cx, cy, g + 9.2, g + 10.2, 13.6, COIT_TRIM, seg=20)
    # west entrance portico
    add_box(verts, faces, colors, cx - 16.2, cy, g + 1.9, 2.6, 3.4, 3.9, COIT_BASE)
    add_box(verts, faces, colors, cx - 16.2, cy, g + 6.1, 3.1, 3.9, 0.55, COIT_TRIM)
    add_box(verts, faces, colors, cx - 18.5, cy, g + 2.4, 0.35, 1.5, 2.6, COIT_DARK)
    # fluted shaft + cornice
    add_fluted_cylinder(verts, faces, colors, cx, cy, g + 10.2, g + 50, 8.3, 7.4, 18, 0.55, COIT_COLOR)
    add_cylinder(verts, faces, colors, cx, cy, g + 50, g + 51.2, 9.0, COIT_TRIM, seg=24)
    # observation gallery: dark core behind an arched arcade, crown cornice
    add_cylinder(verts, faces, colors, cx, cy, g + 51.2, g + 52.1, 9.6, COIT_TRIM, seg=24)
    add_cylinder(verts, faces, colors, cx, cy, g + 52.1, g + 58.8, 7.6, COIT_DARK, seg=24)
    add_arcade(verts, faces, colors, cx, cy, g + 52.1, g + 58.8, 9.2, 8,
               g + 53.2, g + 56.4, 1.7, 0.60, COIT_COLOR)
    add_cylinder(verts, faces, colors, cx, cy, g + 58.8, g + 60.2, 10.1, COIT_TRIM, seg=24, r_top=9.5)
    # lantern: smaller arched drum + cap
    add_cylinder(verts, faces, colors, cx, cy, g + 60.2, g + 64.6, 4.5, COIT_DARK, seg=20)
    add_arcade(verts, faces, colors, cx, cy, g + 60.2, g + 64.6, 5.5, 8,
               g + 60.9, g + 62.9, 0.9, 0.55, COIT_COLOR)
    add_cylinder(verts, faces, colors, cx, cy, g + 64.6, g + 65.8, 6.3, COIT_TRIM, seg=20, r_top=5.7)
    add_cylinder(verts, faces, colors, cx, cy, g + 65.8, g + 66.8, 2.2, COIT_COLOR, seg=16, r_top=1.5)
    # colliders: pedestal ring (sunk with the mesh for the hillside), shaft
    # ring to the gallery cornice, portico block
    ccyl("coit", cx, cz, g - 14, g + 10.2, 16.4, k=10, t=1.6)
    ccyl("coit", cx, cz, g + 10.2, g + 60.2, 8.0, k=8, t=1.4)
    cbox("coit", cx - 16.2, cz, g - 2, g + 6.7, 3.0, 3.9)
    emit("lm_coit", verts, faces, colors)

    # Ferry Building (4425, -608): arcaded block + cornice + clerestory nave,
    # clock tower with faces and a stepped belvedere cap
    verts, faces, colors = [], [], []
    fx, fz = 4428, -608
    g = max(ground(fx, fz), 2.8)
    fy = -fz
    yaw = math.radians(35)  # Embarcadero angle
    ca, sa = math.cos(yaw), math.sin(yaw)

    def fpos(lx, ly):
        return fx + lx * ca - ly * sa, fy + lx * sa + ly * ca

    add_box(verts, faces, colors, fx, fy, g + 9, 110, 18, 9, FERRY_COLOR, yaw=yaw)
    cbox("ferry", fx, fz, g, g + 18, 110, 18, yaw=yaw)
    # arch band: dark inset panels marching down both long faces
    for side in (-1, 1):
        for k in range(-12, 13):
            if abs(k) < 2:
                continue  # keep the tower bay clean
            wx, wy = fpos(k * 8.6, side * 18.05)
            add_box(verts, faces, colors, wx, wy, g + 5.2, 1.7, 0.25, 2.8, FERRY_DARK, yaw=yaw)
    # cornice + clerestory nave running the roof line
    add_box(verts, faces, colors, fx, fy, g + 18.4, 111.5, 19.2, 0.7, FERRY_TRIM, yaw=yaw)
    add_box(verts, faces, colors, fx, fy, g + 20.6, 96, 5.5, 1.6, FERRY_COLOR, yaw=yaw)
    add_box(verts, faces, colors, fx, fy, g + 22.5, 97.5, 6.4, 0.5, FERRY_TRIM, yaw=yaw)

    # clock tower: shaft, cornice, clock stage with 4 faces, belvedere, spire
    add_box(verts, faces, colors, fx, fy, g + 30, 7.5, 7.5, 14, FERRY_COLOR, yaw=yaw)
    add_box(verts, faces, colors, fx, fy, g + 44.0, 8.3, 8.3, 0.6, FERRY_TRIM, yaw=yaw)
    add_box(verts, faces, colors, fx, fy, g + 47.9, 6.2, 6.2, 3.3, FERRY_COLOR, yaw=yaw)
    for (lx, ly) in ((6.25, 0), (-6.25, 0), (0, 6.25), (0, -6.25)):
        wx, wy = fpos(lx, ly)
        add_box(verts, faces, colors, wx, wy, g + 48.2, 0.18 if ly == 0 else 3.0,
                0.18 if lx == 0 else 3.0, 3.0, FERRY_DARK, yaw=yaw)
        wx2, wy2 = fpos(lx * 1.03, ly * 1.03)
        add_box(verts, faces, colors, wx2, wy2, g + 48.2, 0.12 if ly == 0 else 2.3,
                0.12 if lx == 0 else 2.3, 2.3, FERRY_TRIM, yaw=yaw)
    add_box(verts, faces, colors, fx, fy, g + 51.7, 6.9, 6.9, 0.5, FERRY_TRIM, yaw=yaw)
    add_frustum(verts, faces, colors, fx, fy, g + 52.2, g + 54.4, 5.4, 4.2, FERRY_COLOR, yaw=yaw)
    add_frustum(verts, faces, colors, fx, fy, g + 54.4, g + 59.5, 4.2, 0.5, FERRY_TRIM, yaw=yaw)
    cbox("ferry", fx, fz, g + 18, g + 52.2, 7.5, 7.5, yaw=yaw)
    emit("lm_ferry", verts, faces, colors)

    # Sutro Tower (-782, 3846): 3 legs + waist + antennas
    verts, faces, colors = [], [], []
    ux, uz = -782, 3846
    g = ground(ux, uz)
    uy = -uz
    for i in range(3):
        a = 2 * math.pi * i / 3
        lx0, ly0 = ux + math.cos(a) * 40, uy + math.sin(a) * 40
        lx1, ly1 = ux + math.cos(a) * 12, uy + math.sin(a) * 12
        pts = [(lx0 + (lx1 - lx0) * t, ly0 + (ly1 - ly0) * t, g + 260 * t) for t in np.linspace(0, 1, 6)]
        add_tube(verts, faces, colors, pts, 2.6, SUTRO_RED)
    add_box(verts, faces, colors, ux, uy, g + 150, 34, 34, 5, SUTRO_WHITE)
    add_box(verts, faces, colors, ux, uy, g + 260, 30, 30, 5, SUTRO_WHITE)
    for i in range(3):
        a = 2 * math.pi * i / 3 + math.pi / 3
        add_cylinder(verts, faces, colors, ux + math.cos(a) * 18, uy + math.sin(a) * 18, g + 260, g + 298, 1.2, SUTRO_WHITE, seg=6)
    # colliders: two stacked boxes per slanted leg (mid-radius of each half),
    # plus the waist and top platforms (bird/fly landings)
    for i in range(3):
        a = 2 * math.pi * i / 3
        for (t0, t1) in ((0.0, 0.5), (0.5, 1.0)):
            rm = 40 + (12 - 40) * (t0 + t1) / 2
            cbox("sutro", ux + math.cos(a) * rm, uz - math.sin(a) * rm,
                 g + 260 * t0 - 4, g + 260 * t1, 3.0, 3.0)
    cbox("sutro", ux, uz, g + 145, g + 155, 34, 34)
    cbox("sutro", ux, uz, g + 255, g + 265, 30, 30)
    emit("lm_sutro", verts, faces, colors)

    # Palace of Fine Arts (-388, -1426): open octagonal rotunda — 8 arched
    # bays with paired columns on the piers — under a ribbed terracotta dome,
    # wrapped by a detached colonnade crescent open to the east (lagoon side).
    # Whole footprint stays under r~35: OSM annex fragments start at 40 m, so
    # no LANDMARK_CLEAR zone is needed. The rotunda interior is walkable —
    # colliders are per-pier/per-column, never a solid drum.
    verts, faces, colors = [], [], []
    px, pz = -388, -1426
    g = ground(px, pz)
    py = -pz

    # stepped plinth; collider is one inscribed slab so the rim never ghosts
    add_cylinder(verts, faces, colors, px, py, g - 1.5, g + 0.55, 18.2, PFA_TRIM, seg=24)
    add_cylinder(verts, faces, colors, px, py, g + 0.55, g + 1.15, 16.9, PFA_TRIM, seg=24)
    cbox("palace", px, pz, g - 1.5, g + 1.15, 13, 13)

    # rotunda: 8 piers + open arches (sill nearly at floor = walk-through)
    zf, zt = g + 1.15, g + 24.0
    add_arcade(verts, faces, colors, px, py, zf, zt, 14.5, 8,
               zf + 0.25, g + 15.0, 4.6, 0.55, PFA_COLOR, arch_seg=6)
    step8 = 2 * math.pi / 8
    for k in range(8):
        a = k * step8 + step8 / 2  # pier centre angle
        for da in (-0.16, 0.16):   # paired engaged columns on the pier face
            colx = px + math.cos(a + da) * 15.9
            coly = py + math.sin(a + da) * 15.9
            add_cylinder(verts, faces, colors, colx, coly, zf, g + 19.2, 1.05, PFA_COLOR, seg=8)
            add_cylinder(verts, faces, colors, colx, coly, g + 19.2, g + 20.2, 1.5, PFA_TRIM, seg=8, r_top=1.15)
        cbox("palace", px + math.cos(a) * 14.5, pz - math.sin(a) * 14.5,
             zf, zt, 2.4, 2.0, yaw=a)

    # entablature, drum, ribbed dome (fluting reads as coffers), finial
    add_cylinder(verts, faces, colors, px, py, zt, g + 27.0, 16.6, PFA_COLOR, seg=24)
    add_cylinder(verts, faces, colors, px, py, g + 27.0, g + 28.0, 17.3, PFA_TRIM, seg=24)
    add_cylinder(verts, faces, colors, px, py, g + 28.0, g + 31.5, 13.6, PFA_COLOR, seg=20)
    add_fluted_cylinder(verts, faces, colors, px, py, g + 31.5, g + 38.5, 14.2, 11.2, 16, 0.5, PFA_DOME)
    add_fluted_cylinder(verts, faces, colors, px, py, g + 38.5, g + 44.5, 11.2, 6.2, 16, 0.4, PFA_DOME)
    add_cylinder(verts, faces, colors, px, py, g + 44.5, g + 47.6, 6.2, PFA_DOME, seg=16, r_top=1.6)
    add_cylinder(verts, faces, colors, px, py, g + 47.6, g + 49.2, 1.0, PFA_TRIM, seg=8, r_top=0.4)

    # colonnade crescent around the west side, open to the lagoon
    arc0, arc1 = math.radians(55), math.radians(305)
    ncol, rc = 20, 33.0
    for k in range(ncol):
        a = arc0 + (arc1 - arc0) * k / (ncol - 1)
        colx, coly = px + math.cos(a) * rc, py + math.sin(a) * rc
        add_cylinder(verts, faces, colors, colx, coly, g, g + 13.0, 1.25, PFA_COLOR, seg=8)
        add_cylinder(verts, faces, colors, colx, coly, g + 13.0, g + 14.0, 1.7, PFA_TRIM, seg=8, r_top=1.3)
        cbox("palace", colx, -coly, g, g + 14.0, 1.1, 1.1)
    # segmented entablature; planter urns over alternate bays
    for k in range(ncol - 1):
        a0 = arc0 + (arc1 - arc0) * k / (ncol - 1)
        a1 = arc0 + (arc1 - arc0) * (k + 1) / (ncol - 1)
        x0, y0 = px + math.cos(a0) * rc, py + math.sin(a0) * rc
        x1, y1 = px + math.cos(a1) * rc, py + math.sin(a1) * rc
        mx, my = (x0 + x1) / 2, (y0 + y1) / 2
        half = math.dist((x0, y0), (x1, y1)) / 2 + 0.9
        byaw = math.atan2(y1 - y0, x1 - x0)
        add_box(verts, faces, colors, mx, my, g + 15.1, half, 1.9, 1.1, PFA_COLOR, yaw=byaw)
        if k % 2 == 0:
            add_frustum(verts, faces, colors, mx, my, g + 16.2, g + 18.4, 1.5, 2.3, PFA_COLOR, yaw=byaw)
    emit("lm_palace_fine_arts", verts, faces, colors)

    # Alcatraz (1848, -4058): cellhouse with clerestory + window bands,
    # lighthouse with lantern gallery, rusted water tower, chimney
    verts, faces, colors = [], [], []
    ax, az = 1848, -4058
    g = max(ground(ax, az), 20)
    ay = -az
    add_box(verts, faces, colors, ax, ay, g + 8, 65, 22, 8, ALC_WALL)
    cbox("alcatraz", ax, az, g, g + 16, 65, 22)
    add_box(verts, faces, colors, ax, ay, g + 17.1, 46, 9, 1.9, ALC_WALL)
    add_box(verts, faces, colors, ax, ay, g + 19.3, 48, 10.5, 0.5, ALC_ROOF)
    for side in (-1, 1):
        for k in range(-6, 7):
            add_box(verts, faces, colors, ax + k * 4.8, ay + side * 22.1, g + 10,
                    1.4, 0.2, 2.4, ALC_DARK)
    # lighthouse: tapered shaft, gallery ring, dark lantern
    add_cylinder(verts, faces, colors, ax - 40, ay - 10, g, g + 34, 2.4, SUTRO_WHITE, seg=10, r_top=2.0)
    add_cylinder(verts, faces, colors, ax - 40, ay - 10, g + 34, g + 35.2, 3.3, ALC_DARK, seg=10)
    add_cylinder(verts, faces, colors, ax - 40, ay - 10, g + 35.2, g + 38.2, 1.6, srgb_to_linear((44, 48, 54)), seg=8, r_top=1.1)
    cbox("alcatraz", ax - 40, az + 10, g, g + 38, 2.0, 2.0)
    # water tower on legs
    wx, wy = ax + 28, ay + 18
    for (dx2, dy2) in ((-2.2, -2.2), (2.2, -2.2), (2.2, 2.2), (-2.2, 2.2)):
        add_box(verts, faces, colors, wx + dx2, wy + dy2, g + 7, 0.35, 0.35, 7, ALC_RUST)
    add_cylinder(verts, faces, colors, wx, wy, g + 14, g + 21, 3.2, ALC_RUST, seg=10)
    add_cylinder(verts, faces, colors, wx, wy, g + 21, g + 22.5, 3.2, ALC_ROOF, seg=10, r_top=0.6)
    cbox("alcatraz", wx, az - 18, g, g + 22.5, 3.0, 3.0)
    # cellhouse chimney
    add_box(verts, faces, colors, ax - 20, ay + 14, g + 12, 1.3, 1.3, 12, ALC_RUST)
    cbox("alcatraz", ax - 20, az - 14, g, g + 24, 1.3, 1.3)
    emit("lm_alcatraz", verts, faces, colors)

    # Dragon Gate (3382, -63): Grant Ave gateway at the Bush St intersection
    # (matches the real gate, and the corner is the only spot with lateral
    # clearance for the flank piers). Stone piers, jade tile triple roof, red
    # frieze and ridge crests. Grant bears ~9° west of north, so the crossbar
    # spans at yaw 9°; the main piers sit at ±5.2 m, clear of the roadway.
    verts, faces, colors = [], [], []
    dx_, dz_ = 3382, -63
    g = ground(dx_, dz_)
    dy = -dz_
    gyaw = math.radians(9)
    gca, gsa = math.cos(gyaw), math.sin(gyaw)

    def gpos(lx, ly=0.0):
        return dx_ + lx * gca - ly * gsa, dy + lx * gsa + ly * gca

    for (lx, ph, hw) in ((-5.2, 5.8, 0.95), (5.2, 5.8, 0.95), (-8.8, 3.4, 0.75), (8.8, 3.4, 0.75)):
        wx, wy = gpos(lx)
        add_box(verts, faces, colors, wx, wy, g + ph / 2, hw, hw, ph / 2, GATE_STONE, yaw=gyaw)
        cbox("dragongate", wx, -wy, g, g + ph, hw, hw, yaw=gyaw)
    # main beam, red frieze, tiered jade roof, ridge crest
    wx, wy = gpos(0)
    add_box(verts, faces, colors, wx, wy, g + 5.35, 5.6, 0.85, 0.45, GATE_RED, yaw=gyaw)
    add_box(verts, faces, colors, wx, wy, g + 6.25, 6.4, 1.0, 0.55, GATE_GREEN, yaw=gyaw)
    for (half, hy2, z) in ((7.0, 1.9, 7.15), (5.6, 1.55, 7.8), (4.0, 1.2, 8.45), (2.4, 0.9, 9.0)):
        add_box(verts, faces, colors, wx, wy, g + z, half, hy2, 0.32, GATE_GREEN, yaw=gyaw)
    add_box(verts, faces, colors, wx, wy, g + 9.5, 1.6, 0.7, 0.28, GATE_RED, yaw=gyaw)
    # side roofs over the flanking pedestrian portals
    for lx in (-7.0, 7.0):
        wx, wy = gpos(lx)
        add_box(verts, faces, colors, wx, wy, g + 3.95, 2.6, 1.5, 0.3, GATE_GREEN, yaw=gyaw)
        add_box(verts, faces, colors, wx, wy, g + 4.5, 1.9, 1.15, 0.28, GATE_GREEN, yaw=gyaw)
        add_box(verts, faces, colors, wx, wy, g + 4.95, 1.0, 0.6, 0.22, GATE_RED, yaw=gyaw)
    emit("lm_dragon_gate", verts, faces, colors)

    write_lm_colliders()
    log(f"landmarks: {len(made)} objects")
    return made


# --------------------------------------------------------------- orchestration

def clear_city():
    for name in list(bpy.data.collections.keys()):
        if name.startswith("tile_") or name in ("terrain", "water", "landmarks"):
            coll = bpy.data.collections[name]
            for obj in list(coll.objects):
                bpy.data.objects.remove(obj, do_unlink=True)
            bpy.data.collections.remove(coll)
    for mesh in list(bpy.data.meshes):
        if mesh.users == 0:
            bpy.data.meshes.remove(mesh)


def downtown_keys():
    """Tiles around downtown/FiDi for preview."""
    meta = DATA["meta"]
    keys = []
    for key in DATA["city"]["tiles"].keys():
        ix, iz = (int(v) for v in key.split("_"))
        x = meta["grid"]["minX"] + ix * meta["tile"] + meta["tile"] / 2
        z = meta["grid"]["minZ"] + iz * meta["tile"] + meta["tile"] / 2
        if 2400 < x < 5600 and -1700 < z < 900:
            keys.append(key)
    return keys


def build_preview():
    t0 = time.time()
    for key in downtown_keys():
        build_tile(key)
    build_terrain()
    build_water()
    build_landmarks()
    log(f"preview built in {time.time()-t0:.1f}s")


def build_all_tiles():
    t0 = time.time()
    count = 0
    for key in DATA["city"]["tiles"].keys():
        build_tile(key)
        count += 1
        if count % 40 == 0:
            log(f"tiles {count}/{len(DATA['city']['tiles'])}")
    log(f"all tiles built in {time.time()-t0:.1f}s")


def export_glb(objects, path):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(
        filepath=path,
        use_selection=True,
        export_format="GLB",
        export_apply=True,
        export_yup=True,
        export_attributes=True,
        export_materials="EXPORT",
        export_animations=False,
        export_skins=False,
        export_cameras=False,
        export_lights=False,
    )


def export_terrain():
    """Export only terrain chunks after a terrain-only rebuild."""
    os.makedirs(TILES_OUT, exist_ok=True)
    tcoll = bpy.data.collections.get("terrain")
    if not tcoll:
        return 0
    count = 0
    for obj in tcoll.objects:
        export_glb([obj], os.path.join(TILES_OUT, f"{obj.name}.glb"))
        count += 1
    log(f"terrain export: {count} chunks")
    return count


def export_all():
    os.makedirs(TILES_OUT, exist_ok=True)
    t0 = time.time()
    # tiles
    for key in DATA["city"]["tiles"].keys():
        coll = bpy.data.collections.get(f"tile_{key}")
        if not coll or not coll.objects:
            continue
        export_glb(list(coll.objects), os.path.join(TILES_OUT, f"tile_{key}.glb"))
    # terrain chunks individually
    export_terrain()
    wcoll = bpy.data.collections.get("water")
    if wcoll and wcoll.objects:
        export_glb(list(wcoll.objects), os.path.join(TILES_OUT, "water.glb"))
    lcoll = bpy.data.collections.get("landmarks")
    if lcoll and lcoll.objects:
        export_glb(list(lcoll.objects), os.path.join(TILES_OUT, "landmarks.glb"))
    log(f"export done in {time.time()-t0:.1f}s")
