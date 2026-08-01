"""Replace the Sutro switchback gallery with one grand spiral descent.

WHY
The v5 entrance authored the descent as four straight flights on separate z
lanes, cascading back and forth. Walking it read as a fire escape rather than an
arrival: you turned four times, each flight faced a wall, and the last one
finished against the hall's east side instead of delivering you anywhere. The
lowest flight in particular ended at a blank wall, which is what the reviewer
saw and called nonsense.

WHAT REPLACES IT
One continuous helical flight. It starts at the glazed road doors, turns left
onto the helix, and sweeps a single 249 degree curve down through twenty-five
metres to the bath deck, landing on a fan at the foot of the pool cascade. A
central newel with a lamp cluster holds the well, a curved balustrade runs both
edges the whole way, and masonry piers ground the outer edge. Nothing switches
back and nothing ends at a wall.

GEOMETRY CONTRACT
  * Treads are BOXES sharing the existing cube mesh datablock, so the glTF
    exporter's GPU-instancing path folds all 128 of them into one draw
    submission exactly as it already does for the hall's 2149 objects. At 1.95
    degrees per tread the chord error against a true arc is 2 mm, which is why
    a curved stair does not need bespoke wedge meshes here.
  * Walk collision is NOT discrete tread boxes. A box3d capsule jams on step
    faces (no step-assist); citygen / ghost-ship stairs use tilted ramps for
    the same reason. After this Blender rebuild, run
    `node tools/patch-sutro-stair-ramps.mjs` so the published tile carries a
    helical ramp (quat) instead of spiral_tread_* slabs. Visual treads stay.
  * `sutroSpiralWalkSurfaceY` in src/world/sutroBaths/layout.ts mirrors the same
    analytic helix. Keep the two in step: SPIRAL below is the shared source of
    truth and is printed on every run so the TS side can be checked against it.

The script is idempotent: it deletes every prior revision of the descent before
building, so re-running never doubles geometry.
"""

from __future__ import annotations

import argparse
import math
import os
import sys

import bpy
import mathutils
from mathutils import Vector


SITE = "sutro-baths"
TILE = "1_12"
CENTER_X = -6125.0
CENTER_Z = 1117.0
YAW = -0.077
DECK_Y = 5.62
GROUND_Y = 2.07

# --- the helix -------------------------------------------------------------
# Axis sits in the clearest part of the south end. Verified against the retained
# hall: the tiered spectator gallery (local x 28.2..34.5, y 11.2..15.9) is the
# one mass the descent could have hit, and the helix passes it at x 13..17 —
# see the clearance assertion at the end of this script.
SPIRAL = {
    "cx": 24.6,          # axis, site-local x
    "cz": 58.2,          # axis, site-local z
    "radius": 11.6,      # centre-line radius
    "width": 5.2,        # tread width (inner 9.0 .. outer 14.2)
    "startDeg": 20.66,   # head: sits exactly at the road threshold slab
    "sweepDeg": 249.34,  # single continuous curve; foot lands due north of axis
    "topY": 31.18,       # road threshold level
    "botY": 5.78,        # deck apron level (deck itself is 5.62)
    "steps": 128,
}

INNER = SPIRAL["radius"] - SPIRAL["width"] / 2
OUTER = SPIRAL["radius"] + SPIRAL["width"] / 2
TREAD_THICK = 0.26
RAIL_HEIGHT = 1.05
# Foot apron top: deliberately 2 cm under the foot fan (see build_spiral).
APRON_Y = 5.76
# Head/foot landing angular spans, measured outward from the flight ends.
HEAD_SPAN_DEG = 15.0
FOOT_SPAN_DEG = 20.0


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--site", required=False, default=SITE)
    values = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    known, _unknown = parser.parse_known_args(values)
    return known


def local_to_blender(x: float, z: float, y: float) -> Vector:
    c = math.cos(YAW)
    s = math.sin(YAW)
    game_x = CENTER_X + c * x + s * z
    game_z = CENTER_Z - s * x + c * z
    return Vector((game_x, -game_z, y))


