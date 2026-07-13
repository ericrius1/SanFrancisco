"""One-shot authored landmark upgrade for the editable San Francisco master scene.

Run inside the *open* ``sanfrancisco.blend``.  The script deliberately refuses
to touch Blender backup files, replaces the generated Palace/Sutro boxouts in
the current scene, removes the Palace OSM faces from tile 8_9 by their baked
``_BID`` values, links both authored landmarks into their geographic streaming
tiles, saves the current scene, and optionally exports the three affected GLBs.

The current .blend is the source of truth after this pass.  Re-running the old
``blender_city.clear_city()/build_landmarks()`` generator would intentionally
restore the generated version.
"""

from __future__ import annotations

import importlib
import math
import os
import sys
from typing import Iterable

import bpy
from mathutils import Vector


TOOLS = os.path.dirname(__file__)
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)
import blender_city as bc
importlib.reload(bc)


PALACE_OSM_BIDS = {570, 571, 572, 573, 574}
PALACE_TILE = "tile_8_9"
SUTRO_TILE = "tile_7_15"

PFA_STONE = bc.srgb_to_linear((199, 178, 153))
PFA_TRIM = bc.srgb_to_linear((224, 207, 178))
PFA_ROSE = bc.srgb_to_linear((151, 94, 84))
PFA_RELIEF = bc.srgb_to_linear((166, 143, 113))
PFA_DOME = bc.srgb_to_linear((160, 94, 62))
PFA_DOME_HI = bc.srgb_to_linear((188, 119, 79))
PFA_SHADOW = bc.srgb_to_linear((91, 74, 60))
SUTRO_RED = bc.srgb_to_linear((196, 58, 48))
SUTRO_WHITE = bc.srgb_to_linear((235, 232, 226))
SUTRO_STEEL = bc.srgb_to_linear((49, 53, 58))


def _c4(color):
    return (color[0], color[1], color[2], 1.0)


def _face(faces, colors, indices, color):
    faces.append(tuple(indices))
    colors.extend([_c4(color)] * len(indices))


def _collection(name: str):
    coll = bpy.data.collections.get(name)
    if coll is None:
        raise RuntimeError(f"Required collection {name!r} is missing")
    return coll


def _delete_object(obj):
    data = obj.data if obj.type == "MESH" else None
    bpy.data.objects.remove(obj, do_unlink=True)
    if data is not None and data.users == 0:
        bpy.data.meshes.remove(data)


def _delete_named(prefixes: Iterable[str]):
    prefixes = tuple(prefixes)
    for obj in list(bpy.data.objects):
        if any(obj.name == p or obj.name.startswith(p) for p in prefixes):
            _delete_object(obj)


def _make(name, verts, faces, colors, collection, smooth=False):
    obj = bc.make_mesh_object(name, verts, faces, colors, collection)
    obj["authored_landmark"] = True
    obj["authoring_source"] = "tools/blender_landmark_upgrade.py"
    if smooth:
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
    return obj


def _remove_bids_from_merged_building(obj_name: str, doomed: set[int]):
    """Rebuild one merged building mesh without selected point-domain _BIDs."""
    obj = bpy.data.objects.get(obj_name)
    if obj is None or obj.type != "MESH":
        raise RuntimeError(f"Missing merged building mesh {obj_name!r}")
    old = obj.data
    attr = old.attributes.get("_BID") or old.attributes.get("_bid")
    if attr is None or attr.domain != "POINT":
        raise RuntimeError(f"{obj_name} has no point-domain _BID attribute")
    bid_values = [round(item.value) for item in attr.data]
    kept_polys = [p for p in old.polygons if bid_values[p.vertices[0]] not in doomed]
    removed = len(old.polygons) - len(kept_polys)
    if removed == 0:
        return 0

    used = sorted({vi for p in kept_polys for vi in p.vertices})
    remap = {old_i: new_i for new_i, old_i in enumerate(used)}
    verts = [tuple(old.vertices[i].co) for i in used]
    faces = [[remap[i] for i in p.vertices] for p in kept_polys]
    old_col = old.color_attributes.get("Col")

    new = bpy.data.meshes.new(old.name + "_authored")
    new.from_pydata(verts, [], faces)
    new.update()
    new_bid = new.attributes.new("_BID", "FLOAT", "POINT")
    for ni, oi in enumerate(used):
        new_bid.data[ni].value = float(bid_values[oi])
    if old_col is not None:
        new_col = new.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
        dst = 0
        for poly in kept_polys:
            for li in poly.loop_indices:
                new_col.data[dst].color = old_col.data[li].color
                dst += 1
    for mat in old.materials:
        new.materials.append(mat)
    obj.data = new
    if old.users == 0:
        bpy.data.meshes.remove(old)
    return removed


