"""Open the Sutro road grand entrance by clearing barrel-roof glass in the doorway.

WHY
The segmented barrel-roof glass continues east into the road portal bay. The
lowest panes (Mesh_14.266–.269) sit at door height across local z ≈ 57–66 and
read as a closed glass wall in front of the held-open door leaves. The doorway
must be fully open for the staraxis / road route.

WHAT
Deletes every `sutro_baths_segmented_roof_glass` child whose world AABB
intersects the door clear volume (wall plane opening between the door posts).
Idempotent.

    /Applications/Blender.app/Contents/MacOS/Blender --background \
      assets-src/world/sites/sutro-baths.blend \
      --python tools/patch-sutro-entrance-opening.py -- --repo "$PWD"
    SF_SKIP_BLENDER_COMPOSE=1 npm run bake:region -- --site sutro-baths
"""

from __future__ import annotations

import argparse
import math
import os
import sys

import bpy
from mathutils import Vector


SITE = "sutro-baths"
CENTER_X = -6125.0
CENTER_Z = 1117.0
YAW = -0.077
ROOF_PARENT = "sutro_baths_segmented_roof_glass"

# Door clear opening from rebuild-sutro-player-entrances.py
DOOR_X_MIN = 35.4
DOOR_X_MAX = 39.0
DOOR_Y_MIN = 30.9
DOOR_Y_MAX = 34.55
DOOR_Z_MIN = 61.05
DOOR_Z_MAX = 65.15


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    values = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return parser.parse_args(values)


def to_local(vector: Vector):
    c = math.cos(YAW)
    s = math.sin(YAW)
    dx = vector.x - CENTER_X
    dz = -vector.y - CENTER_Z
    return (c * dx - s * dz, vector.z, s * dx + c * dz)


def local_aabb(obj):
    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    locs = [to_local(point) for point in corners]
    return (
        min(p[0] for p in locs),
        max(p[0] for p in locs),
        min(p[1] for p in locs),
        max(p[1] for p in locs),
        min(p[2] for p in locs),
        max(p[2] for p in locs),
    )


def overlaps_door(obj) -> bool:
    min_x, max_x, min_y, max_y, min_z, max_z = local_aabb(obj)
    if max_x < DOOR_X_MIN or min_x > DOOR_X_MAX:
        return False
    if max_y < DOOR_Y_MIN or min_y > DOOR_Y_MAX:
        return False
    if max_z < DOOR_Z_MIN or min_z > DOOR_Z_MAX:
        return False
    return True


def main():
    args = parse_args()
    parent = bpy.data.objects.get(ROOF_PARENT)
    if parent is None:
        raise RuntimeError(f"{ROOF_PARENT} missing")

    doomed = []
    for obj in list(parent.children):
        if obj.type != "MESH":
            continue
        if overlaps_door(obj):
            doomed.append(obj)

    # Clear the whole east-descending portal bay below the lintel so the
    # barrel roof cannot curtain the held-open doors.
    for obj in list(parent.children):
        if obj.type != "MESH" or obj in doomed:
            continue
        min_x, max_x, min_y, max_y, min_z, max_z = local_aabb(obj)
        if max_x < 29.0 or min_x > 39.0:
            continue
        if max_z < 56.0 or min_z > 76.0:
            continue
        if min_y > 37.5:
            continue
        if max_y < 28.0:
            continue
        doomed.append(obj)

    # Door leaf glass also reads as a closed pane when looking out; keep the
    # iron frames/bars but drop the glazing so the portal is air.
    for name in ("entry_door_leaf_glass_0", "entry_door_leaf_glass_1"):
        obj = bpy.data.objects.get(name)
        if obj is not None:
            doomed.append(obj)

    names = [obj.name for obj in doomed]
    for obj in doomed:
        bpy.data.objects.remove(obj, do_unlink=True)

    blend_path = os.path.join(args.repo, "assets-src", "world", "sites", "sutro-baths.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)
    print(f"[sutro-entrance] removed {len(names)} glass pieces in doorway: {names}")


if __name__ == "__main__":
    main()
