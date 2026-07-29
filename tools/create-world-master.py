"""Assemble the San Francisco master Blender scene: terrain + shipped city tiles.

Run by tools/create-world-master.mjs, which first decompresses the meshopt
tiles. The master is the human-facing composition; authored regions are linked
in afterwards by tools/compose-authored-world.py (bake:region keeps them fresh).

Coordinates: game frame is X east, Z south, Y up. Blender is Z up, so
blender = (x, -z, y) — the same mapping the authored-site pipeline uses.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path

import bpy
import numpy as np

TERRAIN_STEP = 4  # sample every 4th heightmap cell (32 m) for the context mesh


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--master", required=True)
    parser.add_argument("--tiles", required=True)
    values = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return parser.parse_args(values)


def clean_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in list(bpy.data.collections):
        bpy.data.collections.remove(collection)


def material(name, base, roughness=0.9, metallic=0.0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*base, 1.0)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*base, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return mat


def load_heightmap(repo):
    with open(repo / "public/data/meta.json", "r", encoding="utf8") as handle:
        meta = json.load(handle)
    grid = meta["grid"]
    width, height = grid["width"], grid["height"]
    terrain_meta = meta.get("terrain", {})
    raw = repo / "public/data/heightmap.bin"
    if terrain_meta.get("heightEncoding") == "int16":
        hm = np.fromfile(raw, dtype=np.int16).reshape(height, width)
        hm = terrain_meta["heightBase"] + hm.astype(np.float32) * terrain_meta["heightQuant"]
    else:
        hm = np.fromfile(raw, dtype=np.float32).reshape(height, width)
    return grid, hm


def build_terrain(target, grid, hm):
    step = TERRAIN_STEP
    cell = grid["cellSize"]
    min_x, min_z = grid["minX"], grid["minZ"]
    sub = hm[::step, ::step]
    rows, cols = sub.shape
    xs = (min_x + np.arange(cols, dtype=np.float32) * cell * step)
    zs = (min_z + np.arange(rows, dtype=np.float32) * cell * step)
    # blender: (x, -z, y)
    verts = np.empty((rows, cols, 3), dtype=np.float32)
    verts[..., 0] = xs[None, :]
    verts[..., 1] = -zs[:, None]
    verts[..., 2] = sub

    idx = np.arange(rows * cols, dtype=np.int64).reshape(rows, cols)
    a = idx[:-1, :-1].ravel()
    b = idx[:-1, 1:].ravel()
    c = idx[1:, 1:].ravel()
    d = idx[1:, :-1].ravel()
    faces = np.stack([a, d, c, b], axis=1)  # wound so normals face +Z (up)

    mesh = bpy.data.meshes.new("sf_terrain")
    mesh.vertices.add(rows * cols)
    mesh.vertices.foreach_set("co", verts.ravel())
    mesh.loops.add(faces.size)
    mesh.loops.foreach_set("vertex_index", faces.ravel())
    mesh.polygons.add(faces.shape[0])
    mesh.polygons.foreach_set("loop_start", np.arange(0, faces.size, 4, dtype=np.int64))
    mesh.polygons.foreach_set("loop_total", np.full(faces.shape[0], 4, dtype=np.int64))
    mesh.update()
    mesh.validate()
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    mesh.materials.append(material("SF terrain", (0.36, 0.38, 0.30), 0.95))
    obj = bpy.data.objects.new("sf_terrain", mesh)
    target.objects.link(obj)

    extent_x = cols * cell * step
    extent_z = rows * cell * step
    bpy.ops.mesh.primitive_plane_add(size=1.0, location=(min_x + extent_x / 2, -(min_z + extent_z / 2), 0.0))
    sea = bpy.context.object
    sea.name = "sf_sea"
    sea.scale = (extent_x / 2 + 400, extent_z / 2 + 400, 1.0)
    sea.data.materials.append(material("SF sea", (0.055, 0.11, 0.16), 0.15))
    for source in list(sea.users_collection):
        source.objects.unlink(sea)
    target.objects.link(sea)
    return obj


def import_tiles(target, tiles_dir):
    files = sorted(p for p in Path(tiles_dir).iterdir() if p.suffix == ".glb")
    for index, tile in enumerate(files):
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(tile))
        for obj in set(bpy.data.objects) - before:
            for source in list(obj.users_collection):
                source.objects.unlink(obj)
            target.objects.link(obj)
            obj["sf_city_tile"] = tile.stem
        if (index + 1) % 25 == 0:
            print(f"[world-master] imported {index + 1}/{len(files)} tiles", flush=True)
    print(f"[world-master] imported {len(files)} city tiles", flush=True)


def main():
    args = parse_args()
    repo = Path(args.repo).resolve()
    master = Path(args.master).resolve()
    master.parent.mkdir(parents=True, exist_ok=True)

    clean_scene()
    scene = bpy.context.scene
    scene.name = "San Francisco"
    scene["sf_world_master"] = 1
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "BLENDER_WORKBENCH"):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1000

    city = bpy.data.collections.new("CITY_CONTEXT")
    scene.collection.children.link(city)
    terrain_col = bpy.data.collections.new("TERRAIN")
    city.children.link(terrain_col)
    tiles_col = bpy.data.collections.new("CITY_TILES")
    city.children.link(tiles_col)

    grid, hm = load_heightmap(repo)
    build_terrain(terrain_col, grid, hm)
    print("[world-master] terrain ready", flush=True)
    import_tiles(tiles_col, args.tiles)

    preview = bpy.data.collections.new("MASTER_PREVIEW_ONLY")
    scene.collection.children.link(preview)
    bpy.ops.object.light_add(type="SUN", location=(0, 0, 800))
    sun = bpy.context.object
    sun.name = "SF master sun"
    sun.data.energy = 2.6
    sun.rotation_euler = (math.radians(38), math.radians(-10), math.radians(135))
    for source in list(sun.users_collection):
        source.objects.unlink(sun)
    preview.objects.link(sun)

    bpy.ops.object.camera_add(location=(2600, 300, 640))
    camera = bpy.context.object
    camera.name = "SF overview camera"
    camera.data.lens = 42
    camera.data.clip_end = 30000
    from mathutils import Vector
    direction = Vector((1642, -661, 80)) - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    for source in list(camera.users_collection):
        source.objects.unlink(camera)
    preview.objects.link(camera)
    scene.camera = camera

    if scene.world is None:
        scene.world = bpy.data.worlds.new("SF sky")
    scene.world.color = (0.55, 0.65, 0.8)

    bpy.ops.wm.save_as_mainfile(filepath=str(master))
    print(f"[world-master] saved {master}", flush=True)


if __name__ == "__main__":
    main()
