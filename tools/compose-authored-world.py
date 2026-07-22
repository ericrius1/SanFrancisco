"""Compose every available authored region into the Blender master scene.

Normal sources are appended for historical compatibility. Regions declaring
``composition: link`` stay live-linked to their independent .blend project.
Git-LFS pointer stubs are skipped without disturbing an already composed copy.
"""

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


def unlink_collection_everywhere(collection):
    for scene in bpy.data.scenes:
        if collection.name in {child.name for child in scene.collection.children}:
            scene.collection.children.unlink(collection)
    for parent in bpy.data.collections:
        if collection.name in {child.name for child in parent.children}:
            parent.children.unlink(collection)


def remove_composed_region(region_id):
    roots = [collection for collection in bpy.data.collections
             if collection.get("sf_composed_region") == region_id]
    for root in roots:
        if root.get("sf_composition_mode") == "link":
            unlink_collection_everywhere(root)
            bpy.data.collections.remove(root)
            continue
        tree = collection_tree(root)
        objects = {obj for collection in tree for obj in collection.objects}
        for obj in objects:
            bpy.data.objects.remove(obj, do_unlink=True)
        for collection in reversed(tree):
            if collection.name in bpy.data.collections:
                bpy.data.collections.remove(collection)
    if roots:
        bpy.data.orphans_purge(do_recursive=True)


def is_lfs_pointer(path):
    if not os.path.isfile(path) or os.path.getsize(path) > 1024:
        return False
    with open(path, "rb") as handle:
        return handle.read(80).startswith(b"version https://git-lfs.github.com/spec/v1")


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
        source = os.path.realpath(os.path.join(repo, region["source"]))
        if is_lfs_pointer(source):
            existing = next(
                (collection for collection in bpy.data.collections
                 if collection.get("sf_composed_region") == region["id"]),
                None,
            )
            if existing is not None:
                composed.append(region["id"])
                print(f"[authored-world] preserving {region['id']}; source is an LFS pointer")
            else:
                print(f"[authored-world] skipping {region['id']}; source is an LFS pointer")
            continue
        remove_composed_region(region["id"])
        linked = region.get("composition") == "link"
        with bpy.data.libraries.load(source, link=linked) as (data_from, data_to):
            if region["collection"] not in data_from.collections:
                raise RuntimeError(f"{source} has no {region['collection']} collection")
            data_to.collections = [region["collection"]]
        source_root = data_to.collections[0]
        if linked:
            root = bpy.data.collections.new(f"AUTHORED_{region['id'].replace('-', '_')}_LINK")
            root.children.link(source_root)
            root["sf_composition_mode"] = "link"
        else:
            root = source_root
            root["sf_composition_mode"] = "append"
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
