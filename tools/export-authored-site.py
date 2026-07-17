"""Validate and export one manifest-driven Blender-authored static region."""

from __future__ import annotations

import argparse
import json
import os
import sys

import bpy


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--site", required=True)
    values = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return parser.parse_args(values)


def load_region(repo, site):
    with open(os.path.join(repo, "data", "authored-regions.json"), "r", encoding="utf8") as handle:
        manifest = json.load(handle)
    if manifest.get("schema") != 1:
        raise RuntimeError("Unsupported authored-region manifest schema")
    region = next((entry for entry in manifest["regions"] if entry["id"] == site), None)
    if not region:
        raise RuntimeError(f"Unknown authored region {site}")
    return region


def collection_objects_recursive(collection):
    result = set(collection.objects)
    for child in collection.children:
        result.update(collection_objects_recursive(child))
    return result


def game_box(obj):
    location, rotation, scale = obj.matrix_world.decompose()
    euler = rotation.to_euler("XYZ")
    if abs(euler.x) > 1e-5 or abs(euler.y) > 1e-5:
        raise RuntimeError(f"Marker {obj.name} may rotate only around Blender Z")
    return {
        "centerX": round(location.x, 6),
        "centerZ": round(-location.y, 6),
        "halfX": round(abs(scale.x), 6),
        "halfZ": round(abs(scale.y), 6),
        "yaw": round(euler.z, 6),
    }


def collider_transform(obj):
    values = game_box(obj)
    location, _rotation, scale = obj.matrix_world.decompose()
    return {
        "x": values["centerX"],
        "y": round(location.z, 6),
        "z": values["centerZ"],
        "hx": values["halfX"],
        "hy": round(abs(scale.z), 6),
        "hz": values["halfZ"],
        "yaw": values["yaw"],
    }


