"""Create the stylized, source-authored Fort Mason campus.

The model deliberately stays procedural: the checked-in Blender file and lazy
runtime GLB can always be regenerated from this script. Coordinates come from
the existing OSM-backed city bake; architectural color and detail follow the
historic cream/red Lower Fort Mason warehouses and Building 240's white
clapboard, green roof, porch, and painted hostel sign.
"""

from __future__ import annotations

import argparse
import math
import os
import sys

import bpy
from mathutils import Vector


SITE = "fort-mason"
TILE = "10_8"


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    values = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return parser.parse_args(values)


def material(name, color, roughness=0.82, metallic=0.0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1.0)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return mat


MATS = {}


def make_materials():
    MATS.update({
        "hostel_wall": material("hostel warm white clapboard", (0.79, 0.77, 0.70), 0.92),
        "hostel_trim": material("hostel ivory trim", (0.91, 0.89, 0.82), 0.88),
        "hostel_roof": material("weathered sage shingle", (0.22, 0.30, 0.22), 0.98),
        "hostel_frame": material("hostel oxblood window frames", (0.24, 0.105, 0.075), 0.86),
        "glass": material("smoky blue window glass", (0.075, 0.13, 0.16), 0.28, 0.08),
        "sign": material("painted charcoal sign", (0.035, 0.032, 0.028), 0.80),
        "porch": material("painted porch timber", (0.83, 0.82, 0.76), 0.94),
        "curb": material("Fort Mason red curb", (0.55, 0.055, 0.035), 0.92),
        "shrub": material("trimmed cypress shrub", (0.12, 0.24, 0.09), 1.0),
        "stucco": material("Fort Mason cream stucco", (0.73, 0.72, 0.65), 0.96),
        "stucco_trim": material("Fort Mason pale trim", (0.84, 0.83, 0.76), 0.92),
        "door_red": material("historic iron red doors", (0.42, 0.075, 0.055), 0.84),
        "roof_red": material("faded terracotta roof", (0.60, 0.20, 0.105), 0.94),
        "roof_ochre": material("sun faded ochre roof", (0.57, 0.42, 0.19), 0.97),
        "skylight": material("industrial skylight", (0.24, 0.36, 0.39), 0.45, 0.04),
        "concrete": material("pier concrete", (0.34, 0.34, 0.32), 0.96),
        "pilings": material("dark wet pier pilings", (0.105, 0.09, 0.07), 0.98),
        "metal": material("aged galvanized metal", (0.33, 0.35, 0.34), 0.62, 0.32),
        "site_pad": material("Fort Mason terrace lawn", (0.24, 0.30, 0.22), 1.0),
    })


def collection(parent, name):
    value = bpy.data.collections.new(name)
    parent.children.link(value)
    return value


