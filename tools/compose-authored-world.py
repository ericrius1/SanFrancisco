"""Append every authored region into the human-facing Blender master scene."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys

import bpy


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--master", required=True)
    values = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return parser.parse_args(values)


def collection_tree(root):
    result = [root]
    for child in root.children:
        result.extend(collection_tree(child))
    return result


def remove_composed_region(region_id):
    roots = [collection for collection in bpy.data.collections
             if collection.get("sf_composed_region") == region_id]
    for root in roots:
        tree = collection_tree(root)
        objects = {obj for collection in tree for obj in collection.objects}
        for obj in objects:
            bpy.data.objects.remove(obj, do_unlink=True)
        for collection in reversed(tree):
            if collection.name in bpy.data.collections:
                bpy.data.collections.remove(collection)
    if roots:
        bpy.data.orphans_purge(do_recursive=True)


def main():
    args = parse_args()
    repo = os.path.realpath(args.repo)
    master = os.path.realpath(args.master)
    if os.path.realpath(bpy.data.filepath) != master:
        raise RuntimeError(f"Expected {master}, opened {bpy.data.filepath}")
    with open(os.path.join(repo, "data", "authored-regions.json"), "r", encoding="utf8") as handle:
        manifest = json.load(handle)
    if manifest.get("schema") != 1:
        raise RuntimeError("Unsupported authored-region manifest schema")

    backup = master.removesuffix(".blend") + ".before-authored-regions.blend"
    if not os.path.exists(backup):
        shutil.copy2(master, backup)

    composed = []
    for region in manifest["regions"]:
        remove_composed_region(region["id"])
        source = os.path.realpath(os.path.join(repo, region["source"]))
        with bpy.data.libraries.load(source, link=False) as (data_from, data_to):
            if region["collection"] not in data_from.collections:
                raise RuntimeError(f"{source} has no {region['collection']} collection")
            data_to.collections = [region["collection"]]
        root = data_to.collections[0]
        root["sf_composed_region"] = region["id"]
        root["sf_source"] = region["source"]
        bpy.context.scene.collection.children.link(root)
        for item in collection_tree(root):
            if item.name.startswith(("COLLIDERS", "AUTHORING", "TERRAIN_OWNERSHIP")):
                item.hide_viewport = True
                item.hide_render = True
        composed.append(region["id"])

    bpy.context.scene["sf_authored_region_schema"] = 1
    bpy.context.scene["sf_authored_regions"] = json.dumps(composed)
    bpy.ops.wm.save_as_mainfile(filepath=master)
    print(json.dumps({"master": master, "regions": composed, "backup": backup}))


main()