def main():
    args = parse_args()
    repo = os.path.realpath(args.repo)
    config = load_region(repo, args.site)
    expected_source = os.path.realpath(os.path.join(repo, config["source"]))
    if os.path.realpath(bpy.data.filepath) != expected_source:
        raise RuntimeError(f"Expected {expected_source}, opened {bpy.data.filepath}")
    if bpy.context.scene.get("sf_authoring_schema") != 2:
        raise RuntimeError("Unsupported or missing sf_authoring_schema")
    if bpy.context.scene.get("sf_region") != args.site:
        raise RuntimeError("Scene region id does not match the requested export")

    root = bpy.data.collections.get(config["collection"])
    visual = bpy.data.collections.get("VISUAL")
    collider_collection = bpy.data.collections.get("COLLIDERS")
    guides = bpy.data.collections.get("AUTHORING")
    terrain_collection = bpy.data.collections.get("TERRAIN_OWNERSHIP")
    if not root or not visual or not collider_collection or not guides:
        raise RuntimeError("Required SITE/VISUAL/COLLIDERS/AUTHORING collections are missing")

    visual_objects = sorted(collection_objects_recursive(visual), key=lambda value: value.name)
    meshes = [obj for obj in visual_objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError("VISUAL contains no mesh objects")
    for obj in visual_objects:
        if obj.get("sf_site") != args.site or obj.get("sf_tile") != config["tile"]:
            raise RuntimeError(f"{obj.name} has invalid region/tile ownership")
        if min(abs(value) for value in obj.scale) < 1e-8:
            raise RuntimeError(f"{obj.name} has a zero scale component")

    collider_objects = sorted(collider_collection.objects, key=lambda value: value.name)
    collider_payload = []
    for index, obj in enumerate(collider_objects):
        if obj.type != "EMPTY" or obj.get("sf_role") != "collider":
            raise RuntimeError(f"{obj.name} is not an authored collider empty")
        values = collider_transform(obj)
        if min(values["hx"], values["hy"], values["hz"]) <= 0:
            raise RuntimeError(f"{obj.name} has non-positive half extents")
        collider_payload.append({
            "name": obj.name,
            "i": config["colliderBase"] + index,
            **values,
        })

    bounds_obj = guides.objects.get("REGION_BOUNDS")
    if not bounds_obj or bounds_obj.get("sf_role") != "region_bounds":
        raise RuntimeError("AUTHORING/REGION_BOUNDS is missing or invalid")
    bounds = game_box(bounds_obj)
    arrival_distance = float(bounds_obj.get("sf_arrival_distance", config["arrivalDistance"]))
    load_distance = float(bounds_obj.get("sf_load_distance", config["loadDistance"]))
    unload_distance = float(bounds_obj.get("sf_unload_distance", config["unloadDistance"]))
    if min(arrival_distance, load_distance, unload_distance) <= 0 or unload_distance <= load_distance:
        raise RuntimeError("Region streaming distances are invalid")

    arrival_payload = None
    if config.get("arrival"):
        arrival_obj = guides.objects.get("ARRIVAL")
        if not arrival_obj or arrival_obj.get("sf_role") != "arrival":
            raise RuntimeError("AUTHORING/ARRIVAL is missing or invalid")
        location, rotation, _scale = arrival_obj.matrix_world.decompose()
        euler = rotation.to_euler("XYZ")
        if abs(euler.x) > 1e-5 or abs(euler.y) > 1e-5:
            raise RuntimeError("ARRIVAL may rotate only around Blender Z")
        arrival_payload = {
            "spawnKey": str(arrival_obj["sf_spawn_key"]),
            "x": round(location.x, 6),
            "y": round(location.z, 6),
            "z": round(-location.y, 6),
            "heading": round(euler.z, 6),
        }

    terrain_payload = None
    if config.get("terrain"):
        if not terrain_collection:
            raise RuntimeError("TERRAIN_OWNERSHIP collection is missing")
        footprints = []
        ground_values = set()
        modes = set()
        for obj in sorted(terrain_collection.objects, key=lambda value: value.name):
            if obj.get("sf_role") != "terrain_ownership":
                continue
            values = game_box(obj)
            if min(values["halfX"], values["halfZ"]) <= 0:
                raise RuntimeError(f"{obj.name} has non-positive terrain extents")
            ground_values.add(round(float(obj["sf_ground_y"]), 6))
            modes.add(str(obj["sf_terrain_mode"]))
            footprints.append({
                "id": str(obj["sf_footprint_id"]),
                **values,
                "feather": round(float(obj.get("sf_feather", 0.2)), 6),
                "groundY": round(float(obj["sf_ground_y"]), 6),
            })
        if not footprints or modes != {"flat-ownership"}:
            raise RuntimeError("Terrain ownership must contain at least one flat authority footprint")
        terrain_payload = {
            "mode": "flat-ownership",
            "groundY": min(ground_values),
            "footprints": footprints,
        }

    output_dir = os.path.join(repo, ".data", "authored-sites")
    os.makedirs(output_dir, exist_ok=True)
    output_glb = os.path.join(output_dir, f"{args.site}.glb")

    bpy.ops.object.select_all(action="DESELECT")
    for obj in visual_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.export_scene.gltf(
        filepath=output_glb,
        use_selection=True,
        export_format="GLB",
        export_apply=False,
        export_yup=True,
        export_attributes=True,
        export_extras=True,
        export_materials="EXPORT",
        export_animations=False,
        export_skins=False,
        export_cameras=False,
        export_lights=False,
        export_gpu_instances=True,
    )

    authored_dir = os.path.join(repo, "data", "authored-sites")
    os.makedirs(authored_dir, exist_ok=True)
    output_json = os.path.join(authored_dir, f"{args.site}.json")
    with open(output_json, "w", encoding="utf8") as handle:
        json.dump({
            "schema": 2,
            "id": args.site,
            "label": config["label"],
            "tile": config["tile"],
            "asset": config["asset"],
            "source": config["source"],
            "collection": config["collection"],
            "rootName": config["rootName"],
            "bounds": bounds,
            "arrival": arrival_payload,
            "arrivalDistance": arrival_distance,
            "loadDistance": load_distance,
            "unloadDistance": unload_distance,
            "replaces": config.get("replaces", []),
            "terrain": terrain_payload,
            "colliders": collider_payload,
            "stats": {
                "objects": len(visual_objects),
                "meshes": len(meshes),
                "meshDatablocks": len({obj.data.name for obj in meshes}),
                "colliders": len(collider_payload),
            },
        }, handle, separators=(",", ":"))
    print(json.dumps({"site": args.site, "glb": output_glb, "metadata": output_json,
                      "meshes": len(meshes), "colliders": len(collider_payload)}))


main()