def unit_cube_mesh():
    mesh = bpy.data.meshes.new("fort_mason_unit_cube")
    mesh.from_pydata(
        [(-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
         (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)],
        [],
        [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
         (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)],
    )
    mesh.update()
    return mesh


UNIT_CUBE = None
CUBE_MESHES = {}
VISUAL = None
COLLIDERS = None


def mark_visual(obj):
    obj["sf_site"] = SITE
    obj["sf_tile"] = TILE
    return obj


def local_to_world(cx, cz, yaw, lx, lz):
    c, s = math.cos(yaw), math.sin(yaw)
    return cx + c * lx + s * lz, cz - s * lx + c * lz


def add_box(name, cx, cz, yaw, lx, lz, bottom, width, depth, height, mat):
    x, z = local_to_world(cx, cz, yaw, lx, lz)
    mesh = CUBE_MESHES.get(mat.name)
    if mesh is None:
        mesh = UNIT_CUBE.copy()
        mesh.name = f"fort_mason_box_{mat.name}"
        mesh.materials.append(mat)
        CUBE_MESHES[mat.name] = mesh
    obj = bpy.data.objects.new(name, mesh)
    VISUAL.objects.link(obj)
    obj.location = (x, -z, bottom + height / 2)
    obj.rotation_euler[2] = yaw
    obj.scale = (width / 2, depth / 2, height / 2)
    return mark_visual(obj)


def add_oriented_box(name, cx, cz, yaw, lx, lz, local_yaw,
                     bottom, width, depth, height, mat):
    """Place a box in the site's local frame with an additional local yaw."""
    x, z = local_to_world(cx, cz, yaw, lx, lz)
    mesh = CUBE_MESHES.get(mat.name)
    if mesh is None:
        mesh = UNIT_CUBE.copy()
        mesh.name = f"fort_mason_box_{mat.name}"
        mesh.materials.append(mat)
        CUBE_MESHES[mat.name] = mesh
    obj = bpy.data.objects.new(name, mesh)
    VISUAL.objects.link(obj)
    obj.location = (x, -z, bottom + height / 2)
    obj.rotation_euler[2] = yaw + local_yaw
    obj.scale = (width / 2, depth / 2, height / 2)
    return mark_visual(obj)


def add_gable(name, cx, cz, yaw, bottom, length, depth, rise, mat):
    # Local Blender Y is game -Z. The ridge follows local X.
    hx, hy = length / 2, depth / 2
    verts = [
        (-hx, -hy, 0), (hx, -hy, 0), (hx, hy, 0), (-hx, hy, 0),
        (-hx, 0, rise), (hx, 0, rise),
    ]
    faces = [(0, 1, 5, 4), (3, 4, 5, 2), (0, 4, 3), (1, 2, 5), (0, 3, 2, 1)]
    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.materials.append(mat)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    VISUAL.objects.link(obj)
    obj.location = (cx, -cz, bottom)
    obj.rotation_euler[2] = yaw
    return mark_visual(obj)


def add_cylinder(name, cx, cz, yaw, lx, lz, bottom, radius, height, mat, vertices=10):
    x, z = local_to_world(cx, cz, yaw, lx, lz)
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=height,
                                       location=(x, -z, bottom + height / 2))
    obj = bpy.context.object
    obj.name = name
    for coll in list(obj.users_collection):
        coll.objects.unlink(obj)
    VISUAL.objects.link(obj)
    obj.data.materials.append(mat)
    return mark_visual(obj)


def add_beam(name, start, end, width, mat):
    a, b = Vector(start), Vector(end)
    direction = b - a
    length = direction.length
    mesh = CUBE_MESHES.get(mat.name)
    if mesh is None:
        mesh = UNIT_CUBE.copy()
        mesh.name = f"fort_mason_box_{mat.name}"
        mesh.materials.append(mat)
        CUBE_MESHES[mat.name] = mesh
    obj = bpy.data.objects.new(name, mesh)
    VISUAL.objects.link(obj)
    obj.location = (a + b) / 2
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(direction.normalized())
    obj.scale = (width / 2, width / 2, length / 2)
    return mark_visual(obj)


def game_point(cx, cz, yaw, lx, lz, y):
    x, z = local_to_world(cx, cz, yaw, lx, lz)
    return (x, -z, y)


def add_text(name, text, cx, cz, yaw, lx, lz, y, size, mat, facing="front"):
    x, z = local_to_world(cx, cz, yaw, lx, lz)
    curve = bpy.data.curves.new(f"{name}_curve", "FONT")
    curve.body = text
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.size = size
    curve.extrude = 0.018
    curve.resolution_u = 2
    curve.materials.append(mat)
    obj = bpy.data.objects.new(name, curve)
    VISUAL.objects.link(obj)
    obj.location = (x, -z, y)
    obj.rotation_mode = "XYZ"
    if facing == "front":
        obj.rotation_euler = (math.pi / 2, 0, yaw)
    elif facing == "back":
        obj.rotation_euler = (math.pi / 2, 0, yaw + math.pi)
    elif facing == "end+":
        obj.rotation_euler = (math.pi / 2, 0, yaw - math.pi / 2)
    else:
        obj.rotation_euler = (math.pi / 2, 0, yaw + math.pi / 2)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.convert(target="MESH")
    obj.select_set(False)
    return mark_visual(obj)


def add_collider(name, cx, cz, yaw, lx, lz, bottom, width, depth, height):
    x, z = local_to_world(cx, cz, yaw, lx, lz)
    obj = bpy.data.objects.new(name, None)
    COLLIDERS.objects.link(obj)
    obj.empty_display_type = "CUBE"
    obj.location = (x, -z, bottom + height / 2)
    obj.rotation_euler[2] = yaw
    obj.scale = (width / 2, depth / 2, height / 2)
    obj["sf_site"] = SITE
    obj["sf_tile"] = TILE
    obj["sf_role"] = "collider"
    return obj


