"""Author a solid SW coastal hillside outside the Sutro hall + spiral.

WHY
Flat-ownership cutouts discard the heightfield with no vertical walls. From the
spiral stairs the DEM edge reads as a paper-thin lid. Rev 4 kept the fill west
of x=8 and south of z=86, which left a ~10 m empty cutout strip in front of the
hill (apron ends ~76) and left the SE cutout rim uncovered — both read as
floating terrain. Expanding north into the apron / east into the spiral is what
buried the staircase earlier.

WHAT
  1. Keep TERRAIN_hall halfZ covering the SW shelf (cutout lids punched out).
  2. Seat the hillside at the hall apron edge (z≈76.5), not 10 m beyond it.
  3. Fill south of the apron / west of the road bay; carve spiral + portal.
  4. Hold a low berm for the first ~9 m so the near top is not a floating lid.
  5. Idempotent under `sutro_baths_coastal_hillside`.

    /Applications/Blender.app/Contents/MacOS/Blender --background \
      assets-src/world/sites/sutro-baths.blend \
      --python tools/rebuild-sutro-hillside.py -- --repo "$PWD"
    SF_SKIP_BLENDER_COMPOSE=1 npm run bake:region -- --site sutro-baths
"""

from __future__ import annotations

import argparse
import json
import math
import os
import struct
import sys

import bmesh
import bpy
from mathutils import Vector


SITE = "sutro-baths"
TILE = "1_12"
CENTER_X = -6125.0
CENTER_Z = 1117.0
YAW = -0.077

HILL_ROOT = "sutro_baths_coastal_hillside"
REVISION = 9

# Bounding grid. Inclusion is notched so we never enter the spiral / road bay.
# End just past the hall cutout (halfZ=92) so we fill the punched hole and
# hand back to the DEM — extending to z=125 built a mesa over the ocean that
# read as more floating terrain from the spiral.
HILL_MIN_X = -46.0
HILL_MAX_X = 36.0
HILL_MIN_Z = 76.5
HILL_MAX_Z = 98.0
GRID_X = 24
GRID_Z = 14

# Spiral axis ~ (24.6, 58.2), outer radius ~14 → footprint ends ~z 72.
# Grid starts at z=76.5 (south of spiral). Still keep a cylinder + road-bay
# carve so a future MIN_Z tweak cannot bury the staraxis again.
SPIRAL_AXIS_X = 24.6
SPIRAL_AXIS_Z = 58.2
SPIRAL_KEEP_R = 16.0
ROAD_PORTAL_MIN_X = 29.0
ROAD_PORTAL_MAX_Z = 80.0

CLIFF_BASE_Y = 5.5
# Sink the underside below any walkable / visible floor so the closed mesh
# never shows a floating bottom lid from outside the glass.
SKIRT_FLOOR_Y = -2.5
# Hold apron height across the first ~9 m south of the wall so the near
# shelf never reads as a floating mid-air lid from the spiral.
BERM_FRACTION = 0.22
RISE_FRACTION = 0.60

# Hall cutout: cover the authored SW shelf without swallowing the road portal.
HALL_CUTOUT_HALF_X = 39.05
HALL_CUTOUT_HALF_Z = 92.0
HALL_CUTOUT_GROUND_Y = 2.07
HALL_CUTOUT_FEATHER = 0.22


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    values = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return parser.parse_args(values)


def mark_visual(obj):
    obj["sf_site"] = SITE
    obj["sf_tile"] = TILE
    obj["sf_role"] = "visual"


def local_to_world(x: float, z: float) -> tuple[float, float]:
    c = math.cos(YAW)
    s = math.sin(YAW)
    return CENTER_X + c * x + s * z, CENTER_Z - s * x + c * z


def included(x: float, z: float) -> bool:
    """Hillside footprint south of the apron, carved clear of spiral / road bay."""
    if z < HILL_MIN_Z or z > HILL_MAX_Z or x < HILL_MIN_X or x > HILL_MAX_X:
        return False
    # Never invade the spiral cylinder (belt-and-suspenders; grid starts at 76.5).
    if (x - SPIRAL_AXIS_X) ** 2 + (z - SPIRAL_AXIS_Z) ** 2 <= SPIRAL_KEEP_R ** 2:
        return False
    # Road portal / upper stair head stay clear.
    if x >= ROAD_PORTAL_MIN_X and z <= ROAD_PORTAL_MAX_Z:
        return False
    return True


