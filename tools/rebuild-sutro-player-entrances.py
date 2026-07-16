"""Rebuild Sutro Baths circulation as player-first authored Blender geometry.

The original restoration had one 43-degree stair, closed decorative doors, and
an exterior terrain-ownership footprint that cut the road hillside down to sea
level beneath a 31 m portal. This pass keeps the hall, pools, and roof intact,
but gives the landmark three legible approaches:

* two open road-facing bays feeding a four-flight grand switchback;
* a broad ocean-window gate and shallow beach stair;
* the existing deck circulation between both entries and the seven pools.

Every stair collider is a solid column down to the authored ground plane. A
fast capsule therefore meets a riser/solid volume instead of tunnelling through
a thin floating tread. The script is idempotent and saves the .blend in place.
"""

from __future__ import annotations

import argparse
import math
import os
import sys

import bpy
from mathutils import Vector


SITE = "sutro-baths"
TILE = "1_12"
CENTER_X = -6125.0
CENTER_Z = 1117.0
YAW = -0.077
DECK_Y = 5.62
GROUND_Y = 2.07

MAIN_LEVELS = (31.02, 24.67, 18.32, 11.97, 5.62)
MAIN_FLIGHTS = (
    # local x, high local z, low local z
    (35.0, 68.2, 50.2),
    (29.5, 50.2, 68.2),
    (24.0, 68.2, 50.2),
    (18.5, 50.2, 68.2),
)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    values = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return parser.parse_args(values)


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


def delete_named(name):
    obj = bpy.data.objects.get(name)
    if obj is not None:
        bpy.data.objects.remove(obj, do_unlink=True)


def visual_empty(collection, name, parent=None):
    obj = bpy.data.objects.new(name, None)
    collection.objects.link(obj)
    obj.parent = parent
    mark_visual(obj)
    return obj


def cube_mesh(name, material):
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


def add_box(collection, parent, name, x, z, top, size_x, size_z, height, material):
    mesh = cube_mesh(f"SUTRO_REBUILD_BOX_{material.name}", material)
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.parent = parent
    obj.location = local_to_blender(x, z, top - height * 0.5)
    obj.rotation_euler[2] = YAW
    obj.scale = (size_x * 0.5, size_z * 0.5, height * 0.5)
    mark_visual(obj)
    return obj


def add_beam(collection, parent, name, a, b, thickness, material):
    """Box beam between local (x, z, y) endpoints."""
    start = local_to_blender(a[0], a[1], a[2])
    end = local_to_blender(b[0], b[1], b[2])
    delta = end - start
    length = delta.length
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


def add_collider(collection, name, x, z, top, size_x, size_z, bottom):
    if top <= bottom:
        raise RuntimeError(f"Collider {name} has invalid vertical span")
    obj = bpy.data.objects.new(name, None)
    collection.objects.link(obj)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 1.0
    obj.location = local_to_blender(x, z, (top + bottom) * 0.5)
    obj.rotation_euler[2] = YAW
    hx = size_x * 0.5
    hz = size_z * 0.5
    hy = (top - bottom) * 0.5
    obj.scale = (hx, hz, hy)
    obj["sf_site"] = SITE
    obj["sf_tile"] = TILE
    obj["sf_role"] = "collider"
    obj["sf_half_extents"] = [hx, hy, hz]
    return obj


def add_terrain_ownership(collection, name, footprint_id, x, z, half_x, half_z, feather):
    obj = bpy.data.objects.new(name, None)
    collection.objects.link(obj)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 1.0
    obj.location = local_to_blender(x, z, GROUND_Y)
    obj.rotation_euler[2] = YAW
    obj.scale = (half_x, half_z, 0.12)
    obj["sf_region"] = SITE
    obj["sf_role"] = "terrain_ownership"
    obj["sf_footprint_id"] = footprint_id
    obj["sf_ground_y"] = GROUND_Y
    obj["sf_feather"] = feather
    obj["sf_terrain_mode"] = "flat-ownership"
    return obj