def add_long_window(prefix, cx, cz, yaw, lx, wall_lz, bottom, width=2.55, height=3.25, back=False):
    face = -1 if back else 1
    z = wall_lz + face * 0.055
    add_box(f"{prefix}_glass", cx, cz, yaw, lx, z, bottom, width, 0.11, height, MATS["glass"])
    frame = MATS["hostel_frame"]
    for dx in (-width / 2, 0, width / 2):
        add_box(f"{prefix}_vframe", cx, cz, yaw, lx + dx, z + face * 0.07,
                bottom - 0.06, 0.11, 0.10, height + 0.12, frame)
    for dy in (0, height / 2, height):
        add_box(f"{prefix}_hframe", cx, cz, yaw, lx, z + face * 0.07,
                bottom + dy - 0.055, width + 0.15, 0.10, 0.11, frame)


def add_hostel():
    cx, cz, base, yaw = 1362.0, -1895.2, 32.48, 0.24
    length, depth, wall, rise = 64.0, 21.5, 6.2, 3.15
    grade, floor_y = 32.55, 32.72
    entrance_x, door_width, door_height = 4.0, 4.8, 3.35
    door_left = entrance_x - door_width / 2
    door_right = entrance_x + door_width / 2
    opening_top = floor_y + door_height
    front_lz = depth / 2
    wall_thickness = 0.42

    # The hillside rises more than three metres across this footprint. A real
    # authored terrace, paired with runtime terrain ownership, keeps Building
    # 240 seated at its entrance grade instead of letting the hill swallow it.
    add_box("hostel_terrace_pad", cx, cz, yaw, 0, 1.5, grade - 0.30,
            72.0, 30.0, 0.30, MATS["site_pad"])
    add_box("hostel_foundation", cx, cz, yaw, 0, 0, base - 0.85,
            length + 0.2, depth + 0.2, 1.02, MATS["stucco_trim"])
    add_box("hostel_interior_floor", cx, cz, yaw, 0, 0, floor_y - 0.20,
            length - 0.7, depth - 0.7, 0.20, MATS["porch"])

    # Build actual walls around a real doorway. The old solid body left only
    # decorative glass on its face and made the entrance impossible to cross.
    add_box("hostel_back_wall", cx, cz, yaw, 0, -front_lz, base,
            length, wall_thickness, wall, MATS["hostel_wall"])
    for side in (-1, 1):
        add_box("hostel_end_wall", cx, cz, yaw, side * (length / 2 - wall_thickness / 2), 0,
                base, wall_thickness, depth, wall, MATS["hostel_wall"])
    left_width = door_left + length / 2
    right_width = length / 2 - door_right
    add_box("hostel_front_wall_left", cx, cz, yaw,
            -length / 2 + left_width / 2, front_lz, base,
            left_width, wall_thickness, wall, MATS["hostel_wall"])
    add_box("hostel_front_wall_right", cx, cz, yaw,
            door_right + right_width / 2, front_lz, base,
            right_width, wall_thickness, wall, MATS["hostel_wall"])
    add_box("hostel_front_door_header", cx, cz, yaw, entrance_x, front_lz,
            opening_top, door_width, wall_thickness, base + wall - opening_top,
            MATS["hostel_wall"])
    add_gable("hostel_green_gable_roof", cx, cz, yaw, base + wall,
              length + 2.2, depth + 3.0, rise, MATS["hostel_roof"])
    add_box("hostel_ridge_cap", cx, cz, yaw, 0, 0, base + wall + rise - 0.13,
            length + 2.4, 0.34, 0.28, MATS["metal"])

    # Horizontal clapboard reveals keep the facade readable without a texture.
    for row in range(1, 14):
        y = base + row * 0.44
        add_box(f"hostel_siding_back_{row}", cx, cz, yaw, 0,
                -(depth / 2 + 0.035), y, length, 0.07, 0.045, MATS["hostel_trim"])
        if y < opening_top:
            add_box(f"hostel_siding_front_left_{row}", cx, cz, yaw,
                    -length / 2 + left_width / 2, depth / 2 + 0.035,
                    y, left_width, 0.07, 0.045, MATS["hostel_trim"])
            add_box(f"hostel_siding_front_right_{row}", cx, cz, yaw,
                    door_right + right_width / 2, depth / 2 + 0.035,
                    y, right_width, 0.07, 0.045, MATS["hostel_trim"])
        else:
            add_box(f"hostel_siding_front_{row}", cx, cz, yaw, 0,
                    depth / 2 + 0.035, y, length, 0.07, 0.045, MATS["hostel_trim"])

    window_xs = [-27, -20, -13, -6, 13, 20, 27]
    for i, wx in enumerate(window_xs):
        add_long_window(f"hostel_front_window_{i}", cx, cz, yaw, wx, depth / 2,
                        base + 1.15, 3.05, 3.65)
    for i, wx in enumerate([-26, -18, -10, -2, 6, 14, 22, 28]):
        add_long_window(f"hostel_back_window_{i}", cx, cz, yaw, wx, -depth / 2,
                        base + 1.2, 2.7, 3.35, back=True)

    # Walk-through double doors are held open into the lobby. Deep red jambs,
    # glazed leaves and a transom make the entrance unmistakable from the road.
    for jamb_x in (door_left, door_right):
        add_box("hostel_entry_jamb", cx, cz, yaw, jamb_x, front_lz + 0.08,
                floor_y - 0.03, 0.18, 0.28, door_height + 0.16, MATS["hostel_frame"])
    add_box("hostel_entry_header_trim", cx, cz, yaw, entrance_x, front_lz + 0.09,
            opening_top - 0.13, door_width + 0.18, 0.28, 0.18, MATS["hostel_frame"])
    add_box("hostel_entry_transom", cx, cz, yaw, entrance_x, front_lz + 0.13,
            opening_top - 0.67, door_width - 0.32, 0.16, 0.48, MATS["glass"])
    leaf_width = 2.05
    for i, hinge_x in enumerate((door_left + 0.12, door_right - 0.12)):
        leaf_lz = front_lz - leaf_width / 2
        add_oriented_box(f"hostel_open_door_frame_{i}", cx, cz, yaw,
                         hinge_x, leaf_lz, math.pi / 2, floor_y + 0.03,
                         leaf_width, 0.18, 3.02, MATS["hostel_frame"])
        add_oriented_box(f"hostel_open_door_glass_{i}", cx, cz, yaw,
                         hinge_x, leaf_lz, math.pi / 2, floor_y + 0.28,
                         leaf_width - 0.26, 0.20, 2.42, MATS["glass"])

    canopy_bottom = floor_y + 3.55
    canopy_height = 0.42
    add_box("hostel_entry_canopy", cx, cz, yaw, entrance_x, depth / 2 + 1.25,
            canopy_bottom, 17.0, 2.7, canopy_height, MATS["hostel_trim"])
    add_box("hostel_entry_canopy_red_edge", cx, cz, yaw, entrance_x, depth / 2 + 2.62,
            canopy_bottom + 0.03, 17.25, 0.18, 0.56, MATS["hostel_frame"])
    for px in (-7.0, 7.0):
        add_box("hostel_canopy_post", cx, cz, yaw, entrance_x + px, depth / 2 + 2.3,
                floor_y, 0.19, 0.19, canopy_bottom - floor_y, MATS["hostel_trim"])
    sign_lz = depth / 2 + 2.76
    add_box("hostel_canopy_signboard", cx, cz, yaw, entrance_x, sign_lz,
            canopy_bottom + canopy_height, 17.0, 0.16, 1.45, MATS["hostel_trim"])
    add_text("hostel_sign_title", "HOSTELLING INTERNATIONAL", cx, cz, yaw,
             entrance_x, sign_lz + 0.10, canopy_bottom + canopy_height + 1.02,
             0.66, MATS["sign"])
    add_text("hostel_sign_address", "240 FORT MASON", cx, cz, yaw,
             entrance_x, sign_lz + 0.11, canopy_bottom + canopy_height + 0.43,
             0.58, MATS["sign"])

    # Painted accessible porch and unmistakable X-braced railing.
    deck_z, deck_y = depth / 2 + 2.65, floor_y
    add_box("hostel_front_porch", cx, cz, yaw, 0, deck_z, floor_y - 0.20,
            59.5, 5.6, 0.20, MATS["porch"])
    rail_z = depth / 2 + 5.38
    sections = [-29.0, -21.5, -14.0, -6.5, 11.0, 18.5, 26.0, 29.0]
    for x in sections:
        p = game_point(cx, cz, yaw, x, rail_z, deck_y)
        add_beam("hostel_rail_post", p, (p[0], p[1], p[2] + 1.25), 0.16, MATS["porch"])
    for a, b in zip(sections, sections[1:]):
        if a < entrance_x < b:
            continue
        p0 = game_point(cx, cz, yaw, a, rail_z, deck_y + 0.15)
        p1 = game_point(cx, cz, yaw, b, rail_z, deck_y + 1.10)
        q0 = game_point(cx, cz, yaw, a, rail_z, deck_y + 1.10)
        q1 = game_point(cx, cz, yaw, b, rail_z, deck_y + 0.15)
        add_beam("hostel_rail_x", p0, p1, 0.13, MATS["porch"])
        add_beam("hostel_rail_x", q0, q1, 0.13, MATS["porch"])
        add_beam("hostel_rail_top", q0, p1, 0.16, MATS["porch"])

    # Long low access ramp and red curb seen in the real entrance view.
    add_box("hostel_access_ramp", cx, cz, yaw, -20.5, depth / 2 + 5.4, base + 0.13,
            15.5, 2.5, floor_y - grade, MATS["porch"])
    add_box("hostel_red_curb", cx, cz, yaw, 0, depth / 2 + 8.0, grade - 0.12,
            70.0, 0.45, 0.35, MATS["curb"])

    # Roof vents, gutters, downspouts, and clipped hedges finish the silhouette.
    for vx in (-19, 13, 26):
        add_cylinder("hostel_roof_vent", cx, cz, yaw, vx, 0, base + wall + rise + 0.02,
                     0.30, 0.95, MATS["metal"], 12)
        add_cylinder("hostel_roof_vent_cap", cx, cz, yaw, vx, 0, base + wall + rise + 0.82,
                     0.43, 0.18, MATS["metal"], 12)
    for side in (-1, 1):
        add_box("hostel_gutter", cx, cz, yaw, 0, side * (depth / 2 + 1.48),
                base + wall - 0.18, length + 2.3, 0.22, 0.20, MATS["metal"])
    for sx in (-30.4, 30.4):
        add_box("hostel_downspout", cx, cz, yaw, sx, depth / 2 + 1.40,
                base + 0.15, 0.19, 0.18, wall - 0.1, MATS["hostel_trim"])
    for hx in (15, 20, 25, 29):
        add_box("hostel_trimmed_hedge", cx, cz, yaw, hx, depth / 2 + 6.2,
                grade, 4.0, 2.0, 1.45, MATS["shrub"])

    # Split wall colliders preserve the doorway; floor/porch slabs provide
    # stable walkable surfaces inside and outside the threshold.
    add_collider("hostel_back_wall", cx, cz, yaw, 0, -front_lz, base,
                 length, wall_thickness, wall)
    for side in (-1, 1):
        add_collider(f"hostel_end_wall_{side}", cx, cz, yaw,
                     side * (length / 2 - wall_thickness / 2), 0, base,
                     wall_thickness, depth, wall)
    add_collider("hostel_front_wall_left", cx, cz, yaw,
                 -length / 2 + left_width / 2, front_lz, base,
                 left_width, wall_thickness, wall)
    add_collider("hostel_front_wall_right", cx, cz, yaw,
                 door_right + right_width / 2, front_lz, base,
                 right_width, wall_thickness, wall)
    add_collider("hostel_floor", cx, cz, yaw, 0, 0, floor_y - 0.20,
                 length - 0.7, depth - 0.7, 0.20)
    add_collider("hostel_porch", cx, cz, yaw, 0, deck_z, floor_y - 0.20,
                 59.5, 5.6, 0.20)