def _add_arch_band(verts, faces, colors, cx, cy, angle, spring, inner_r, outer_r, depth, color, steps=14):
    """Extruded semicircular voussoir band in a radial rotunda bay."""
    rx, ry = math.cos(angle), math.sin(angle)
    tx, ty = -ry, rx
    rings = []
    for d in (-depth, depth):
        for radius in (inner_r, outer_r):
            ring = []
            for i in range(steps + 1):
                theta = math.pi - math.pi * i / steps
                u = math.cos(theta) * radius
                z = spring + math.sin(theta) * radius
                ring.append(len(verts))
                verts.append((cx + tx * u + rx * d, cy + ty * u + ry * d, z))
            rings.append(ring)
    for side in (0, 1):
        inner = rings[side * 2]
        outer = rings[side * 2 + 1]
        for i in range(steps):
            q = (inner[i], inner[i + 1], outer[i + 1], outer[i])
            _face(faces, colors, q if side else q[::-1], color)
    for ring_id in (0, 1):
        a, b = rings[ring_id], rings[ring_id + 2]
        for i in range(steps):
            _face(faces, colors, (a[i], b[i], b[i + 1], a[i + 1]), color)
    for i in (0, steps):
        _face(faces, colors, (rings[0][i], rings[1][i], rings[3][i], rings[2][i]), color)


def _add_dome(verts, faces, colors, cx, cy, z0, radius, height, seg=64, rings=12):
    levels = []
    for j in range(rings + 1):
        t = j / rings
        rr = radius * (math.cos(t * math.pi / 2) ** 0.78)
        z = z0 + height * (math.sin(t * math.pi / 2) ** 0.92)
        ring = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            ring.append(len(verts))
            verts.append((cx + rr * math.cos(a), cy + rr * math.sin(a), z))
        levels.append(ring)
    for j in range(rings):
        color = PFA_DOME_HI if j % 3 == 1 else PFA_DOME
        for i in range(seg):
            ni = (i + 1) % seg
            _face(faces, colors, (levels[j][i], levels[j][ni], levels[j + 1][ni], levels[j + 1][i]), color)
    # Meridional ribs: a slim square tube per level reads clearly at lagoon distance.
    for rib in range(0, seg, 4):
        pts = [verts[level[rib]] for level in levels]
        bc.add_tube(verts, faces, colors, pts, 0.18, PFA_TRIM)


def _column(verts, faces, colors, x, y, z0, shaft_top, scale=1.0, rose=True):
    stone = PFA_ROSE if rose else PFA_STONE
    bc.add_box(verts, faces, colors, x, y, z0 + 0.35, 1.55 * scale, 1.55 * scale, 0.35, PFA_TRIM)
    bc.add_cylinder(verts, faces, colors, x, y, z0 + 0.7, z0 + 1.25, 1.42 * scale, PFA_STONE, seg=16, r_top=1.24 * scale)
    bc.add_fluted_cylinder(verts, faces, colors, x, y, z0 + 1.25, shaft_top, 1.18 * scale, 0.98 * scale, 12, 0.09 * scale, stone)
    bc.add_cylinder(verts, faces, colors, x, y, shaft_top, shaft_top + 0.48, 1.12 * scale, PFA_TRIM, seg=16, r_top=1.5 * scale)
    bc.add_frustum(verts, faces, colors, x, y, shaft_top + 0.48, shaft_top + 1.18, 1.48 * scale, 1.9 * scale, PFA_TRIM)
    bc.add_box(verts, faces, colors, x, y, shaft_top + 1.37, 1.95 * scale, 1.95 * scale, 0.19, PFA_STONE)
    # Four blocky acanthus curls give the capital a Corinthian silhouette.
    for a in (0, math.pi / 2, math.pi, 3 * math.pi / 2):
        bc.add_frustum(
            verts, faces, colors,
            x + math.cos(a) * 1.45 * scale,
            y + math.sin(a) * 1.45 * scale,
            shaft_top + 0.42, shaft_top + 1.12,
            0.34 * scale, 0.62 * scale, PFA_RELIEF, yaw=a,
        )