def ensure_material(name: str, colour: tuple[float, float, float], roughness: float):
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = (*colour, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.12
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


def load_height_sampler(repo: str):
    meta = json.load(open(os.path.join(repo, "public", "data", "meta.json"), "r", encoding="utf8"))
    grid = meta["grid"]
    terrain = meta["terrain"]
    width = int(grid["width"])
    height = int(grid["height"])
    cell = float(grid["cellSize"])
    min_x = float(grid["minX"])
    min_z = float(grid["minZ"])
    base = float(terrain["heightBase"])
    quant = float(terrain["heightQuant"])
    raw = open(os.path.join(repo, "public", "data", "heightmap.bin"), "rb").read()
    count = width * height
    heights = struct.unpack(f"<{count}h", raw[: count * 2])

    def sample(world_x: float, world_z: float) -> float:
        fx = (world_x - min_x) / cell
        fz = (world_z - min_z) / cell
        x0 = max(0, min(width - 1, math.floor(fx)))
        z0 = max(0, min(height - 1, math.floor(fz)))
        x1 = min(width - 1, x0 + 1)
        z1 = min(height - 1, z0 + 1)
        tx = max(0.0, min(1.0, fx - x0))
        tz = max(0.0, min(1.0, fz - z0))

        def at(ix: int, iz: int) -> float:
            return base + heights[iz * width + ix] * quant

        return (at(x0, z0) * (1 - tx) + at(x1, z0) * tx) * (1 - tz) + (
            at(x0, z1) * (1 - tx) + at(x1, z1) * tx
        ) * tz

    return sample


def delete_hierarchy(name: str) -> int:
    root = bpy.data.objects.get(name)
    if root is None:
        return 0
    stack = list(root.children)
    doomed = [root]
    while stack:
        child = stack.pop()
        stack.extend(list(child.children))
        doomed.append(child)
    for obj in reversed(doomed):
        bpy.data.objects.remove(obj, do_unlink=True)
    return len(doomed)


def set_hall_cutout():
    empty = bpy.data.objects.get("TERRAIN_hall")
    if empty is None:
        raise RuntimeError("TERRAIN_hall ownership empty is missing")
    empty.location = (CENTER_X, -CENTER_Z, HALL_CUTOUT_GROUND_Y)
    empty.scale = (HALL_CUTOUT_HALF_X, HALL_CUTOUT_HALF_Z, 0.12)
    empty.rotation_euler[2] = YAW
    empty["sf_feather"] = HALL_CUTOUT_FEATHER
    empty["sf_ground_y"] = HALL_CUTOUT_GROUND_Y


def build_hillside_mesh(sample_height):
    grass = ensure_material("sutro_hill_grass", (0.33, 0.41, 0.21), 0.92)
    dirt = ensure_material("sutro_hill_dirt", (0.45, 0.34, 0.23), 0.95)
    rock = ensure_material("sutro_hill_rock", (0.50, 0.46, 0.40), 0.88)

    xs = [HILL_MIN_X + (HILL_MAX_X - HILL_MIN_X) * i / (GRID_X - 1) for i in range(GRID_X)]
    zs = [HILL_MIN_Z + (HILL_MAX_Z - HILL_MIN_Z) * j / (GRID_Z - 1) for j in range(GRID_Z)]
    active = [[included(x, z) for x in xs] for z in zs]
    top = [[0.0] * GRID_X for _ in range(GRID_Z)]
    for j, z in enumerate(zs):
        for i, x in enumerate(xs):
            if not active[j][i]:
                continue
            wx, wz = local_to_world(x, z)
            dem = sample_height(wx, wz)
            edge = (z - HILL_MIN_Z) / max(1e-3, HILL_MAX_Z - HILL_MIN_Z)
            # Low berm against the hall, then a gentle rise to DEM — a fast
            # rise made the near top read as a floating mid-air slab. Hold the
            # berm longer on the east so the shelf by the spiral stays deck-
            # height and never reads as a dune clipping the staraxis.
            berm = BERM_FRACTION + (0.18 if x > 10.0 else 0.0)
            if edge <= berm:
                blend = 0.0
            else:
                blend = min(1.0, (edge - berm) / max(1e-3, RISE_FRACTION))
            target = max(dem, CLIFF_BASE_Y + 1.5)
            top[j][i] = CLIFF_BASE_Y + (target - CLIFF_BASE_Y) * blend

    bm = bmesh.new()
    top_verts = [[None] * GRID_X for _ in range(GRID_Z)]
    bot_verts = [[None] * GRID_X for _ in range(GRID_Z)]
    for j, z in enumerate(zs):
        for i, x in enumerate(xs):
            if not active[j][i]:
                continue
            y_top = top[j][i]
            rim = max(
                0.0,
                1.0 - (x - HILL_MIN_X) / 12.0,
                (z - (HILL_MAX_Z - 10.0)) / 10.0,
            )
            y_bot = SKIRT_FLOOR_Y - 0.6 * max(0.0, min(1.0, rim))
            top_verts[j][i] = bm.verts.new((x, -z, y_top))
            bot_verts[j][i] = bm.verts.new((x, -z, y_bot))
    bm.verts.ensure_lookup_table()

    def quad(a, b, c, d):
        if None in (a, b, c, d):
            return
        try:
            bm.faces.new((a, b, c, d))
        except ValueError:
            pass

    for j in range(GRID_Z - 1):
        for i in range(GRID_X - 1):
            if not (active[j][i] and active[j][i + 1] and active[j + 1][i] and active[j + 1][i + 1]):
                continue
            quad(top_verts[j][i], top_verts[j][i + 1], top_verts[j + 1][i + 1], top_verts[j + 1][i])
            quad(bot_verts[j][i], bot_verts[j + 1][i], bot_verts[j + 1][i + 1], bot_verts[j][i + 1])

    # Side walls wherever an included cell borders an excluded / grid-edge cell.
    for j in range(GRID_Z):
        for i in range(GRID_X):
            if not active[j][i]:
                continue
            # -Z (north / apron) edge
            if j == 0 or not active[j - 1][i]:
                if i + 1 < GRID_X and active[j][i + 1] and (j == 0 or not active[j - 1][i + 1]):
                    quad(
                        bot_verts[j][i],
                        bot_verts[j][i + 1],
                        top_verts[j][i + 1],
                        top_verts[j][i],
                    )
            # +Z (south) edge
            if j == GRID_Z - 1 or not active[j + 1][i]:
                if i + 1 < GRID_X and active[j][i + 1] and (j == GRID_Z - 1 or not active[j + 1][i + 1]):
                    quad(
                        bot_verts[j][i + 1],
                        bot_verts[j][i],
                        top_verts[j][i],
                        top_verts[j][i + 1],
                    )
            # -X (west) edge
            if i == 0 or not active[j][i - 1]:
                if j + 1 < GRID_Z and active[j + 1][i] and (i == 0 or not active[j + 1][i - 1]):
                    quad(
                        bot_verts[j][i],
                        top_verts[j][i],
                        top_verts[j + 1][i],
                        bot_verts[j + 1][i],
                    )
            # +X (east) edge
            if i == GRID_X - 1 or not active[j][i + 1]:
                if j + 1 < GRID_Z and active[j + 1][i] and (i == GRID_X - 1 or not active[j + 1][i + 1]):
                    quad(
                        bot_verts[j][i],
                        bot_verts[j + 1][i],
                        top_verts[j + 1][i],
                        top_verts[j][i],
                    )

    bm.normal_update()
    mesh = bpy.data.meshes.new("sutro_coastal_hillside_mesh")
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(grass)
    mesh.materials.append(dirt)
    mesh.materials.append(rock)
    for poly in mesh.polygons:
        n = poly.normal
        if n.z > 0.55:
            poly.material_index = 0
        elif n.z > 0.15:
            poly.material_index = 2
        else:
            poly.material_index = 1
    active_count = sum(1 for row in active for v in row if v)
    return mesh, top, active_count


def main():
    args = parse_args()
    sample = load_height_sampler(args.repo)
    root = bpy.data.objects.get("sutro_baths_restored_architecture")
    visual = bpy.data.collections.get("VISUAL")
    if root is None or visual is None:
        raise RuntimeError("Sutro visual root/collection missing")

    removed = delete_hierarchy(HILL_ROOT)
    colliders = bpy.data.collections.get("COLLIDERS")
    if colliders is not None:
        for old in list(colliders.objects):
            if old.name.startswith("sutro_collider_hillside_"):
                bpy.data.objects.remove(old, do_unlink=True)

    set_hall_cutout()
    group = bpy.data.objects.new(HILL_ROOT, None)
    visual.objects.link(group)
    group.parent = root
    mark_visual(group)
    group["sf_hillside_revision"] = REVISION

    mesh, top, active_count = build_hillside_mesh(sample)
    body = bpy.data.objects.new("sutro_coastal_hillside_body", mesh)
    visual.objects.link(body)
    body.parent = group
    mark_visual(body)

    blend_path = os.path.join(args.repo, "assets-src", "world", "sites", "sutro-baths.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)
    ys = [v for row in top for v in row if v > 0]
    print(
        f"[sutro-hillside] revision={REVISION} removed={removed} cells={active_count} "
        f"cutoutHalfZ={HALL_CUTOUT_HALF_Z} y=[{min(ys):.1f}..{max(ys):.1f}] "
        f"z=[{HILL_MIN_Z}..{HILL_MAX_Z}] x=[{HILL_MIN_X}..{HILL_MAX_X}]"
    )


if __name__ == "__main__":
    main()
