"""Retire the Sutro bleachers and hand the inland wall over to a timber gallery.

WHY
The tiered spectator gallery was four ranks of benches hung 6 to 10 metres above
the deck along the whole inland side. Nobody sat in them (the cast is all deck
and water), they blocked the wall from every angle a visitor actually looks at
it, and their painted risers read as an orange scaffold across the room. Behind
them the wall itself was two flat colour fields — tan plaster from the deck to
the roof spring with a green band pasted across the middle — which at any range
looks like untextured blockout rather than an 1896 bath house.

WHAT REPLACES IT
The wall becomes the room's feature: a timber gallery, dark and grounding low
down, warm mid-century boards above, hung with period chromolithographs. That
work lives in src/world/sutroBaths/timberGallery.ts because the boards and the
art carry TEXTURES, and an authored-GLB material cannot: applyRegionMaterialize
(world/authoredRegions.ts) turns every authored material into a node twin whose
colorNode already owns the birth fade, so a map assigned afterwards never
reaches a pixel. This script therefore only does what has to happen in the
authored source:

  * deletes the tiered spectator gallery outright (68 meshes, 5 groups)
  * re-materials the inland wall plates and the north end wall to
    `sutro_wall_timber_dark`, so the surface behind the runtime slats — and the
    distant read before the lazy site wakes — is dark wood, not tan plaster
  * re-materials the mid-height gallery panels to `sutro_wall_timber`, warm
    boards for the same reason (the road-corner bay keeps its authored panel as
    the visible surface, so it may not stay green)

GEOMETRY CONTRACT (mirrored in src/world/sutroBaths/layout.ts as SUTRO_WALL)
The inland wall is straight, not skewed: its plate runs local x 38.09..38.71
from z -76.10 to 58.75, the pilasters stand 0.36 proud of it on a 9.5125 m
pitch centred on z 0, and the mid-height panel band spans y 8.42..17.22. Those
numbers are what the runtime cladding is built against; they are asserted
against the blend on every run and printed for the TS side to be checked
against.

Idempotent: re-running finds the gallery already gone and the materials already
assigned, and reports what it skipped.
"""

from __future__ import annotations

import argparse
import math
import os
import sys

import bpy
import mathutils


SITE = "sutro-baths"
TILE = "1_12"
CENTER_X = -6125.0
CENTER_Z = 1117.0
YAW = -0.077

BLEACHER_ROOT = "sutro_baths_tiered_spectator_gallery"

# The authored inland wall, measured from the blend (site-local metres).
WALL = {
    "faceX": 38.09,          # inner face of the wall plate
    "panelFaceX": 37.98,     # inner face of the mid-height panel band
    "pilasterFaceX": 37.70,  # pilasters stand this far into the hall
    "pitch": 9.5125,         # pilaster spacing, centred on z 0
    "bandLowY": 8.42,        # panel band, bottom
    "bandHighY": 17.22,      # panel band, top
    "topY": 25.50,           # roof spring: the top of the wall
    "deckY": 5.62,
    "zStart": -76.10,        # north end of the plate
    "zEnd": 58.75,           # where the road-entry corner takes over
    "endWallZ": -75.50,      # north end wall, inner face
    "endWallTopY": 14.02,
}

# name -> (linear base colour, roughness, metallic)
NEW_MATERIALS = {
    # Dark grounding wood: the plinth zone, and the surface the runtime slat
    # wall shows between its boards. Deliberately darker than sutro_timber_dark
    # so a gap between two lit slats reads as a shadow line.
    "sutro_wall_timber_dark": ((0.049, 0.026, 0.017, 1.0), 0.62, 0.0),
    # Warm mid-century boards: the art band, and the clerestory slats above it.
    "sutro_wall_timber": ((0.268, 0.142, 0.069, 1.0), 0.55, 0.0),
}

# The wall families, by the mesh DATABLOCK each one instances. Re-materialling
# the datablock (rather than per-object slots) is what keeps every plate in one
# GPU-instanced draw submission after the swap — and it is safe here precisely
# because each of these datablocks belongs to exactly one wall family, which the
# user count below asserts.
REMATERIAL = (
    # datablock, expected users, expected owner prefix, new material
    ("Mesh_37", 3, "sutro_baths_inland_retaining_wall", "sutro_wall_timber_dark"),
    ("Mesh_38", 15, "sutro_baths_inland_gallery_panels", "sutro_wall_timber"),
)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--site", required=False, default=SITE)
    values = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    known, _unknown = parser.parse_known_args(values)
    return known


def to_local(vector):
    """Blender world → site-local (x, y, z), the frame layout.ts authors in."""
    c = math.cos(YAW)
    s = math.sin(YAW)
    dx = vector.x - CENTER_X
    dz = -vector.y - CENTER_Z
    return (c * dx - s * dz, vector.z, s * dx + c * dz)


def local_bounds(obj):
    lo = [1e9] * 3
    hi = [-1e9] * 3
    for corner in obj.bound_box:
        point = to_local(obj.matrix_world @ mathutils.Vector(corner))
        for index in range(3):
            lo[index] = min(lo[index], point[index])
            hi[index] = max(hi[index], point[index])
    return lo, hi


def ensure_material(name):
    """Principled material shaped like the hall's others, so the glTF exporter
    writes a plain metallic-roughness material with no texture slots."""
    base_color, roughness, metallic = NEW_MATERIALS[name]
    existing = bpy.data.materials.get(name)
    if existing is not None:
        return existing, False
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    principled = next(
        node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"
    )
    principled.inputs["Base Color"].default_value = base_color
    principled.inputs["Roughness"].default_value = roughness
    principled.inputs["Metallic"].default_value = metallic
    return material, True


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