def add_industrial_window(prefix, cx, cz, yaw, lx, wall_lz, bottom, width, height, side):
    lz = wall_lz + side * 0.07
    add_box(f"{prefix}_glass", cx, cz, yaw, lx, lz, bottom, width, 0.13, height, MATS["glass"])
    for dx in (-width / 2, 0, width / 2):
        add_box(f"{prefix}_v", cx, cz, yaw, lx + dx, lz + side * 0.08,
                bottom, 0.11, 0.10, height, MATS["stucco_trim"])
    for row in range(4):
        add_box(f"{prefix}_h", cx, cz, yaw, lx, lz + side * 0.08,
                bottom + row * height / 3 - 0.05, width + 0.1, 0.10, 0.10,
                MATS["stucco_trim"])


def add_warehouse(label, cx, cz, base, length, width, wall, yaw, bays, roof_variant=0, pilings=False):
    prefix = f"fort_mason_building_{label}"
    add_box(f"{prefix}_body", cx, cz, yaw, 0, 0, base, length, width, wall, MATS["stucco"])
    add_box(f"{prefix}_foundation", cx, cz, yaw, 0, 0, base - 0.45,
            length + 0.4, width + 0.4, 0.75, MATS["concrete"])
    rise = max(2.4, min(4.2, width * 0.17))
    roof_mat = MATS["roof_ochre"] if roof_variant % 2 == 0 else MATS["roof_red"]
    add_gable(f"{prefix}_gable_roof", cx, cz, yaw, base + wall,
              length + 2.4, width + 2.3, rise, roof_mat)
    add_box(f"{prefix}_ridge", cx, cz, yaw, 0, 0, base + wall + rise - 0.12,
            length + 2.5, 0.36, 0.24, MATS["roof_red"])
    for side in (-1, 1):
        add_box(f"{prefix}_gutter", cx, cz, yaw, 0, side * (width / 2 + 1.1),
                base + wall - 0.17, length + 2.4, 0.22, 0.22, MATS["metal"])

    spacing = length / bays
    for side in (-1, 1):
        wall_lz = side * width / 2
        for bay in range(bays):
            x = -length / 2 + spacing * (bay + 0.5)
            add_box(f"{prefix}_pilaster", cx, cz, yaw,
                    -length / 2 + spacing * bay, wall_lz + side * 0.10,
                    base, 0.55, 0.35, wall + 0.35, MATS["stucco_trim"])
            if bay % 2 == 0:
                door_w = min(5.7, spacing * 0.68)
                add_box(f"{prefix}_red_loading_door", cx, cz, yaw, x,
                        wall_lz + side * 0.12, base + 0.25, door_w, 0.22,
                        min(5.4, wall * 0.60), MATS["door_red"])
                for slat in range(1, 7):
                    add_box(f"{prefix}_door_slat", cx, cz, yaw, x,
                            wall_lz + side * 0.26,
                            base + 0.25 + slat * min(5.4, wall * 0.60) / 7,
                            door_w, 0.05, 0.06, MATS["stucco_trim"])
            else:
                add_industrial_window(f"{prefix}_window_{side}_{bay}", cx, cz, yaw,
                                      x, wall_lz, base + 1.2,
                                      min(4.7, spacing * 0.62), min(4.3, wall * 0.48), side)
            add_industrial_window(f"{prefix}_clerestory_{side}_{bay}", cx, cz, yaw,
                                  x, wall_lz, base + wall - 2.0,
                                  min(4.3, spacing * 0.58), 1.15, side)
        add_box(f"{prefix}_last_pilaster", cx, cz, yaw, length / 2,
                wall_lz + side * 0.10, base, 0.55, 0.35, wall + 0.35,
                MATS["stucco_trim"])

    # Raised translucent roof strips echo the repeated skylights visible from
    # Upper Fort Mason without loading a texture catalog.
    for sx in (-0.25 * length, 0, 0.25 * length):
        add_box(f"{prefix}_skylight", cx, cz, yaw, sx, -0.9,
                base + wall + rise * 0.68, min(13.0, length * 0.18), 2.2, 0.35,
                MATS["skylight"])

    add_text(f"{prefix}_label", label, cx, cz, yaw, length / 2 + 0.09, 0,
             base + wall * 0.58, min(2.8, width * 0.09), MATS["door_red"], "end+")

    if pilings:
        add_box(f"{prefix}_pier_apron", cx, cz, yaw, 0, 0, base - 0.9,
                length + 8.0, width + 7.0, 1.0, MATS["concrete"])
        for lx in range(-int(length / 2), int(length / 2) + 1, 10):
            for lz in (-width / 2 - 2.3, width / 2 + 2.3):
                add_cylinder(f"{prefix}_piling", cx, cz, yaw, lx, lz, -3.6,
                             0.42, base + 4.8, MATS["pilings"], 8)
        # Waterside service rail along the apron edge.
        rail_lz = width / 2 + 3.0
        for lx in range(-int(length / 2), int(length / 2) + 1, 10):
            p = game_point(cx, cz, yaw, lx, rail_lz, base + 0.1)
            add_beam(f"{prefix}_pier_rail_post", p, (p[0], p[1], p[2] + 1.1),
                     0.12, MATS["metal"])

    add_collider(f"{prefix}_collider", cx, cz, yaw, 0, 0, base - 0.2,
                 length, width, wall + rise + 0.4)