def mark_visual(obj):
    obj["sf_site"] = SITE
    obj["sf_tile"] = TILE
    obj["sf_role"] = "visual"


def delete_hierarchy(root):
    if root is None:
        return
    descendants = []
    stack = list(root.children)
    while stack:
        child = stack.pop()
        stack.extend(list(child.children))
        descendants.append(child)
    for obj in reversed(descendants):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.objects.remove(root, do_unlink=True)


def visual_empty(collection, name, parent=None):
    obj = bpy.data.objects.new(name, None)
    collection.objects.link(obj)
    obj.parent = parent
    mark_visual(obj)
    return obj


def cube_mesh(name, material):
    """Reuses the datablock names the v5 pass established, so the new treads
    instance alongside the hall's existing boxes instead of adding geometry."""
    existing = bpy.data.meshes.get(name)
    if existing is not None:
        return existing
    vertices = [
        (-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
        (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1),
    ]
    faces = [
        (0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1),
        (1, 5, 6, 2), (2, 6, 7, 3), (4, 0, 3, 7),
    ]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(material)
    return mesh


def cylinder_mesh(name, material, segments=16):
    """Unit cylinder (radius 1, height 1, centred) so instances only differ by
    scale — one datablock, one draw submission for every drum and ring."""
    existing = bpy.data.meshes.get(name)
    if existing is not None:
        return existing
    verts = []
    faces = []
    for index in range(segments):
        angle = 2 * math.pi * index / segments
        cx, cy = math.cos(angle), math.sin(angle)
        verts.append((cx, cy, -0.5))
        verts.append((cx, cy, 0.5))
    for index in range(segments):
        a = index * 2
        b = ((index + 1) % segments) * 2
        faces.append((a, b, b + 1, a + 1))
    base_center = len(verts)
    verts.append((0.0, 0.0, -0.5))
    top_center = len(verts)
    verts.append((0.0, 0.0, 0.5))
    for index in range(segments):
        a = index * 2
        b = ((index + 1) % segments) * 2
        faces.append((base_center, b, a))
        faces.append((top_center, a + 1, b + 1))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.materials.append(material)
    return mesh


def add_cylinder(collection, parent, name, x, z, top, diameter, height, material):
    mesh = cylinder_mesh(f"SUTRO_SPIRAL_CYL_{material.name}", material)
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.parent = parent
    obj.location = local_to_blender(x, z, top - height * 0.5)
    obj.rotation_euler[2] = YAW
    obj.scale = (diameter * 0.5, diameter * 0.5, height)
    mark_visual(obj)
    return obj


def add_box(collection, parent, name, x, z, top, size_x, size_z, height, material, angle=0.0):
    """`angle` (radians) rotates the box about its own centre within the site's
    local frame — the whole reason the spiral can use plain boxes. Local +x maps
    to Blender yaw YAW, and local angle t maps to Blender yaw YAW - t."""
    mesh = cube_mesh(f"SUTRO_REBUILD_BOX_{material.name}", material)
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.parent = parent
    obj.location = local_to_blender(x, z, top - height * 0.5)
    obj.rotation_euler[2] = YAW - angle
    obj.scale = (size_x * 0.5, size_z * 0.5, height * 0.5)
    mark_visual(obj)
    return obj


def add_beam(collection, parent, name, a, b, thickness, material):
    start = local_to_blender(a[0], a[1], a[2])
    end = local_to_blender(b[0], b[1], b[2])
    delta = end - start
    length = delta.length
    if length < 1e-6:
        raise RuntimeError(f"Beam {name} is degenerate")
    mesh = cube_mesh(f"SUTRO_REBUILD_BOX_{material.name}", material)
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.parent = parent
    obj.location = (start + end) * 0.5
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = delta.to_track_quat("X", "Z")
    obj.scale = (length * 0.5, thickness * 0.5, thickness * 0.5)
    mark_visual(obj)
    return obj


def add_collider(collection, name, x, z, top, size_x, size_z, bottom, angle=0.0):
    if top <= bottom:
        raise RuntimeError(f"Collider {name} has invalid vertical span")
    obj = bpy.data.objects.new(name, None)
    collection.objects.link(obj)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 1.0
    obj.location = local_to_blender(x, z, (top + bottom) * 0.5)
    obj.rotation_euler[2] = YAW - angle
    hx = size_x * 0.5
    hz = size_z * 0.5
    hy = (top - bottom) * 0.5
    obj.scale = (hx, hz, hy)
    obj["sf_site"] = SITE
    obj["sf_tile"] = TILE
    obj["sf_role"] = "collider"
    obj["sf_half_extents"] = [hx, hy, hz]
    return obj


def add_lantern(collection, parent, name, x, z, y, iron, lamp):
    add_box(collection, parent, f"{name}_cap", x, z, y + 0.72, 0.42, 0.42, 0.14, iron)
    add_box(collection, parent, f"{name}_light", x, z, y + 0.45, 0.28, 0.28, 0.44, lamp)
    add_box(collection, parent, f"{name}_base", x, z, y + 0.16, 0.38, 0.38, 0.14, iron)


# --- helix maths (mirrored by layout.ts) -----------------------------------

def spiral_point(radius: float, theta_deg: float):
    t = math.radians(theta_deg)
    return SPIRAL["cx"] + radius * math.cos(t), SPIRAL["cz"] + radius * math.sin(t)


def spiral_step_angle(index: int) -> float:
    return SPIRAL["startDeg"] + SPIRAL["sweepDeg"] * index / (SPIRAL["steps"] - 1)


def spiral_step_top(index: int) -> float:
    return SPIRAL["topY"] + (SPIRAL["botY"] - SPIRAL["topY"]) * index / (SPIRAL["steps"] - 1)


def build_spiral(visual, colliders, parent, materials):
    terracotta = materials["sutro_terracotta"]
    iron_dark = materials["sutro_iron_dark"]
    iron = materials["sutro_iron"]
    brass = materials["sutro_brass"]
    plaster = materials["sutro_plaster"]
    plaster_shade = materials["sutro_plaster_shade"]
    lamp = materials["sutro_lamp"]

    steps = SPIRAL["steps"]
    dtheta = math.radians(SPIRAL["sweepDeg"] / (steps - 1))
    # Tangential length taken at the OUTER radius so consecutive treads overlap
    # everywhere rather than leaving a slot at the wide edge.
    going_outer = OUTER * dtheta + 0.04
    tread_radial = SPIRAL["width"] + 0.10

    for index in range(steps):
        theta = spiral_step_angle(index)
        top = spiral_step_top(index)
        cx, cz = spiral_point(SPIRAL["radius"], theta)
        add_box(
            visual, parent, f"spiral_tread_{index:03d}",
            cx, cz, top, tread_radial, going_outer, TREAD_THICK, terracotta,
            angle=math.radians(theta),
        )
        # No per-tread collider: discrete slabs jam the walk capsule. Walkable
        # collision is the helical ramp from tools/patch-sutro-stair-ramps.mjs.

    # Continuous curved balustrades on both edges, as short chord segments that
    # share the box datablock. The flight hangs 25 m over the deck, so both
    # edges get a real (thin) collider for their whole length.
    rail_segments = 44
    for side_index, side_radius in ((0, INNER - 0.14), (1, OUTER + 0.14)):
        for seg in range(rail_segments):
            t0 = seg / rail_segments
            t1 = (seg + 1) / rail_segments
            th0 = SPIRAL["startDeg"] + SPIRAL["sweepDeg"] * t0
            th1 = SPIRAL["startDeg"] + SPIRAL["sweepDeg"] * t1
            y0 = SPIRAL["topY"] + (SPIRAL["botY"] - SPIRAL["topY"]) * t0
            y1 = SPIRAL["topY"] + (SPIRAL["botY"] - SPIRAL["topY"]) * t1
            a = spiral_point(side_radius, th0)
            b = spiral_point(side_radius, th1)
            add_beam(
                visual, parent, f"spiral_rail_{side_index}_{seg:02d}",
                (a[0], a[1], y0 + RAIL_HEIGHT), (b[0], b[1], y1 + RAIL_HEIGHT),
                0.13, iron_dark,
            )
            # Stringer under the treads: gives the helix a solid soffit edge so
            # it reads as masonry rather than floating slabs.
            add_beam(
                visual, parent, f"spiral_stringer_{side_index}_{seg:02d}",
                (a[0], a[1], y0 - 0.42), (b[0], b[1], y1 - 0.42),
                0.34, terracotta,
            )
            mid_theta = (th0 + th1) * 0.5
            mid_y = (y0 + y1) * 0.5
            mx, mz = spiral_point(side_radius, mid_theta)
            chord = math.hypot(b[0] - a[0], b[1] - a[1])
            add_collider(
                colliders, f"sutro_collider_130_spiral_rail_{side_index}_{seg:02d}",
                mx, mz, mid_y + RAIL_HEIGHT + 0.06, 0.10, chord + 0.06, mid_y + 0.02,
                angle=math.radians(mid_theta),
            )
        # Balusters every other segment keeps the count sane and the rhythm read.
        for seg in range(0, rail_segments, 2):
            t = seg / rail_segments
            th = SPIRAL["startDeg"] + SPIRAL["sweepDeg"] * t
            y = SPIRAL["topY"] + (SPIRAL["botY"] - SPIRAL["topY"]) * t
            px, pz = spiral_point(side_radius, th)
            add_beam(
                visual, parent, f"spiral_baluster_{side_index}_{seg:02d}",
                (px, pz, y + 0.05), (px, pz, y + RAIL_HEIGHT + 0.02), 0.10, iron_dark,
            )

    # The newel. Round, and slim: a 3 m SQUARE plaster tower up the middle of the
    # well read as a lift shaft rather than a stair — the flat faces caught the
    # light as four big blank planes and the brass collars stuck out like
    # shelves. A 1.5 m turned column with thin rings reads as the thing a spiral
    # actually winds around, and leaves the well open so the descent is visible
    # from the deck.
    newel_top = SPIRAL["topY"] + 1.1
    add_cylinder(
        visual, parent, "spiral_newel_column",
        SPIRAL["cx"], SPIRAL["cz"], newel_top, 1.5, newel_top - GROUND_Y, plaster,
    )
    add_collider(
        colliders, "sutro_collider_150_spiral_newel",
        SPIRAL["cx"], SPIRAL["cz"], newel_top, 1.55, 1.55, DECK_Y,
    )
    for level in range(6):
        collar_y = SPIRAL["botY"] + (SPIRAL["topY"] - SPIRAL["botY"]) * level / 5
        add_cylinder(
            visual, parent, f"spiral_newel_collar_{level}",
            SPIRAL["cx"], SPIRAL["cz"], collar_y, 1.86, 0.2, brass,
        )
    add_cylinder(
        visual, parent, "spiral_newel_cap",
        SPIRAL["cx"], SPIRAL["cz"], newel_top + 0.34, 2.1, 0.34, brass,
    )
    # A lamp cluster on the cap: the one light source that reaches the whole
    # descent once the pocket twilight settles.
    for index in range(4):
        angle = math.radians(45 + index * 90)
        lx = SPIRAL["cx"] + math.cos(angle) * 0.72
        lz = SPIRAL["cz"] + math.sin(angle) * 0.72
        add_lantern(visual, parent, f"spiral_newel_lantern_{index}", lx, lz, newel_top + 0.5, iron_dark, lamp)
    # Lanterns down the outer balustrade so the curve is legible at dusk.
    for index in range(6):
        t = (index + 0.5) / 6
        th = SPIRAL["startDeg"] + SPIRAL["sweepDeg"] * t
        y = SPIRAL["topY"] + (SPIRAL["botY"] - SPIRAL["topY"]) * t
        lx, lz = spiral_point(OUTER + 0.5, th)
        add_lantern(visual, parent, f"spiral_lantern_{index}", lx, lz, y + 0.3, iron_dark, lamp)

    # Masonry piers grounding the outer edge. Spaced by sweep so they march
    # around the curve; each stops just under the stringer.
    for index in range(7):
        t = (index + 0.5) / 7
        th = SPIRAL["startDeg"] + SPIRAL["sweepDeg"] * t
        y = SPIRAL["topY"] + (SPIRAL["botY"] - SPIRAL["topY"]) * t
        px, pz = spiral_point(OUTER - 0.55, th)
        pier_top = y - 0.62
        if pier_top - GROUND_Y < 1.0:
            continue
        add_box(
            visual, parent, f"spiral_pier_{index}",
            px, pz, pier_top, 0.95, 0.95, pier_top - GROUND_Y, plaster, angle=math.radians(th),
        )
        add_box(
            visual, parent, f"spiral_pier_cap_{index}",
            px, pz, pier_top + 0.16, 1.3, 1.3, 0.3, brass, angle=math.radians(th),
        )

    # HEAD LANDING — a wedge of slab at threshold level that carries the walk out
    # of the doors and turns it onto the first tread.
    head_segments = 6
    for seg in range(head_segments):
        th = SPIRAL["startDeg"] - HEAD_SPAN_DEG + HEAD_SPAN_DEG * (seg + 0.5) / head_segments
        span = math.radians(HEAD_SPAN_DEG / head_segments)
        hx, hz = spiral_point(SPIRAL["radius"], th)
        add_box(
            visual, parent, f"spiral_head_landing_{seg}",
            hx, hz, SPIRAL["topY"], tread_radial, OUTER * span + 0.06, 0.32, terracotta,
            angle=math.radians(th),
        )
        add_collider(
            colliders, f"sutro_collider_100_spiral_head_{seg}",
            hx, hz, SPIRAL["topY"], tread_radial + 0.06, OUTER * span + 0.10,
            SPIRAL["topY"] - 0.62, angle=math.radians(th),
        )

    # FOOT FAN — the arrival. Widens past the last tread and spills north-west
    # onto the bath deck at the foot of the pool cascade, so the descent ends
    # facing the pools instead of a wall.
    foot_segments = 8
    end_theta = SPIRAL["startDeg"] + SPIRAL["sweepDeg"]
    for seg in range(foot_segments):
        th = end_theta + FOOT_SPAN_DEG * (seg + 0.5) / foot_segments
        span = math.radians(FOOT_SPAN_DEG / foot_segments)
        fx, fz = spiral_point(SPIRAL["radius"], th)
        add_box(
            visual, parent, f"spiral_foot_fan_{seg}",
            fx, fz, SPIRAL["botY"], tread_radial + 1.6, OUTER * span + 0.06, 0.32, terracotta,
            angle=math.radians(th),
        )
        add_collider(
            colliders, f"sutro_collider_100_spiral_foot_{seg}",
            fx, fz, SPIRAL["botY"], tread_radial + 1.66, OUTER * span + 0.10,
            SPIRAL["botY"] - 0.62, angle=math.radians(th),
        )
    # A short apron carrying the fan onto the deck proper (deck top 5.62). Its
    # top sits 2 cm UNDER the fan: the two footprints necessarily overlap near
    # the well, and coplanar slabs would z-fight across the whole landing. Two
    # centimetres resolves the depth test and is neither a visible seam nor a
    # step the capsule can catch on.
    apron_x, apron_z = spiral_point(SPIRAL["radius"], end_theta + FOOT_SPAN_DEG * 0.5)
    add_box(
        visual, parent, "spiral_foot_apron",
        apron_x - 4.6, apron_z - 1.0, APRON_Y, 7.0, 8.4, 0.30, terracotta,
    )
    add_collider(
        colliders, "sutro_collider_100_spiral_foot_apron",
        apron_x - 4.6, apron_z - 1.0, APRON_Y, 7.0, 8.4, DECK_Y - 0.62,
    )

    # Guard the open inner well at deck level so nobody walks off the fan into
    # the void under the helix.
    for seg in range(10):
        t0 = seg / 10
        t1 = (seg + 1) / 10
        th0 = end_theta - 6 + (FOOT_SPAN_DEG + 6) * t0
        th1 = end_theta - 6 + (FOOT_SPAN_DEG + 6) * t1
        a = spiral_point(INNER - 0.2, th0)
        b = spiral_point(INNER - 0.2, th1)
        add_beam(
            visual, parent, f"spiral_foot_guard_{seg}",
            (a[0], a[1], SPIRAL["botY"] + RAIL_HEIGHT), (b[0], b[1], SPIRAL["botY"] + RAIL_HEIGHT),
            0.13, iron_dark,
        )
    add_box(
        visual, parent, "spiral_foot_fascia",
        apron_x, apron_z, SPIRAL["botY"] - 0.30, tread_radial + 1.6, 5.0, 0.74, plaster_shade,
    )


def clearance_report(visual, spiral_names):
    """Assert the descent does not grow through the hall the way the planting
    currently grows through the gallery rail. Checks EVERY spiral part — the
    newel is a thirty-metre column and the piers run to the ground, so treads
    alone would not have caught a clash with the iron frame or a roof rib."""
    def local_bounds(obj):
        lo = [1e9, 1e9, 1e9]
        hi = [-1e9, -1e9, -1e9]
        c = math.cos(YAW)
        s = math.sin(YAW)
        for corner in obj.bound_box:
            w = obj.matrix_world @ mathutils.Vector(corner)
            gx, gz = w.x, -w.y
            dx = gx - CENTER_X
            dz = gz - CENTER_Z
            lx = c * dx - s * dz
            lz = s * dx + c * dz
            for i, v in enumerate((lx, w.z, lz)):
                lo[i] = min(lo[i], v)
                hi[i] = max(hi[i], v)
        return lo, hi

    tread_boxes = []
    for obj in visual.objects:
        if obj.type == "MESH" and obj.name.startswith("spiral_"):
            tread_boxes.append((obj.name, *local_bounds(obj)))

    clashes = []
    for obj in visual.objects:
        if obj.type != "MESH" or obj.name.startswith("spiral_"):
            continue
        # The road pavilion and its glazed doors legitimately meet the head.
        if obj.name.startswith(("road_", "entry_")):
            continue
        lo, hi = local_bounds(obj)
        for name, tlo, thi in tread_boxes:
            if (
                lo[0] < thi[0] and hi[0] > tlo[0]
                and lo[1] < thi[1] - 0.05 and hi[1] > tlo[1] + 0.05
                and lo[2] < thi[2] and hi[2] > tlo[2]
            ):
                clashes.append((obj.name, name))
                break
    if clashes:
        print(f"!! {len(clashes)} retained meshes intersect the spiral treads:")
        for retained, tread in clashes[:40]:
            print(f"     {retained}  vs  {tread}")
    else:
        print("clearance: no retained hall mesh intersects any spiral tread")
    return clashes


def main():
    args = parse_args()
    repo = os.path.realpath(args.repo)
    expected = os.path.realpath(os.path.join(repo, "assets-src/world/sites/sutro-baths.blend"))
    if os.path.realpath(bpy.data.filepath) != expected:
        raise RuntimeError(f"Expected {expected}, opened {bpy.data.filepath}")

    visual = bpy.data.collections.get("VISUAL")
    colliders = bpy.data.collections.get("COLLIDERS")
    authoring = bpy.data.collections.get("AUTHORING")
    if not all((visual, colliders, authoring)):
        raise RuntimeError("Sutro authoring collections are incomplete")

    materials = {name: bpy.data.materials.get(name) for name in (
        "sutro_terracotta", "sutro_iron_dark", "sutro_iron", "sutro_brass",
        "sutro_lamp", "sutro_plaster", "sutro_plaster_shade",
    )}
    missing = [name for name, value in materials.items() if value is None]
    if missing:
        raise RuntimeError(f"Missing Sutro materials: {missing}")

    # Demolish the switchback cascade and any earlier spiral revision.
    for root_name in (
        "sutro_baths_grand_gallery_v5",
        "sutro_baths_grand_spiral_v6",
    ):
        delete_hierarchy(bpy.data.objects.get(root_name))
    # Any stragglers left parented elsewhere by an interrupted run.
    for obj in list(visual.objects):
        if obj.name.startswith("gallery_") or obj.name.startswith("spiral_"):
            bpy.data.objects.remove(obj, do_unlink=True)
    # The cascade owned every collider whose name mentions the gallery, plus the
    # spiral's own prefixes on a re-run.
    #
    # `_130_guard_` is in this list because it is NOT in the others. The cascade
    # named its parapet visuals `gallery_guard_*` but their colliders
    # `sutro_collider_130_guard_*`, so the first pass of this demolition took the
    # rails out of sight and left twelve of them collidable, hanging in the air
    # over a hall with no landing under them — one of them right across the
    # inner half of the new flight, where a walker jammed on a knee-high bar
    # they could not see. Only the cascade's rails match: the spiral's own
    # balustrade is `sutro_collider_130_spiral_rail_*`, caught by "spiral".
    for obj in list(colliders.objects):
        if "gallery" in obj.name or "spiral" in obj.name or "_130_guard_" in obj.name:
            bpy.data.objects.remove(obj, do_unlink=True)

    entrances = bpy.data.objects.get("sutro_baths_player_entrances_v5")
    if entrances is None:
        raise RuntimeError("Expected the v5 entrance root to still exist")

    spiral_root = visual_empty(visual, "sutro_baths_grand_spiral_v6", entrances)
    spiral_root["sf_design"] = "single-249deg-helical-descent-road-doors-to-pool-deck"
    build_spiral(visual, colliders, spiral_root, materials)

    tread_names = [f"spiral_tread_{i:03d}" for i in range(SPIRAL["steps"])]
    clashes = clearance_report(visual, tread_names)

    # The arrival moves onto the deck at the foot of the pool cascade, facing
    # north up the hall. Landing on the road portal meant every visit opened on
    # a car park and a staircase instead of the room itself.
    arrival = authoring.objects.get("ARRIVAL")
    if arrival is None:
        raise RuntimeError("AUTHORING/ARRIVAL is missing")
    arrival.location = local_to_blender(-7.0, 50.0, DECK_Y + 0.08)
    arrival.rotation_euler[2] = YAW

    bpy.context.scene["sf_sutro_entrance_revision"] = 9
    bpy.context.scene["sf_sutro_entry_routes"] = "glazed-door-road-pavilion,grand-spiral,ocean-gate"
    bpy.context.view_layer.update()
    bpy.ops.wm.save_as_mainfile(filepath=expected)

    print("SPIRAL_CONTRACT " + repr({
        **SPIRAL,
        "inner": round(INNER, 4),
        "outer": round(OUTER, 4),
        "headSpanDeg": HEAD_SPAN_DEG,
        "footSpanDeg": FOOT_SPAN_DEG,
    }))
    print({
        "source": expected,
        "visual_objects": len(visual.objects),
        "colliders": len(colliders.objects),
        "treads": SPIRAL["steps"],
        "clashes": len(clashes),
        "arrival": tuple(round(v, 3) for v in arrival.location),
    })
    if clashes:
        raise RuntimeError("Spiral intersects retained hall geometry; adjust SPIRAL")


main()