def assert_wall_contract():
    """Fail the bake if the wall the runtime cladding hugs has moved."""
    checks = []
    plate = bpy.data.objects.get("Mesh_37")
    if plate is None:
        raise RuntimeError("Inland wall plate Mesh_37 is missing")
    lo, hi = local_bounds(plate)
    checks.append(("plate faceX", lo[0], WALL["faceX"]))
    checks.append(("plate deckY", lo[1], WALL["deckY"]))
    checks.append(("plate topY", hi[1], WALL["topY"]))
    checks.append(("plate zStart", lo[2], WALL["zStart"]))
    checks.append(("plate zEnd", hi[2], WALL["zEnd"]))

    panels = bpy.data.objects.get("sutro_baths_inland_gallery_panels")
    panel_meshes = [child for child in panels.children if child.type == "MESH"]
    plo, phi = local_bounds(panel_meshes[0])
    checks.append(("panel faceX", plo[0], WALL["panelFaceX"]))
    checks.append(("panel bandLowY", plo[1], WALL["bandLowY"]))
    checks.append(("panel bandHighY", phi[1], WALL["bandHighY"]))

    pilasters = bpy.data.objects.get("sutro_baths_inland_gallery_pilasters")
    posts = sorted(
        (child for child in pilasters.children if child.type == "MESH"),
        key=lambda obj: local_bounds(obj)[0][2],
    )
    centres = []
    for post in posts:
        blo, bhi = local_bounds(post)
        if bhi[1] - blo[1] < WALL["topY"] - WALL["deckY"] - 0.5:
            continue  # the two short posts flanking the road entry
        centres.append((blo[2] + bhi[2]) * 0.5)
    if len(centres) < 8:
        raise RuntimeError("Inland wall pilaster run is unrecognisable")
    spans = [b - a for a, b in zip(centres, centres[1:])]
    checks.append(("pilaster pitch", sum(spans) / len(spans), WALL["pitch"]))
    checks.append(("pilaster phase", min(abs(c) for c in centres), 0.0))

    end_wall = bpy.data.objects.get("Mesh_37.003")
    elo, ehi = local_bounds(end_wall)
    checks.append(("end wall z", ehi[2], WALL["endWallZ"]))
    checks.append(("end wall topY", ehi[1], WALL["endWallTopY"]))

    bad = [(name, round(actual, 3), expected) for name, actual, expected in checks
           if abs(actual - expected) > 0.05]
    if bad:
        raise RuntimeError(f"Inland wall contract drifted: {bad}")
    return {name: round(actual, 3) for name, actual, _expected in checks}


def main():
    args = parse_args()
    repo = os.path.realpath(args.repo)
    expected = os.path.realpath(os.path.join(repo, "assets-src/world/sites/sutro-baths.blend"))
    if os.path.realpath(bpy.data.filepath) != expected:
        raise RuntimeError(f"Expected {expected}, opened {bpy.data.filepath}")

    visual = bpy.data.collections.get("VISUAL")
    colliders = bpy.data.collections.get("COLLIDERS")
    if not visual or not colliders:
        raise RuntimeError("Sutro authoring collections are incomplete")

    measured = assert_wall_contract()

    materials = {}
    created = []
    for name in NEW_MATERIALS:
        material, is_new = ensure_material(name)
        materials[name] = material
        if is_new:
            created.append(name)

    removed = delete_hierarchy(bpy.data.objects.get(BLEACHER_ROOT))
    # Stragglers from an interrupted run, and any collider that stood the tiers
    # up (there are none today, but a re-run must never resurrect them).
    strays = 0
    for obj in list(visual.objects):
        if obj.name.startswith("bleacher_") or "spectator" in obj.name:
            bpy.data.objects.remove(obj, do_unlink=True)
            strays += 1
    collider_strays = 0
    for obj in list(colliders.objects):
        if "bleacher" in obj.name or "spectator" in obj.name:
            bpy.data.objects.remove(obj, do_unlink=True)
            collider_strays += 1

    repainted = []
    for datablock_name, users, owner, material_name in REMATERIAL:
        mesh = bpy.data.meshes.get(datablock_name)
        if mesh is None:
            raise RuntimeError(f"Wall datablock {datablock_name} is missing")
        owners = [obj for obj in bpy.data.objects if obj.data is mesh]
        if len(owners) != users:
            raise RuntimeError(
                f"{datablock_name} has {len(owners)} users, expected {users} — "
                "re-materialling it would repaint unrelated geometry"
            )
        for obj in owners:
            if obj.parent is None or not obj.parent.name.startswith(owner):
                raise RuntimeError(f"{obj.name} is not part of {owner}")
        if not mesh.materials:
            raise RuntimeError(f"{datablock_name} has no material slot")
        if mesh.materials[0] is not materials[material_name]:
            mesh.materials[0] = materials[material_name]
            repainted.append(f"{datablock_name}->{material_name}")

    bpy.context.scene["sf_sutro_inland_gallery_revision"] = 1
    bpy.context.scene["sf_sutro_inland_gallery"] = "timber-slat-gallery-with-hung-art"
    bpy.context.view_layer.update()
    bpy.ops.wm.save_as_mainfile(filepath=expected)

    print("SUTRO_WALL_CONTRACT " + repr(WALL))
    print("SUTRO_WALL_MEASURED " + repr(measured))
    print({
        "source": expected,
        "materials_created": created,
        "bleacher_objects_removed": removed,
        "visual_strays_removed": strays,
        "collider_strays_removed": collider_strays,
        "datablocks_repainted": repainted,
        "visual_objects": len(visual.objects),
        "colliders": len(colliders.objects),
    })


main()