def add_lower_fort_mason():
    # Existing OSM footprints 19/20/22/23/24, named Landmark Buildings A-E.
    # Their dimensions retain the map silhouette while facade grammar and color
    # now follow the real historic quartermaster warehouses.
    yaw = 1.73
    add_warehouse("A", 1038.8, -1840.0, 0.9, 145.0, 22.0, 10.8, yaw, 13, 0, True)
    add_warehouse("B", 1069.5, -1851.0, 4.7, 66.0, 22.0, 10.8, yaw, 6, 1)
    add_warehouse("C", 1100.2, -1855.8, 5.0, 68.0, 25.5, 9.0, yaw, 6, 0)
    add_warehouse("D", 1165.8, -1865.2, 5.0, 68.0, 26.0, 10.8, yaw, 6, 1)
    add_warehouse("E", 1195.4, -1870.0, 5.0, 68.0, 24.0, 14.8, yaw, 6, 0)


def consolidate_visual_by_material():
    """Bake the procedural parts into one render owner per PBR material.

    The source scene stays fully reproducible, while the shipped GLB avoids a
    draw call for every clapboard reveal, window muntin, and door slat.
    """
    groups = {}
    for obj in list(VISUAL.objects):
        if obj.type != "MESH" or not obj.data.materials:
            raise RuntimeError(f"Visual object {obj.name} is missing its material")
        groups.setdefault(obj.data.materials[0].name, []).append(obj)
    for mat_name, objects in groups.items():
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        active = objects[0]
        bpy.context.view_layer.objects.active = active
        if len(objects) > 1:
            bpy.ops.object.join()
        safe_name = "".join(char if char.isalnum() else "_" for char in mat_name).strip("_").lower()
        active.name = f"fort_mason_{safe_name}"
        active.data.name = f"fort_mason_{safe_name}_mesh"
        mark_visual(active)
        active.select_set(False)


