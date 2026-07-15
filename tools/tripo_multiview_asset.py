#!/usr/bin/env python3
"""Submit and immediately download a four-view Tripo model task.

The API key is read only from TRIPO_API_KEY. This tool intentionally never
accepts or persists credentials on the command line or in project files.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
from pathlib import Path
import sys


DEFAULT_HELPER = Path.home() / ".agents/skills/threejs-3d-generator/scripts/threejs_3d_asset.py"


def load_helper(path: Path):
    spec = importlib.util.spec_from_file_location("threejs_3d_asset", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load Tripo helper: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--front", required=True, type=Path)
    parser.add_argument("--left", required=True, type=Path)
    parser.add_argument("--back", required=True, type=Path)
    parser.add_argument("--right", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--helper", type=Path, default=DEFAULT_HELPER)
    parser.add_argument("--face-limit", type=int, default=100_000)
    parser.add_argument("--interval", type=int, default=8)
    parser.add_argument("--timeout", type=int, default=1_800)
    args = parser.parse_args()

    api_key = os.environ.get("TRIPO_API_KEY")
    if not api_key:
        raise RuntimeError("TRIPO_API_KEY is not set")

    tripo = load_helper(args.helper)
    views = [args.front, args.left, args.back, args.right]
    files = []
    for path in views:
        token = tripo.multipart_upload(api_key, path)
        files.append({"type": "png", "file_token": token})

    payload = {
        "type": "multiview_to_model",
        "files": files,
        "model_version": "v3.1-20260211",
        "texture": True,
        "pbr": True,
        "texture_quality": "extreme",
        "geometry_quality": "detailed",
        "texture_alignment": "original_image",
        "orientation": "align_image",
        "face_limit": args.face_limit,
        "auto_size": True,
        "export_uv": True,
        "negative_prompt": (
            "cartoon, chibi, toy, mascot, childish, goofy, rounded simplified anatomy, "
            "blunt beak, oversized eyes, duplicated limbs, fused wing feathers, "
            "featureless plumage, pedestal, background geometry"
        ),
    }
    task_id = tripo.submit_task(api_key, payload)
    task = tripo.wait_for_task(api_key, task_id, args.interval, args.timeout)
    if task.get("status") != "success":
        raise RuntimeError(f"Tripo task {task_id} ended as {task.get('status')}")
    tripo.download_outputs(task, args.out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
