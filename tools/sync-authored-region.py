"""Seed generic Blender authoring markers without overwriting artist edits."""

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
    path = os.path.join(repo, "data", "authored-regions.json")
    with open(path, "r", encoding="utf8") as handle:
        manifest = json.load(handle)
    if manifest.get("schema") != 1:
        raise RuntimeError("Unsupported authored-region manifest schema")
    region = next((entry for entry in manifest["regions"] if entry["id"] == site), None)
    if not region:
        raise RuntimeError(f"Unknown authored region {site}")
    return region


def ensure_child(parent, name):
    collection = bpy.data.collections.get(name)
    if collection is None:
        collection = bpy.data.collections.new(name)
    if collection.name not in {child.name for child in parent.children}:
        parent.children.link(collection)
    return collection


def seed_box(collection, name, values, role, region_id):
    obj = bpy.data.objects.get(name)
    if obj is not None:
        return obj
    obj = bpy.data.objects.new(name, None)
    collection.objects.link(obj)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 1
    obj.show_name = True
    obj.location = (values["centerX"], -values["centerZ"], values.get("groundY", 0))
    obj.rotation_euler[2] = values.get("yaw", 0)
    obj.scale = (values["halfX"], values["halfZ"], 0.12)
    obj["sf_region"] = region_id
    obj["sf_role"] = role
    return obj


def seed_arrival(collection, values, region_id):
    obj = bpy.data.objects.get("ARRIVAL")
    if obj is not None:
        return obj
    obj = bpy.data.objects.new("ARRIVAL", None)
    collection.objects.link(obj)
    obj.empty_display_type = "CIRCLE"
    obj.empty_display_size = 1.5
    obj.show_name = True
    obj.location = (values["x"], -values["z"], values["y"])
    obj.rotation_euler[2] = values["heading"]
    obj["sf_region"] = region_id
    obj["sf_role"] = "arrival"
    obj["sf_spawn_key"] = values["spawnKey"]
    return obj


def main():
    args = parse_args()
    repo = os.path.realpath(args.repo)
    region = load_region(repo, args.site)
    expected_source = os.path.realpath(os.path.join(repo, region["source"]))
    if os.path.realpath(bpy.data.filepath) != expected_source:
        raise RuntimeError(f"Expected {expected_source}, opened {bpy.data.filepath}")
    root = bpy.data.collections.get(region["collection"])
    if root is None:
        raise RuntimeError(f"Missing root collection {region['collection']}")

    bpy.context.scene["sf_authoring_schema"] = 2
    bpy.context.scene["sf_region"] = args.site
    bpy.context.scene["sf_tile"] = region["tile"]

    guides = ensure_child(root, "AUTHORING")
    guides.hide_render = True
    bounds = seed_box(guides, "REGION_BOUNDS", region["bounds"], "region_bounds", args.site)
    bounds["sf_arrival_distance"] = region["arrivalDistance"]
    bounds["sf_load_distance"] = region["loadDistance"]
    bounds["sf_unload_distance"] = region["unloadDistance"]

    if region.get("arrival"):
        seed_arrival(guides, region["arrival"], args.site)

    terrain = region.get("terrain")
    if terrain:
        terrain_collection = ensure_child(root, "TERRAIN_OWNERSHIP")
        terrain_collection.hide_render = True
        for footprint in terrain["footprints"]:
            ground_y = footprint.get("groundY", terrain["groundY"])
            values = {**footprint, "groundY": ground_y}
            marker = seed_box(
                terrain_collection,
                f"TERRAIN_{footprint['id']}",
                values,
                "terrain_ownership",
                args.site,
            )
            # Existing Blender markers are artist authority. Seed only missing
            # metadata so a bake cannot silently undo hand-tuned entrance cuts.
            if "sf_footprint_id" not in marker:
                marker["sf_footprint_id"] = footprint["id"]
            if "sf_ground_y" not in marker:
                marker["sf_ground_y"] = ground_y
            if "sf_feather" not in marker:
                marker["sf_feather"] = footprint.get("feather", 0.2)
            if "sf_terrain_mode" not in marker:
                marker["sf_terrain_mode"] = terrain["mode"]

    bpy.ops.wm.save_as_mainfile(filepath=expected_source)
    print(json.dumps({"site": args.site, "source": expected_source, "schema": 2}))


main()