def main():
    global UNIT_CUBE, VISUAL, COLLIDERS
    args = parse_args()
    repo = os.path.realpath(args.repo)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for coll in list(bpy.data.collections):
        bpy.data.collections.remove(coll)

    make_materials()
    UNIT_CUBE = unit_cube_mesh()
    root = bpy.data.collections.new("SITE_fort_mason")
    bpy.context.scene.collection.children.link(root)
    root["sf_site"] = SITE
    VISUAL = collection(root, "VISUAL")
    COLLIDERS = collection(root, "COLLIDERS")
    COLLIDERS.hide_render = True

    add_hostel()
    add_lower_fort_mason()
    consolidate_visual_by_material()

    bpy.context.scene["sf_authoring_schema"] = 2
    bpy.context.scene["sf_region"] = SITE
    bpy.context.scene["sf_tile"] = TILE
    bpy.context.scene.render.engine = "BLENDER_EEVEE"
    output = os.path.join(repo, "assets-src", "world", "sites", "fort-mason.blend")
    os.makedirs(os.path.dirname(output), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=output)
    print(f"[fort-mason] wrote source {output} with {len(VISUAL.all_objects)} visual objects")


try:
    main()
except Exception:
    import traceback
    traceback.print_exc()
    raise SystemExit(1)
