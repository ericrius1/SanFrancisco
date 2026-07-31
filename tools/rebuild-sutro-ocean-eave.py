"""Close the Sutro ocean-wall / barrel-roof slit.

WHY
The ocean window mullions and their top rail stop at y ≈ 25.10 while the arched
iron ribs spring at y ≈ 25.47. Inland the wall already meets roofSpringY 25.5
(see layout.ts and rebuild-sutro-inland-gallery.py). Against the sunset the
missing 37 cm reads as a continuous sky slit — the roof looks like it floats
above the glass wall instead of bearing on it.

WHAT THIS DOES
  1. Extends the vertical ocean mullions from deck sill to the roof spring.
  2. Raises and thickens the existing top rail into a proper wall plate.
  3. Grows the ocean window glass to tuck under that plate.
  4. Adds a continuous iron bearing ledge under the rib feet / first purlin so
     the barrel has something structural to sit on, not just a knife-edge rail.

Idempotent: re-running re-applies the same transforms and rebuilds the ledge
group from scratch. Revision is stamped on the scene.
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

# Mirrored from src/world/sutroBaths/layout.ts
ROOF_SPRING_Y = 25.5

# Measured from the blend (site-local metres).
MULLION_BOTTOM_Y = 6.62
GLASS_BOTTOM_Y = 6.82
OCEAN_FACE_X = -38.35
MULLION_PARENT = "sutro_baths_ocean_window_mullions"
GLASS_PARENT = "sutro_baths_ocean_window_glass"
GALLERY_PARENT = "sutro_baths_ocean_window_seating_gallery"
EAVE_ROOT = "sutro_baths_ocean_eave_plate"
REVISION = 2

# Final frame heights — kiss the rib feet (y≈25.47) and match inland spring.
MULLION_TOP_Y = 25.55
GLASS_TOP_Y = 25.32
WALL_PLATE_Y = 25.50
WALL_PLATE_H = 0.36


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--site", required=False, default=SITE)
    values = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    known, _unknown = parser.parse_known_args(values)
    return known


def to_local(vector: Vector):
    c = math.cos(YAW)
    s = math.sin(YAW)
    dx = vector.x - CENTER_X
    dz = -vector.y - CENTER_Z
    return (c * dx - s * dz, vector.z, s * dx + c * dz)


def local_bounds(obj):
    lo = [1e9] * 3
    hi = [-1e9] * 3
    for corner in obj.bound_box:
        point = to_local(obj.matrix_world @ Vector(corner))
        for index in range(3):
            lo[index] = min(lo[index], point[index])
            hi[index] = max(hi[index], point[index])
    return lo, hi


def mark_visual(obj):
    obj["sf_site"] = SITE
    obj["sf_tile"] = TILE
    obj["sf_role"] = "visual"


def delete_hierarchy(root):
    if root is None:
        return 0
    descendants = []
    stack = list(root.children)
    while stack:
        child = stack.pop()
        stack.extend(list(child.children))
        descendants.append(child)
    for obj in reversed(descendants):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.objects.remove(root, do_unlink=True)
    return len(descendants) + 1


def visual_empty(collection, name, parent=None):
    """Empty in the architecture-local frame (same as the ocean mullions)."""
    obj = bpy.data.objects.new(name, None)
    collection.objects.link(obj)
    if parent is not None:
        obj.parent = parent
        obj.matrix_parent_inverse.identity()
    obj.location = (0.0, 0.0, 0.0)
    obj.rotation_euler = (0.0, 0.0, 0.0)
    mark_visual(obj)
    return obj


def cube_mesh(name, material):
    existing = bpy.data.meshes.get(name)
    if existing is not None:
        return existing
    # Unit cube -0.5..0.5 so scale == full metres, matching Mesh_22.
    vertices = [
        (-0.5, -0.5, -0.5), (0.5, -0.5, -0.5), (0.5, 0.5, -0.5), (-0.5, 0.5, -0.5),
        (-0.5, -0.5, 0.5), (0.5, -0.5, 0.5), (0.5, 0.5, 0.5), (-0.5, 0.5, 0.5),
    ]
    faces = [
        (0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1),
        (1, 5, 6, 2), (2, 6, 7, 3), (4, 0, 3, 7),
    ]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(material)
    return mesh


def add_arch_box(collection, parent, name, x, z, top, size_x, size_z, height, material):
    """Box in architecture-local metres: (+x inland, +y height, +blender_y = -site z).

    The restored hall is parented under sutro_baths_restored_architecture with
    identity rotation; ocean mullions live in that frame as (x, -z, y). Using
    world-space helpers here would double-apply the architecture translation.
    """
    mesh = cube_mesh(f"SUTRO_OCEAN_EAVE_BOX_{material.name}", material)
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.parent = parent
    obj.matrix_parent_inverse.identity()
    obj.location = (x, -z, top - height * 0.5)
    obj.rotation_euler = (0.0, 0.0, 0.0)
    obj.scale = (size_x, size_z, height)
    mark_visual(obj)
    return obj


def extend_ocean_frames():
    mullion_root = bpy.data.objects.get(MULLION_PARENT)
    glass_root = bpy.data.objects.get(GLASS_PARENT)
    if mullion_root is None or glass_root is None:
        raise RuntimeError("Ocean window mullion/glass groups are missing")

    verticals = 0
    rails = 0
    for obj in mullion_root.children:
        if obj.type != "MESH":
            continue
        # Shared unit cube: tall posts are scaled on Blender Z (world up).
        # The long mid/top rails are scaled on Blender Y (along the facade).
        if obj.scale.z > 1.0:
            height = MULLION_TOP_Y - MULLION_BOTTOM_Y
            obj.scale.z = height
            obj.location.z = (MULLION_TOP_Y + MULLION_BOTTOM_Y) * 0.5
            verticals += 1
        elif obj.scale.y > 10.0 and obj.location.z > 20.0:
            # Existing top rail → wall plate at the roof spring.
            obj.location.z = WALL_PLATE_Y
            obj.scale.z = WALL_PLATE_H
            rails += 1

    if verticals < 16:
        raise RuntimeError(f"Expected ≥16 vertical ocean mullions, found {verticals}")
    if rails != 1:
        raise RuntimeError(f"Expected exactly one ocean top rail, found {rails}")

    glass_panels = 0
    for obj in glass_root.children:
        if obj.type != "MESH":
            continue
        height = GLASS_TOP_Y - GLASS_BOTTOM_Y
        obj.scale.z = height
        obj.location.z = (GLASS_TOP_Y + GLASS_BOTTOM_Y) * 0.5
        glass_panels += 1

    if glass_panels < 14:
        raise RuntimeError(f"Expected ≥14 ocean glass panels, found {glass_panels}")

    return {"verticals": verticals, "top_rail": rails, "glass": glass_panels}


def build_bearing_ledge(collection, iron, iron_light):
    """Iron plate under the rib feet, plus a thin outer fascia on the wall face."""
    gallery = bpy.data.objects.get(GALLERY_PARENT)
    if gallery is None:
        raise RuntimeError(f"{GALLERY_PARENT} is missing")

    removed = delete_hierarchy(bpy.data.objects.get(EAVE_ROOT))
    # Also drop orphaned mesh datablocks from a bad earlier revision so the
    # bake does not keep shipping double-offset geometry under a new name.
    for mesh_name in list(bpy.data.meshes.keys()):
        if mesh_name.startswith("SUTRO_OCEAN_EAVE_BOX_"):
            mesh = bpy.data.meshes.get(mesh_name)
            if mesh is not None and mesh.users == 0:
                bpy.data.meshes.remove(mesh)

    root = visual_empty(collection, EAVE_ROOT, gallery)

    # Continuous bearing ledge: spans the ocean facade, sits under rib feet
    # (x≈-38.07, y≈25.47) and the first longitudinal purlin (x≈-37.90).
    add_arch_box(
        collection, root, "ocean_eave_bearing_plate",
        x=-38.10, z=0.0, top=ROOF_SPRING_Y + 0.06,
        size_x=0.70, size_z=152.4, height=0.30,
        material=iron,
    )
    # Outer fascia on the wall face — reads as the wall plate's ocean cheek
    # and hides any remaining knife-edge between mullion and ledge.
    add_arch_box(
        collection, root, "ocean_eave_fascia",
        x=OCEAN_FACE_X - 0.06, z=0.0, top=ROOF_SPRING_Y + 0.02,
        size_x=0.16, size_z=152.4, height=0.42,
        material=iron_light,
    )
    # Cap strip flush with the wall plate, tying mullion tops into the ledge.
    add_arch_box(
        collection, root, "ocean_eave_wall_cap",
        x=OCEAN_FACE_X, z=0.0, top=ROOF_SPRING_Y + 0.04,
        size_x=0.28, size_z=152.4, height=0.22,
        material=iron,
    )

    # Short bearing shoes at each vertical mullion — the ribs have something
    # local to land on, not only a long thin plate.
    shoes = 0
    mullion_root = bpy.data.objects.get(MULLION_PARENT)
    for obj in mullion_root.children:
        if obj.type != "MESH" or obj.scale.z <= 1.0:
            continue
        # Architecture-local: location = (x, -site_z, y).
        site_z = -obj.location.y
        add_arch_box(
            collection, root, f"ocean_eave_shoe_{shoes:02d}",
            x=-38.18, z=site_z, top=ROOF_SPRING_Y + 0.10,
            size_x=0.55, size_z=0.42, height=0.38,
            material=iron,
        )
        shoes += 1

    return {"removed": removed, "shoes": shoes, "parts": 3 + shoes}


def assert_closed():
    """Fail if the ocean frame still stops short of the roof spring."""
    mullion_root = bpy.data.objects.get(MULLION_PARENT)
    tops = []
    for obj in mullion_root.children:
        if obj.type != "MESH" or obj.scale.z <= 1.0:
            continue
        _lo, hi = local_bounds(obj)
        tops.append(hi[1])
    if not tops:
        raise RuntimeError("No vertical mullions to assert")
    top = min(tops)
    if top < ROOF_SPRING_Y - 0.08:
        raise RuntimeError(
            f"Ocean mullions still short of roof spring: top={top:.3f} "
            f"spring={ROOF_SPRING_Y}"
        )

    rail = next(
        obj
        for obj in mullion_root.children
        if obj.type == "MESH" and obj.scale.y > 10.0 and obj.location.z > 20.0
    )
    rlo, rhi = local_bounds(rail)
    if rhi[1] < ROOF_SPRING_Y - 0.05:
        raise RuntimeError(f"Ocean wall plate still short: top={rhi[1]:.3f}")

    bearing = bpy.data.objects.get("ocean_eave_bearing_plate")
    if bearing is None:
        raise RuntimeError("ocean_eave_bearing_plate is missing")
    blo, bhi = local_bounds(bearing)
    mid_x = (blo[0] + bhi[0]) * 0.5
    if abs(mid_x - (-38.10)) > 0.25:
        raise RuntimeError(
            f"Bearing plate not on the ocean eave: x={blo[0]:.2f}..{bhi[0]:.2f}"
        )
    if blo[2] > -75.5 or bhi[2] < 75.5:
        raise RuntimeError(
            f"Bearing plate z-span drifted: z={blo[2]:.2f}..{bhi[2]:.2f}"
        )

    rib = bpy.data.objects.get("sutro_baths_arched_iron_ribs")
    rib_mesh = next(child for child in rib.children if child.type == "MESH")
    spring_y = None
    for vertex in rib_mesh.data.vertices:
        lx, ly, _lz = to_local(rib_mesh.matrix_world @ vertex.co)
        if lx < -37.5 and ly < 27.0:
            spring_y = ly if spring_y is None else min(spring_y, ly)
    return {
        "mullion_top": round(top, 3),
        "wall_plate_top": round(rhi[1], 3),
        "wall_plate_bottom": round(rlo[1], 3),
        "bearing_x": (round(blo[0], 3), round(bhi[0], 3)),
        "bearing_y": (round(blo[1], 3), round(bhi[1], 3)),
        "rib_spring_y": round(spring_y, 3) if spring_y is not None else None,
    }


def main():
    args = parse_args()
    repo = os.path.realpath(args.repo)
    expected = os.path.realpath(os.path.join(repo, "assets-src/world/sites/sutro-baths.blend"))
    if os.path.realpath(bpy.data.filepath) != expected:
        raise RuntimeError(f"Expected {expected}, opened {bpy.data.filepath}")

    visual = bpy.data.collections.get("VISUAL")
    if visual is None:
        raise RuntimeError("VISUAL collection is missing")

    iron = bpy.data.materials.get("sutro_iron")
    iron_light = bpy.data.materials.get("sutro_iron_light")
    if iron is None or iron_light is None:
        raise RuntimeError("sutro_iron / sutro_iron_light materials are missing")

    frames = extend_ocean_frames()
    ledge = build_bearing_ledge(visual, iron, iron_light)
    bpy.context.view_layer.update()
    measured = assert_closed()

    bpy.context.scene["sf_sutro_ocean_eave_revision"] = REVISION
    bpy.context.scene["sf_sutro_ocean_eave"] = "wall-plate-to-roof-spring"
    bpy.ops.wm.save_as_mainfile(filepath=expected)

    print({
        "source": expected,
        "frames": frames,
        "ledge": ledge,
        "measured": measured,
        "roof_spring_y": ROOF_SPRING_Y,
    })


main()