def _build_palace(collection):
    px, pz = -388.0, -1426.0
    py = -pz
    g = 2.76327908039093

    rv, rf, rc = [], [], []
    # Broad stepped octagonal plinth and walkable rotunda floor.
    bc.add_cylinder(rv, rf, rc, px, py, g - 1.5, g + 0.15, 20.0, PFA_TRIM, seg=48)
    bc.add_cylinder(rv, rf, rc, px, py, g + 0.15, g + 0.85, 18.4, PFA_STONE, seg=48)
    bc.add_cylinder(rv, rf, rc, px, py, g + 0.85, g + 1.12, 17.5, PFA_RELIEF, seg=48)

    step = 2 * math.pi / 8
    # Eight open bays, deep shadow arches and four-column pier clusters.
    for k in range(8):
        bay_a = k * step
        _add_arch_band(rv, rf, rc, px + math.cos(bay_a) * 14.7, py + math.sin(bay_a) * 14.7,
                       bay_a, g + 14.7, 4.7, 6.15, 1.15, PFA_STONE)
        pier_a = bay_a + step / 2
        rx, ry = math.cos(pier_a), math.sin(pier_a)
        tx, ty = -ry, rx
        bc.add_box(rv, rf, rc, px + rx * 14.5, py + ry * 14.5, g + 11.8,
                   2.5, 2.0, 10.65, PFA_SHADOW, yaw=pier_a)
        for radial in (14.2, 16.6):
            for tangent in (-1.65, 1.65):
                _column(rv, rf, rc, px + rx * radial + tx * tangent, py + ry * radial + ty * tangent,
                        g + 0.8, g + 20.2, 0.82 if radial < 15 else 0.92, rose=True)

    # Layered entablature, relief drum and deep cornice.
    for z0, z1, radius, color in (
        (g + 21.6, g + 23.7, 17.4, PFA_STONE),
        (g + 23.7, g + 24.35, 18.2, PFA_TRIM),
        (g + 24.35, g + 27.9, 16.8, PFA_STONE),
        (g + 27.9, g + 28.65, 17.8, PFA_TRIM),
        (g + 28.65, g + 32.2, 14.9, PFA_RELIEF),
        (g + 32.2, g + 33.0, 15.5, PFA_TRIM),
    ):
        bc.add_cylinder(rv, rf, rc, px, py, z0, z1, radius, color, seg=64)
    for k in range(8):
        a = k * step
        x, y = px + math.cos(a) * 16.95, py + math.sin(a) * 16.95
        bc.add_box(rv, rf, rc, x, y, g + 26.0, 4.1, 0.28, 1.2, PFA_RELIEF, yaw=a + math.pi / 2)
        # Alternating figure groups break the long frieze into readable panels.
        for t in (-2.0, 0.0, 2.0):
            tx, ty = -math.sin(a), math.cos(a)
            bc.add_frustum(rv, rf, rc, x + tx * t, y + ty * t, g + 25.1, g + 27.0, 0.32, 0.18, PFA_SHADOW, yaw=a)

    _add_dome(rv, rf, rc, px, py, g + 33.0, 14.8, 15.8)
    bc.add_cylinder(rv, rf, rc, px, py, g + 48.6, g + 50.5, 1.55, PFA_TRIM, seg=20, r_top=0.8)
    bc.add_cylinder(rv, rf, rc, px, py, g + 50.5, g + 53.2, 0.55, PFA_RELIEF, seg=12, r_top=0.14)
    rotunda = _make("lm_palace_rotunda", rv, rf, rc, collection)

    pv, pf, pc = [], [], []
    lagoon_x, lagoon_z = -300.0, -1426.0
    radius = 112.0
    spans = ((math.radians(112), math.radians(165), 17), (math.radians(195), math.radians(238), 14))
    for span_i, (a0, a1, count) in enumerate(spans):
        points = []
        mid = (count - 1) // 2
        for k in range(count):
            a = a0 + (a1 - a0) * k / (count - 1)
            gx = lagoon_x + math.cos(a) * radius
            gz = lagoon_z + math.sin(a) * radius
            by = -gz
            is_cluster = k in (0, mid, count - 1)
            points.append((gx, by, a, is_cluster))
            if is_cluster:
                tx, ty = -math.sin(a), -math.cos(a)
                rx, ry = math.cos(a), -math.sin(a)
                for tangent in (-1.75, 1.75):
                    for radial in (-1.5, 1.5):
                        _column(pv, pf, pc, gx + tx * tangent + rx * radial, by + ty * tangent + ry * radial,
                                g - 0.45, g + 14.0, 1.04, rose=True)
            else:
                _column(pv, pf, pc, gx, by, g - 0.45, g + 14.0, 1.0, rose=True)

        for k in range(count - 1):
            x0, y0, _, _ = points[k]
            x1, y1, _, _ = points[k + 1]
            mx, my = (x0 + x1) / 2, (y0 + y1) / 2
            half = math.hypot(x1 - x0, y1 - y0) / 2 + 0.85
            yaw = math.atan2(y1 - y0, x1 - x0)
            bc.add_box(pv, pf, pc, mx, my, g + 15.1, half, 2.12, 1.05, PFA_STONE, yaw=yaw)
            bc.add_box(pv, pf, pc, mx, my, g + 16.35, half + 0.18, 2.32, 0.2, PFA_RELIEF, yaw=yaw)
            bc.add_box(pv, pf, pc, mx, my, g + 17.15, half + 0.32, 2.7, 0.55, PFA_TRIM, yaw=yaw)
            for dentil in range(5):
                t = (dentil + 0.5) / 5
                bc.add_box(pv, pf, pc, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t,
                           g + 16.72, 0.35, 2.73, 0.34, PFA_RELIEF, yaw=yaw)

        for gx, by, a, is_cluster in points:
            if not is_cluster:
                continue
            yaw = math.atan2(-math.cos(a), -math.sin(a))
            bc.add_box(pv, pf, pc, gx, by, g + 19.05, 5.1, 3.55, 1.35, PFA_STONE, yaw=yaw)
            bc.add_box(pv, pf, pc, gx, by, g + 20.6, 5.45, 3.85, 0.24, PFA_TRIM, yaw=yaw)
            # Monumental planted urn/box above each four-column pavilion.
            bc.add_frustum(pv, pf, pc, gx, by, g + 20.85, g + 22.9, 2.15, 1.58, PFA_RELIEF, yaw=yaw)
            bc.add_cylinder(pv, pf, pc, gx, by, g + 22.9, g + 24.3, 1.28, PFA_STONE, seg=16, r_top=0.45)

    peristyle = _make("lm_palace_peristyle", pv, pf, pc, collection)
    return [rotunda, peristyle]