def add_landing(collection, colliders, parent, name, x, z, top, sx, sz, material, bottom=GROUND_Y):
    add_box(collection, parent, f"{name}_slab", x, z, top, sx, sz, 0.32, material)
    add_collider(colliders, f"sutro_collider_100_{name}", x, z, top, sx, sz, bottom)


def add_stair_flight(
    collection,
    colliders,
    parent,
    name,
    x,
    high_z,
    low_z,
    high_y,
    low_y,
    width,
    material,
    iron,
    bottom=GROUND_Y,
    steps=25,
):
    dz = low_z - high_z
    for index in range(steps):
        t = index / (steps - 1)
        z = high_z + dz * t
        top = high_y + (low_y - high_y) * t
        tread = abs(dz) / (steps - 1)
        add_box(
            collection, parent, f"{name}_tread_{index:02d}",
            x, z, top, width, tread, 0.29, material,
        )
        add_collider(
            colliders, f"sutro_collider_110_{name}_{index:02d}",
            x, z, top, width, tread + 0.04, bottom,
        )

    # Two uninterrupted handrails and low-frequency posts make the route read
    # from the road without creating dozens of collision snag points.
    for side_index, side in enumerate((-1, 1)):
        rail_x = x + side * (width * 0.5 + 0.08)
        add_beam(
            collection, parent, f"{name}_rail_{side_index}",
            (rail_x, high_z, high_y + 1.05),
            (rail_x, low_z, low_y + 1.05),
            0.13, iron,
        )
        for post_index in range(0, steps, 4):
            t = post_index / (steps - 1)
            post_z = high_z + dz * t
            post_y = high_y + (low_y - high_y) * t
            add_beam(
                collection, parent, f"{name}_post_{side_index}_{post_index:02d}",
                (rail_x, post_z, post_y + 0.08),
                (rail_x, post_z, post_y + 1.08),
                0.11, iron,
            )


def add_open_gate(collection, parent, name, wall_x, pivot_z, y0, y1, length, iron):
    """Wrought-iron leaf held open perpendicular to a constant-x wall."""
    x0 = wall_x
    x1 = wall_x + length
    add_beam(collection, parent, f"{name}_bottom", (x0, pivot_z, y0), (x1, pivot_z, y0), 0.13, iron)
    add_beam(collection, parent, f"{name}_top", (x0, pivot_z, y1), (x1, pivot_z, y1), 0.13, iron)
    for index in range(7):
        x = x0 + length * index / 6
        add_beam(collection, parent, f"{name}_bar_{index}", (x, pivot_z, y0), (x, pivot_z, y1), 0.095, iron)


def add_lantern(collection, parent, name, x, z, y, iron, lamp):
    add_box(collection, parent, f"{name}_cap", x, z, y + 0.72, 0.42, 0.42, 0.14, iron)
    add_box(collection, parent, f"{name}_light", x, z, y + 0.45, 0.28, 0.28, 0.44, lamp)
    add_box(collection, parent, f"{name}_base", x, z, y + 0.16, 0.38, 0.38, 0.14, iron)


