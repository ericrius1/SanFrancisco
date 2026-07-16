"""Validate that the Blender master composition exposes every authored region."""

from __future__ import annotations

import argparse
import json
import os
import sys

import bpy


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--master", required=True)
    values = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return parser.parse_args(values)


def collection_objects_recursive(collection):
    result = set(collection.objects)
    for child in collection.children:
        result.update(collection_objects_recursive(child))
    return result


def main():
    args = parse_args()
    master = os.path.realpath(args.master)
    if os.path.realpath(bpy.data.filepath) != master:
        raise RuntimeError(f"Expected {master}, opened {bpy.data.filepath}")
    with open(os.path.join(args.repo, "data", "authored-regions.json"), "r", encoding="utf8") as handle:
        manifest = json.load(handle)
    expected = {region["id"] for region in manifest["regions"]}
    composed = {
        collection.get("sf_composed_region"): collection
        for collection in bpy.data.collections
        if collection.get("sf_composed_region")
    }
    if set(composed) != expected:
        raise RuntimeError(f"Master authored regions {set(composed)} != {expected}")
    for region_id, collection in composed.items():
        objects = collection_objects_recursive(collection)
        meshes = [obj for obj in objects if obj.type == "MESH"]
        if not meshes:
            raise RuntimeError(f"Master region {region_id} contains no visible meshes")
        bounds = next((obj for obj in objects if obj.get("sf_role") == "region_bounds"), None)
        if not bounds:
            raise RuntimeError(f"Master region {region_id} has no REGION_BOUNDS guide")
        source = next(region for region in manifest["regions"] if region["id"] == region_id)
        if source.get("arrival"):
            arrival = next((obj for obj in objects if obj.get("sf_role") == "arrival"), None)
            if not arrival:
                raise RuntimeError(f"Master region {region_id} has no ARRIVAL guide")
        print(json.dumps({"region": region_id, "meshes": len(meshes), "bounds": bounds.name}))
    print(json.dumps({"master": master, "authoredRegions": sorted(expected)}))


main()