def _tapered_tube(verts, faces, colors, p0, p1, r0, r1, color, seg=10):
    p0, p1 = Vector(p0), Vector(p1)
    direction = (p1 - p0).normalized()
    seed = Vector((0, 0, 1)) if abs(direction.z) < 0.9 else Vector((1, 0, 0))
    side = direction.cross(seed).normalized()
    up = direction.cross(side).normalized()
    rings = []
    for p, radius in ((p0, r0), (p1, r1)):
        ring = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            q = p + side * (math.cos(a) * radius) + up * (math.sin(a) * radius)
            ring.append(len(verts))
            verts.append(tuple(q))
        rings.append(ring)
    for i in range(seg):
        j = (i + 1) % seg
        _face(faces, colors, (rings[0][i], rings[0][j], rings[1][j], rings[1][i]), color)
    _face(faces, colors, rings[0][::-1], color)
    _face(faces, colors, rings[1], color)


def _build_sutro(collection):
    cx, cz = -782.0, 3846.0
    cy = -cz
    g = 254.6695098876953
    sv, sf, sc = [], [], []
    bv, bf, bc_ = [], [], []

    def radius_at(h):
        if h <= 150:
            return 38 + (16 - 38) * h / 150
        if h <= 250:
            return 16 + (11 - 16) * (h - 150) / 100
        return 11

    def leg(i, h):
        a = 2 * math.pi * i / 3 + math.pi / 6
        r = radius_at(h)
        return (cx + math.cos(a) * r, cy + math.sin(a) * r, g + h)

    # Red/white tapered leg bands; geometry is baked once rather than merged in-browser.
    levels = list(range(-3, 252, 14))
    if levels[-1] != 250:
        levels.append(250)
    for i in range(3):
        for k in range(len(levels) - 1):
            h0, h1 = levels[k], levels[k + 1]
            color = SUTRO_WHITE if k % 2 == 0 else SUTRO_RED
            _tapered_tube(sv, sf, sc, leg(i, h0), leg(i, h1), 3.35 - k * 0.035, 3.3 - k * 0.035, color, seg=10)

    ring_levels = [24, 48, 72, 110, 150, 185, 210, 235, 250]
    for h in ring_levels:
        for i in range(3):
            bc.add_tube(bv, bf, bc_, [leg(i, h), leg((i + 1) % 3, h)], 0.62 if h in (150, 250) else 0.42, SUTRO_STEEL)
    for h0, h1 in zip(ring_levels, ring_levels[1:]):
        for i in range(3):
            j = (i + 1) % 3
            bc.add_tube(bv, bf, bc_, [leg(i, h0), leg(j, h1)], 0.34, SUTRO_STEEL)
            bc.add_tube(bv, bf, bc_, [leg(j, h0), leg(i, h1)], 0.34, SUTRO_STEEL)

    # Open lattice decks: slim slabs, edge girders, and antenna equipment blocks.
    for h, half, color in ((150, 34, SUTRO_RED), (250, 30, SUTRO_RED), (258, 25, SUTRO_WHITE)):
        bc.add_box(sv, sf, sc, cx, cy, g + h, half, half, 1.3, color)
        for off in (-half, half):
            bc.add_box(bv, bf, bc_, cx + off, cy, g + h + 2.2, 0.45, half, 2.2, SUTRO_STEEL)
            bc.add_box(bv, bf, bc_, cx, cy + off, g + h + 2.2, half, 0.45, 2.2, SUTRO_STEEL)
    for a in range(0, 360, 45):
        ang = math.radians(a)
        bc.add_box(sv, sf, sc, cx + math.cos(ang) * 12, cy + math.sin(ang) * 12,
                   g + 261.2, 1.5, 1.5, 2.0, SUTRO_WHITE, yaw=ang)

    mast_tops = []
    for i in range(3):
        a = 2 * math.pi * i / 3 + math.pi / 6 + math.pi / 3
        mx, my = cx + math.cos(a) * 9, cy + math.sin(a) * 9
        last = (mx, my, g + 259)
        for k, h0 in enumerate(range(259, 300, 8)):
            h1 = min(300, h0 + 8)
            nxt = (mx, my, g + h1)
            _tapered_tube(sv, sf, sc, last, nxt, 1.25 - k * 0.09, 1.16 - k * 0.09,
                          SUTRO_WHITE if k % 2 == 0 else SUTRO_RED, seg=8)
            last = nxt
        mast_tops.append(last)

    # Guy wires to terrain anchors and secondary stabilizers from the waist.
    for i in range(3):
        a = 2 * math.pi * i / 3 + math.pi / 6 + math.pi / 3
        anchor = (cx + math.cos(a) * 150, cy + math.sin(a) * 150, g - 18)
        bc.add_tube(bv, bf, bc_, [leg(i, 250), anchor], 0.18, SUTRO_STEEL)
        bc.add_tube(bv, bf, bc_, [leg(i, 150), anchor], 0.14, SUTRO_STEEL)
    structure = _make("lm_sutro_structure", sv, sf, sc, collection)
    bracing = _make("lm_sutro_bracing", bv, bf, bc_, collection)
    return [structure, bracing]