def main():
    args = parse_args()
    repo = os.path.realpath(args.repo)
    expected = os.path.realpath(os.path.join(repo, "assets-src/world/sites/sutro-baths.blend"))
    if os.path.realpath(bpy.data.filepath) != expected:
        raise RuntimeError(f"Expected {expected}, opened {bpy.data.filepath}")

    visual = bpy.data.collections.get("VISUAL")
    colliders = bpy.data.collections.get("COLLIDERS")
    authoring = bpy.data.collections.get("AUTHORING")
    terrain = bpy.data.collections.get("TERRAIN_OWNERSHIP")
    if not all((visual, colliders, authoring, terrain)):
        raise RuntimeError("Sutro authoring collections are incomplete")

    materials = {name: bpy.data.materials.get(name) for name in (
        "sutro_terracotta", "sutro_iron_dark", "sutro_iron", "sutro_brass",
        "sutro_lamp", "sutro_plaster", "sutro_plaster_shade",
    )}
    missing = [name for name, value in materials.items() if value is None]
    if missing:
        raise RuntimeError(f"Missing Sutro materials: {missing}")

    # Remove the failed one-flight entrance and all prior iterations of this pass.
    for root_name in (
        "sutro_baths_entry_grand_stair",
        "sutro_baths_entry_stair_handrails",
        "sutro_baths_classical_portal_doors",
        "sutro_baths_player_entrances_v2",
    ):
        delete_hierarchy(bpy.data.objects.get(root_name))
    # This was a solid wall directly behind the decorative portal columns.
    delete_named("Mesh_49")
    delete_named("Mesh_49.001")

    # Open the z=33.29 ocean-window bay: remove its glass and bench, then split
    # the low horizontal mullion around the clear 9 m doorway.
    for name in ("Mesh_21.011", "Mesh_24.020", "Mesh_24.021", "Mesh_24.022", "Mesh_24.023", "Mesh_22.017"):
        delete_named(name)

    # Old entry treads owned 036..067. The original ocean wall collider 019 is
    # replaced by two segments around the new beach gate.
    for obj in list(colliders.objects):
        if obj.name.startswith("sutro_collider_100_") or obj.name.startswith("sutro_collider_110_") or obj.name.startswith("sutro_collider_200_"):
            bpy.data.objects.remove(obj, do_unlink=True)
            continue
        tail = obj.name.removeprefix("sutro_collider_")
        if tail[:3].isdigit() and (int(tail[:3]) >= 36 or int(tail[:3]) == 19):
            bpy.data.objects.remove(obj, do_unlink=True)

    # The exterior footprint was the cause of the floating portal: it forced
    # the natural road hill down to 2.07 m beneath a 31 m entrance.
    delete_named("TERRAIN_entry-stairwell")
    delete_named("TERRAIN_beach-entry")
    add_terrain_ownership(terrain, "TERRAIN_beach-entry", "beach-entry", -48.0, 33.29, 9.5, 3.45, 0.35)
    bounds = authoring.objects.get("REGION_BOUNDS")
    if bounds is not None:
        bounds.scale.x = 55.5

    arrival = authoring.objects.get("ARRIVAL")
    if arrival is not None:
        arrival.location = local_to_blender(45.6, 63.1, 31.26)
        arrival.rotation_euler[2] = 1.942

    root = visual_empty(visual, "sutro_baths_player_entrances_v2")
    root["sf_design"] = "open-road-switchback-and-beach-gate"

    terracotta = materials["sutro_terracotta"]
    iron_dark = materials["sutro_iron_dark"]
    iron = materials["sutro_iron"]
    brass = materials["sutro_brass"]
    lamp = materials["sutro_lamp"]
    plaster = materials["sutro_plaster"]
    plaster_shade = materials["sutro_plaster_shade"]

    # ROAD PAVILION ---------------------------------------------------------
    road = visual_empty(visual, "sutro_baths_road_pavilion_v2", root)
    # A promenade on natural terrain joins both open road bays to the high
    # switchback landing. The boxes meet at edges rather than coplanar overlap.
    add_landing(visual, colliders, road, "road_promenade", 44.25, 63.1, 31.08, 10.5, 17.0, plaster_shade, 4.8)
    add_landing(visual, colliders, road, "road_turnaround", 35.5, 70.2, 31.08, 7.0, 3.2, terracotta, GROUND_Y)

    # The retained 1890s pavilion has three bays. Two wrought-iron leaves are
    # visibly held open against the outside walls; there is no hidden blocker.
    add_open_gate(visual, road, "road_gate_north", 48.35, 58.72, 31.2, 36.9, 3.0, iron_dark)
    add_open_gate(visual, road, "road_gate_south", 48.35, 67.48, 31.2, 36.9, 3.0, iron_dark)
    add_box(visual, road, "road_portal_sign", 48.58, 63.1, 38.35, 0.24, 7.1, 1.15, terracotta)
    # Brass sunrise reads as a welcoming landmark from a moving car.
    for index in range(9):
        angle = math.radians(-64 + index * 16)
        z0 = 63.1
        y0 = 38.42
        z1 = z0 + math.sin(angle) * 2.35
        y1 = y0 + math.cos(angle) * 1.8
        add_beam(visual, road, f"road_sunburst_{index}", (48.42, z0, y0), (48.42, z1, y1), 0.105, brass)
    for z in (56.6, 69.6):
        add_lantern(visual, road, f"road_lantern_{int(z)}", 47.85, z, 32.0, iron_dark, lamp)

    # GRAND SWITCHBACK -----------------------------------------------------
    switchback = visual_empty(visual, "sutro_baths_grand_switchback_v2", root)
    for index, (x, high_z, low_z) in enumerate(MAIN_FLIGHTS):
        add_stair_flight(
            visual, colliders, switchback, f"main_flight_{index + 1}",
            x, high_z, low_z, MAIN_LEVELS[index], MAIN_LEVELS[index + 1],
            3.8, terracotta, iron_dark,
        )

    add_landing(visual, colliders, switchback, "main_landing_1", 32.25, 47.7, MAIN_LEVELS[1], 9.1, 4.2, terracotta)
    add_landing(visual, colliders, switchback, "main_landing_2", 26.75, 70.7, MAIN_LEVELS[2], 9.1, 4.2, terracotta)
    add_landing(visual, colliders, switchback, "main_landing_3", 21.25, 47.7, MAIN_LEVELS[3], 9.1, 4.2, terracotta)
    add_landing(visual, colliders, switchback, "main_deck_arrival", 22.3, 71.0, 5.66, 11.2, 4.8, terracotta)

    # Tall plaster/iron supports turn the stair into an intentional piece of
    # bathhouse architecture instead of floating treads.
    for index, (x, z, top) in enumerate(((36.8, 47.6, 24.67), (31.3, 71.0, 18.32), (25.8, 47.6, 11.97))):
        # Stop the pier beneath the landing slab. The old version ended on the
        # walking plane and produced a real coplanar patch at each landing.
        pier_top = top - 0.32
        add_box(visual, switchback, f"switchback_pier_{index}", x, z, pier_top, 0.85, 0.85, pier_top - GROUND_Y, plaster)
        add_box(visual, switchback, f"switchback_pier_cap_{index}", x, z, top + 0.16, 1.2, 1.2, 0.32, brass)
    for index, (x, z, y) in enumerate(((35.8, 49.0, 24.7), (29.8, 69.4, 18.35), (24.2, 49.0, 12.0), (20.0, 70.0, 5.7))):
        add_lantern(visual, switchback, f"landing_lantern_{index}", x, z, y + 0.25, iron_dark, lamp)

    # BEACH / OCEAN WINDOW GATE -------------------------------------------
    beach = visual_empty(visual, "sutro_baths_beach_gate_v2", root)
    # Rebuild the removed low mullion as two non-overlapping segments.
    add_beam(visual, beach, "ocean_low_mullion_north", (-38.35, -76.1, 6.82), (-38.35, 28.54, 6.82), 0.24, iron)
    add_beam(visual, beach, "ocean_low_mullion_south", (-38.35, 38.05, 6.82), (-38.35, 76.1, 6.82), 0.24, iron)

    # Portal jambs and elliptical iron arch fit exactly between the surviving
    # mullions. Nothing occupies the clear player opening.
    spring_y = 9.18
    for z in (28.72, 37.86):
        add_box(visual, beach, f"beach_portal_jamb_{int(z * 10)}", -38.28, z, spring_y, 0.62, 0.62, spring_y - DECK_Y, plaster_shade)
    arch_points = []
    for index in range(13):
        angle = math.pi * index / 12
        arch_points.append((-38.28, 33.29 + math.cos(angle) * 4.57, spring_y + math.sin(angle) * 3.35))
    for index in range(len(arch_points) - 1):
        add_beam(visual, beach, f"beach_portal_arch_{index:02d}", arch_points[index], arch_points[index + 1], 0.34, iron_dark)
    add_box(visual, beach, "beach_gate_plaque", -38.48, 33.29, 13.55, 0.28, 5.8, 0.9, terracotta)
    for z in (29.0, 37.58):
        add_lantern(visual, beach, f"beach_lantern_{int(z * 10)}", -38.65, z, 9.5, iron_dark, lamp)

    # Open leaves fold toward the beach, making the route readable from below.
    add_open_gate(visual, beach, "beach_gate_north", -38.55, 28.95, 5.78, 9.0, -3.2, iron_dark)
    add_open_gate(visual, beach, "beach_gate_south", -38.55, 37.62, 5.78, 9.0, -3.2, iron_dark)

    # Follow the surveyed beach grade instead of burying a straight stair under
    # the live hillside. The outer tread is a comfortable step above the sand;
    # the inner tread clears the cross-slope before a short step onto the deck.
    beach_low_x = -57.0
    beach_high_x = -39.0
    beach_z = 33.29
    # Maintain at least ~20 cm of visible masonry above the highest live terrain
    # sample across the full 6.1 m stair width, not only its centerline.
    beach_low_y = 2.33
    beach_high_y = 5.83
    beach_steps = 23
    for index in range(beach_steps):
        t = index / (beach_steps - 1)
        x = beach_low_x + (beach_high_x - beach_low_x) * t
        top = beach_low_y + (beach_high_y - beach_low_y) * t
        tread = abs(beach_high_x - beach_low_x) / (beach_steps - 1)
        add_box(
            visual, beach, f"beach_stair_tread_{index:02d}",
            x, beach_z, top, tread, 6.1, max(0.12, top - GROUND_Y), terracotta,
        )
        # Stepped cheek walls make the beach cut feel deliberately excavated
        # and conceal the feathered terrain edge from a low player camera.
        for side_index, side in enumerate((-1, 1)):
            wall_top = top + 0.68
            add_box(
                visual, beach, f"beach_cheek_{side_index}_{index:02d}",
                x, beach_z + side * 3.04, wall_top,
                tread, 0.34, max(0.7, wall_top - GROUND_Y), plaster_shade,
            )
        add_collider(colliders, f"sutro_collider_200_beach_step_{index:02d}", x, beach_z, top, tread + 0.04, 6.1, 0.35)
    add_landing(visual, colliders, beach, "beach_deck_landing", -36.25, beach_z, 5.66, 4.7, 7.0, terracotta, 0.35)
    for side_index, side in enumerate((-1, 1)):
        z = beach_z + side * 3.18
        add_beam(visual, beach, f"beach_stair_rail_{side_index}", (beach_low_x, z, beach_low_y + 1.0), (beach_high_x, z, beach_high_y + 1.0), 0.13, iron_dark)
        for post_index in range(0, beach_steps, 4):
            t = post_index / (beach_steps - 1)
            x = beach_low_x + (beach_high_x - beach_low_x) * t
            top = beach_low_y + (beach_high_y - beach_low_y) * t
            add_beam(visual, beach, f"beach_post_{side_index}_{post_index:02d}", (x, z, top + 0.05), (x, z, top + 1.03), 0.1, iron_dark)

    # Split the original ocean wall collider around the 9 m portal.
    add_collider(colliders, "sutro_collider_019a_ocean_wall_north", -38.4, -23.78, 25.5, 0.7, 104.64, 5.62)
    add_collider(colliders, "sutro_collider_019b_ocean_wall_south", -38.4, 57.075, 25.5, 0.7, 38.05, 5.62)

    bpy.context.scene["sf_sutro_entrance_revision"] = 2
    bpy.context.scene["sf_sutro_entry_routes"] = "two-road-bays,grand-switchback,beach-gate"
    bpy.context.view_layer.update()
    bpy.ops.wm.save_as_mainfile(filepath=expected)

    print({
        "source": expected,
        "visual_objects": len(visual.objects),
        "colliders": len(colliders.objects),
        "arrival": tuple(round(value, 3) for value in arrival.location) if arrival else None,
    })


main()