def _export_glb(objects, path):
    objects = list(objects)
    if not objects:
        raise RuntimeError(f"No objects to export to {path}")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
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


def _save_master_without_rotating_backups():
    """Save the open master while leaving .blend1/.blend2 backup files alone."""
    filepaths = bpy.context.preferences.filepaths
    previous_versions = filepaths.save_version
    try:
        filepaths.save_version = 0
        bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)
    finally:
        filepaths.save_version = previous_versions


def upgrade_scene(export_root: str | None = None, save: bool = True):
    filepath = os.path.realpath(bpy.data.filepath)
    if os.path.basename(filepath) != "sanfrancisco.blend":
        raise RuntimeError(f"Refusing to edit non-master Blender file: {filepath}")
    if filepath.endswith((".blend1", ".blend2", ".blend3")):
        raise RuntimeError(f"Refusing to edit Blender backup: {filepath}")

    removed_faces = _remove_bids_from_merged_building("bld_8_9", PALACE_OSM_BIDS)
    _delete_named(("lm_palace_fine_arts", "lm_palace_rotunda", "lm_palace_peristyle",
                   "lm_sutro", "lm_sutro_structure", "lm_sutro_bracing"))
    palace = _build_palace(_collection(PALACE_TILE))
    sutro = _build_sutro(_collection(SUTRO_TILE))

    if save:
        _save_master_without_rotating_backups()
    exported = []
    if export_root:
        tiles_out = os.path.join(export_root, "public", "tiles")
        for key in (PALACE_TILE, SUTRO_TILE):
            out = os.path.join(tiles_out, f"{key}.glb")
            _export_glb(_collection(key).objects, out)
            exported.append(out)
        landmarks = _collection("landmarks")
        out = os.path.join(tiles_out, "landmarks.glb")
        _export_glb(landmarks.objects, out)
        exported.append(out)
    return {
        "scene": bpy.data.filepath,
        "removed_palace_osm_faces": removed_faces,
        "palace_objects": {o.name: {"vertices": len(o.data.vertices), "polygons": len(o.data.polygons)} for o in palace},
        "sutro_objects": {o.name: {"vertices": len(o.data.vertices), "polygons": len(o.data.polygons)} for o in sutro},
        "exports": exported,
    }
