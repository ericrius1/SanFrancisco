"""Re-author the Sutro Baths pool field in Blender, to the 1896 interior print.

WHAT CHANGED (revision 2 of the pool field)
-------------------------------------------
The v1 field was a plan-view abstraction: one long rectangular plunge on the
west side, a column of six identical baths beside it, and a great deal of dry
tile everywhere else. The period chromolithograph of the hall shows something
quite different, and it is the thing a visitor actually reads on arrival:

  * ONE enormous salt-water tank that is not a rectangle. It runs the whole
    west side of the hall AND opens out into a full-width court across the
    south end, so the water wraps the room in an L and is the first and last
    thing you see. In the print the near half of the frame is nothing but that
    water.
  * The graduated baths banked over to the EAST as a stack of wide, shallow
    tanks separated by narrow catwalks — not the generous 8 m aisles of v1.
    The catwalks are 3.6 m, which is what puts springboards, handrails and
    ladders close enough together to read as one dense bathing machine.
  * A broad cross promenade between the tank stack and the great court: the
    crowded red deck in the print, where everybody stands to watch.

The L is the whole point, so the geometry here is NOT authored per rectangle.
A water body is a LIST of rectangles, and the coping, tiled walls and waterline
band are emitted only along the OUTLINE of their union — the seam where the
court meets the leg carries no coping, so the two rectangles read as one sheet
of water rather than two pools that happen to touch.

MIRRORED CONTRACT
-----------------
`src/world/sutroBaths/layout.ts` holds the same rectangles as `SUTRO_POOLS`,
and this script prints them as `SUTRO_POOL_CONTRACT` on every run. The swim
volume, the walk-surface recovery contract and the visual water sheet are all
driven from that table, so if you retune the field here, copy the printed
rectangles into layout.ts in the same commit or the water will not sit in the
basins that were built for it.

Idempotent: it demolishes the pool field it owns (basins, decks, coping,
railings, ladders, springboards and their colliders) and rebuilds from the
tables below. The tiered diving tower is deliberately NOT touched — it stands
on the mid walkway, which survives the re-authoring unchanged.

    npm run bake:region -- --site sutro-baths     # after running this
"""

from __future__ import annotations

import argparse
import math
import os
import sys

import bpy
from mathutils import Vector, Quaternion


SITE = "sutro-baths"
TILE = "1_12"
CENTER_X = -6125.0
CENTER_Z = 1117.0
YAW = -0.077

# Heights, mirrored from layout.ts SUTRO_BATHS.
DECK_Y = 5.62
WATER_Y = 5.18
BASIN_Y = 2.62
DECK_BOTTOM = 5.26
APRON_TOP = 5.60  # 2 cm under the strips so the overlapping slabs cannot z-fight
BASIN_BOTTOM = 2.32

HALL_HALF_X = 38.7
HALL_HALF_Z = 76.1

# ---------------------------------------------------------------------------
# The field. Rectangles are (minX, maxX, minZ, maxZ) in site-local metres:
# local +x runs inland/east toward the gallery wall, local +z runs south toward
# the entry, so a visitor arriving at the spiral looks up the hall along -z.
# ---------------------------------------------------------------------------

GREAT_LEG = (-31.0, -10.0, -55.0, 22.0)
GREAT_COURT = (-31.0, 19.0, 22.0, 44.0)

BATH_MIN_X = -4.0
BATH_MAX_X = 19.0
# Six tanks on a 12.2 m pitch: 8.6 m of water, 3.6 m of catwalk.
BATH_SPANS = (
    (-55.0, -46.4),
    (-42.8, -34.2),
    (-30.6, -22.0),
    (-18.4, -9.8),
    (-6.2, 2.4),
    (6.0, 14.6),
)
BATH_IDS = ("bath_one", "bath_two", "bath_three", "bath_four", "bath_five", "fresh_plunge")

WATER_BODIES = [
    ("great_plunge", [GREAT_LEG, GREAT_COURT]),
] + [
    (name, [(BATH_MIN_X, BATH_MAX_X, span[0], span[1])])
    for name, span in zip(BATH_IDS, BATH_SPANS)
]

# Dry tile. `apron` slabs sit 2 cm lower than the strips they cross.
DECKS = [
    ("west_promenade", -38.7, -31.0, -HALL_HALF_Z, HALL_HALF_Z, False),
    ("mid_walk", -10.0, -4.0, -HALL_HALF_Z, 22.0, False),
    ("east_promenade", 19.0, 38.7, -HALL_HALF_Z, HALL_HALF_Z, False),
    ("north_apron", -38.7, 38.7, -HALL_HALF_Z, -55.0, True),
    ("south_apron", -38.7, 38.7, 44.0, HALL_HALF_Z, True),
    # The crowded cross promenade of the print, between the tank stack and the
    # great court.
    ("grand_promenade", -4.0, 19.0, 14.6, 22.0, False),
] + [
    (f"bath_walk_{index + 1}", BATH_MIN_X, BATH_MAX_X, BATH_SPANS[index][1], BATH_SPANS[index + 1][0], False)
    for index in range(len(BATH_SPANS) - 1)
]

# Terracotta inlay follows the WIDE promenades only — the red deck the crowd
# stands on in the print. The catwalks between the tanks stay cream tile, as
# they are in the print, and as they have to be: the terracotta is a large-scale
# blotched pattern authored for a 6-to-20 m promenade, and on a 3.6 m catwalk
# two blotches span the whole strip and it reads as camouflage.
INLAY_DECKS = {"west_promenade", "mid_walk", "east_promenade", "grand_promenade"}

# ---- element cross-sections, mirrored from the v1 authoring ----------------
COPING_WIDTH = 0.55
COPING_OFFSET = 0.18   # centre, outward of the pool edge
COPING_TOP = 5.82
COPING_HEIGHT = 0.20

WALL_THICK = 0.30      # inward of the pool edge
WALL_TOP = 5.505
WALL_HEIGHT = 3.21

BAND_THICK = 0.12
BAND_OFFSET = 0.32     # centre, inward of the pool edge
BAND_TOP = 5.08
BAND_HEIGHT = 0.36
BAND_SHRINK = 0.35     # per end, so the bands do not cross at the corners

FLOOR_INSET = 0.25     # under the tiled wall on an outside edge
FLOOR_OVERLAP = 0.05   # past the seam on an edge shared with a sibling rect
FLOOR_TOP = BASIN_Y
FLOOR_HEIGHT = 0.30

LANE_WIDTH = 0.14
LANE_TOP = 2.69
LANE_HEIGHT = 0.08
LANE_PITCH = 4.2
LANE_SHRINK = 1.1      # per end

DECK_HEIGHT = 0.36
INLAY_TOP = 5.67
INLAY_HEIGHT = 0.05
INLAY_SHRINK = 0.3     # per end, along the long axis

RAIL_OFFSET = 0.5      # outward of the pool edge
RAIL_POST_PITCH = 3.6
RAIL_POST_DIAMETER = 0.12
RAIL_POST_HEIGHT = 1.30
RAIL_POST_TOP = 6.92
RAIL_RUN_DIAMETER = 0.09
RAIL_RUN_HEIGHTS = (6.44, 6.89)

LADDER_OFFSET = 0.20   # outward of the pool edge
LADDER_GAUGE = 0.76    # between the two rails
LADDER_RAIL_DIAMETER = 0.12
LADDER_RAIL_HEIGHT = 1.79
LADDER_RAIL_CENTRE = 6.075
LADDER_RUNG_DIAMETER = 0.10
LADDER_RUNG_BASE = 5.13
LADDER_RUNG_STEP = 0.38
LADDER_RUNGS = 5

BOARD_REACH = 2.40     # plank centre, inward of the pool edge
BOARD_LENGTH = 5.60
BOARD_WIDTH = 0.72
BOARD_THICK = 0.22
BOARD_TOP = 6.45

# ---- railings, ladders and springboards ------------------------------------
# ("x", fixed, lo, hi, side) runs ALONG local x at local z == fixed; `side` is
# +1 when the water lies at greater coordinate than the rail, -1 otherwise.
RAIL_EDGES = [
    ("z", -10.0, -55.0, 22.0, -1),    # great plunge, east side of the long leg
    ("x", 22.0, -10.0, 19.0, 1),      # great court, along the cross promenade
    ("z", 19.0, 22.0, 44.0, -1),      # great court, east side
    ("x", 44.0, -31.0, 19.0, -1),     # great court, facing the arrival deck
] + [
    ("x", span[1], BATH_MIN_X, BATH_MAX_X, -1) for span in BATH_SPANS
] + [
    ("z", BATH_MAX_X, span[0], span[1], -1) for span in BATH_SPANS
]

# Ladders and springboards sit on the SAME coping as the handrail, so their
# anchors are picked to fall between posts rather than through one.
LADDERS = [
    ("z", -10.0, z, -1) for z in (-45.0, -23.0, -1.0, 19.0)
] + [
    ("x", 44.0, x, -1) for x in (-24.0, -12.0, 0.0, 12.0)
] + [
    ("x", span[1], 12.0, -1) for span in BATH_SPANS
]

BOARDS = [
    ("z", -10.0, z, -1) for z in (-45.8, -30.5, -13.7, 2.1)
] + [
    ("x", 22.0, x, 1) for x in (2.0, 13.5)
] + [
    ("x", span[1], 9.4, -1) for span in BATH_SPANS
]

QUAT_IDENTITY = Quaternion((1.0, 0.0, 0.0, 0.0))
# A unit cylinder stands along its own +Z, so a run laid along local z is turned
# a quarter turn about X, and one laid along local x a quarter turn about Y.
QUAT_ALONG_Z = Quaternion((math.sqrt(0.5), math.sqrt(0.5), 0.0, 0.0))
QUAT_ALONG_X = Quaternion((math.sqrt(0.5), 0.0, math.sqrt(0.5), 0.0))


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    values = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return parser.parse_args(values)


def local_to_blender(x: float, z: float, y: float) -> Vector:
    """Absolute Blender coordinates — colliders are unparented world empties."""
    c = math.cos(YAW)
    s = math.sin(YAW)
    return Vector((CENTER_X + c * x + s * z, -(CENTER_Z - s * x + c * z), y))


def child_local(x: float, z: float, y: float) -> Vector:
    """Coordinates for a child of the architecture root, which already carries
    the site's centre and yaw. Blender +y runs north, so local z flips."""
    return Vector((x, -z, y))


def mark_visual(obj):
    obj["sf_site"] = SITE
    obj["sf_tile"] = TILE
    obj["sf_role"] = "visual"


def delete_children(root):
    if root is None:
        return 0
    stack = list(root.children)
    doomed = []
    while stack:
        child = stack.pop()
        stack.extend(list(child.children))
        doomed.append(child)
    for obj in reversed(doomed):
        bpy.data.objects.remove(obj, do_unlink=True)
    return len(doomed)


def visual_empty(collection, name, parent):
    existing = bpy.data.objects.get(name)
    if existing is not None:
        return existing
    obj = bpy.data.objects.new(name, None)
    collection.objects.link(obj)
    obj.parent = parent
    mark_visual(obj)
    return obj


def place(collection, parent, name, mesh, x, z, centre_y, scale, quat=QUAT_IDENTITY):
    """One primitive instance, positioned by its CENTRE in site-local metres.

    Every pool datablock is a unit primitive spanning -0.5..0.5, so `scale` is
    the finished size rather than a half extent — do not "helpfully" halve it.
    A rod's scale is (diameter, diameter, length) in its OWN frame, which is why
    the length always lands on the third component whichever way `quat` lays it.
    """
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.parent = parent
    obj.location = child_local(x, z, centre_y)
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = quat
    obj.scale = scale
    mark_visual(obj)
    return obj


def add_collider(collection, name, min_x, max_x, min_z, max_z, top, bottom):
    obj = bpy.data.objects.new(name, None)
    collection.objects.link(obj)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 1.0
    obj.location = local_to_blender((min_x + max_x) * 0.5, (min_z + max_z) * 0.5, (top + bottom) * 0.5)
    obj.rotation_euler[2] = YAW
    hx = (max_x - min_x) * 0.5
    hz = (max_z - min_z) * 0.5
    hy = (top - bottom) * 0.5
    if min(hx, hz, hy) <= 0:
        raise RuntimeError(f"Collider {name} is degenerate")
    obj.scale = (hx, hz, hy)
    obj["sf_site"] = SITE
    obj["sf_tile"] = TILE
    obj["sf_role"] = "collider"
    obj["sf_half_extents"] = [hx, hy, hz]
    return obj


# ---------------------------------------------------------------------------
# Outline of a union of axis-aligned rectangles
# ---------------------------------------------------------------------------

EPS = 1e-6
SIDES = ("minX", "maxX", "minZ", "maxZ")


def subtract_spans(span, blockers):
    segments = [span]
    for blocker in blockers:
        remaining = []
        for lo, hi in segments:
            cut_lo = max(lo, blocker[0])
            cut_hi = min(hi, blocker[1])
            if cut_hi <= cut_lo + EPS:
                remaining.append((lo, hi))
                continue
            if lo < cut_lo - EPS:
                remaining.append((lo, cut_lo))
            if cut_hi < hi - EPS:
                remaining.append((cut_hi, hi))
        segments = remaining
    return [seg for seg in segments if seg[1] - seg[0] > EPS]


def side_plane(rect, side):
    return {"minX": rect[0], "maxX": rect[1], "minZ": rect[2], "maxZ": rect[3]}[side]


def outward(side):
    """Sign of the direction that leads OUT of the pool across this side."""
    return -1.0 if side in ("minX", "minZ") else 1.0


def external_segments(rect, siblings, side):
    """The parts of one side of `rect` that face dry deck rather than a sibling
    rectangle of the same water body. This is what makes the L read as one
    sheet: the seam where the court meets the leg yields no segments at all."""
    facing = {"minX": "maxX", "maxX": "minX", "minZ": "maxZ", "maxZ": "minZ"}[side]
    plane = side_plane(rect, side)
    span = (rect[2], rect[3]) if side in ("minX", "maxX") else (rect[0], rect[1])
    blockers = []
    for other in siblings:
        if other is rect:
            continue
        if abs(side_plane(other, facing) - plane) > EPS:
            continue
        blockers.append((other[2], other[3]) if side in ("minX", "maxX") else (other[0], other[1]))
    return subtract_spans(span, blockers)


def fully_internal(rect, siblings, side):
    return not external_segments(rect, siblings, side)


def touches_sibling(rect, siblings, side):
    """True when ANY of this side abuts a sibling rectangle.

    The distinction from `fully_internal` matters exactly once, and it is the
    seam that defines the L: the court's north side is part sibling (the leg)
    and part open deck. Insetting the whole side to the tiled wall — the right
    answer for an outside edge — left a 20 cm slot straight through the basin
    floor at the join, visible from underwater as a gap in the tank."""
    span = (rect[2], rect[3]) if side in ("minX", "maxX") else (rect[0], rect[1])
    covered = sum(hi - lo for lo, hi in external_segments(rect, siblings, side))
    return covered < (span[1] - span[0]) - EPS


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

def build_pool_field(visual, colliders, materials, meshes):
    basin_root = visual_empty(visual, "sutro_baths_seven_pool_basin_and_decks", materials["arch_root"])
    rig_root = visual_empty(visual, "sutro_baths_pool_railings_ladders_and_diving", materials["arch_root"])

    groups = {
        "floor": visual_empty(visual, "sutro_baths_pool_bottom_tiles", basin_root),
        "wall": visual_empty(visual, "sutro_baths_pool_tiled_walls", basin_root),
        "band": visual_empty(visual, "sutro_baths_pool_waterline_bands", basin_root),
        "coping": visual_empty(visual, "sutro_baths_cream_tile_coping", basin_root),
        "lane": visual_empty(visual, "sutro_baths_underwater_lane_inlays", basin_root),
        "deck": visual_empty(visual, "sutro_baths_dry_promenoir_decks", basin_root),
        "inlay": visual_empty(visual, "sutro_baths_terracotta_promenoir_inlay", basin_root),
        "rail_post": visual_empty(visual, "sutro_baths_white_guardrail_posts", rig_root),
        "rail_run": visual_empty(visual, "sutro_baths_white_guardrail_runs", rig_root),
        "ladder_rail": visual_empty(visual, "sutro_baths_brass_ladder_rails", rig_root),
        "ladder_rung": visual_empty(visual, "sutro_baths_brass_ladder_rungs", rig_root),
        "board": visual_empty(visual, "sutro_baths_spring_diving_boards", rig_root),
    }
    counts = {key: 0 for key in groups}

    def box(kind, x, z, top, size_x, size_z, height):
        """An axis-aligned slab, placed by its UPPER face."""
        counts[kind] += 1
        return place(visual, groups[kind], f"{kind}_{counts[kind]:03d}", meshes[kind],
                     x, z, top - height * 0.5, (size_x, size_z, height))

    def rod(kind, x, z, centre_y, diameter, length, quat=QUAT_IDENTITY):
        """A post or a rail, placed by its centre — a laid-down rod has no
        meaningful `top`, and pretending otherwise is what buries it in the deck."""
        counts[kind] += 1
        return place(visual, groups[kind], f"{kind}_{counts[kind]:03d}", meshes[kind],
                     x, z, centre_y, (diameter, diameter, length), quat)

    collider_count = 0

    def emit_collider(tag, min_x, max_x, min_z, max_z, top, bottom):
        nonlocal collider_count
        collider_count += 1
        add_collider(colliders, f"sutro_collider_pool_{collider_count:03d}_{tag}",
                     min_x, max_x, min_z, max_z, top, bottom)

    # ---- basins ------------------------------------------------------------
    for body_name, rects in WATER_BODIES:
        for index, rect in enumerate(rects):
            min_x, max_x, min_z, max_z = rect

            # Floor: tucked under the tiled wall on an outside edge, run a hair
            # past the seam where it meets a sibling so the basin has no slot.
            def floor_edge(side, value, _rect=rect, _rects=rects):
                if touches_sibling(_rect, _rects, side):
                    return value + outward(side) * FLOOR_OVERLAP
                return value - outward(side) * FLOOR_INSET

            f_min_x = floor_edge("minX", min_x)
            f_max_x = floor_edge("maxX", max_x)
            f_min_z = floor_edge("minZ", min_z)
            f_max_z = floor_edge("maxZ", max_z)
            box("floor", (f_min_x + f_max_x) * 0.5, (f_min_z + f_max_z) * 0.5, FLOOR_TOP,
                f_max_x - f_min_x, f_max_z - f_min_z, FLOOR_HEIGHT)

            # Lane lines run the length of the tank, spaced across its width.
            width_x = max_x - min_x
            width_z = max_z - min_z
            if width_z >= width_x:
                for k in range(int((width_x - 1.0) / LANE_PITCH)):
                    box("lane", min_x + LANE_PITCH * (k + 1), (min_z + max_z) * 0.5, LANE_TOP,
                        LANE_WIDTH, width_z - LANE_SHRINK * 2, LANE_HEIGHT)
            else:
                for k in range(int((width_z - 1.0) / LANE_PITCH)):
                    box("lane", (min_x + max_x) * 0.5, min_z + LANE_PITCH * (k + 1), LANE_TOP,
                        width_x - LANE_SHRINK * 2, LANE_WIDTH, LANE_HEIGHT)

            # Coping, tiled wall and waterline band, along the OUTLINE only.
            for side in SIDES:
                plane = side_plane(rect, side)
                sign = outward(side)
                for lo, hi in external_segments(rect, rects, side):
                    length = hi - lo
                    centre = (lo + hi) * 0.5
                    # Walls and copings run half a thickness past each end so
                    # they mitre at the corners instead of leaving a notch.
                    wall_pos = plane - sign * WALL_THICK * 0.5
                    band_pos = plane - sign * BAND_OFFSET
                    cope_pos = plane + sign * COPING_OFFSET
                    banded = length > BAND_SHRINK * 2 + 0.2
                    if side in ("minX", "maxX"):
                        box("wall", wall_pos, centre, WALL_TOP,
                            WALL_THICK, length + WALL_THICK, WALL_HEIGHT)
                        box("coping", cope_pos, centre, COPING_TOP,
                            COPING_WIDTH, length + COPING_WIDTH, COPING_HEIGHT)
                        if banded:
                            box("band", band_pos, centre, BAND_TOP,
                                BAND_THICK, length - BAND_SHRINK * 2, BAND_HEIGHT)
                    else:
                        box("wall", centre, wall_pos, WALL_TOP,
                            length + WALL_THICK, WALL_THICK, WALL_HEIGHT)
                        box("coping", centre, cope_pos, COPING_TOP,
                            length + COPING_WIDTH, COPING_WIDTH, COPING_HEIGHT)
                        if banded:
                            box("band", centre, band_pos, BAND_TOP,
                                length - BAND_SHRINK * 2, BAND_THICK, BAND_HEIGHT)

            # The swimmable floor, inset to the tiled wall's inner face but run
            # straight through a seam so the L has one continuous basin.
            def basin_edge(side, value, _rect=rect, _rects=rects):
                if touches_sibling(_rect, _rects, side):
                    return value
                return value - outward(side) * (FLOOR_INSET + 0.05)

            emit_collider(
                f"basin_{body_name}_{index}",
                basin_edge("minX", min_x), basin_edge("maxX", max_x),
                basin_edge("minZ", min_z), basin_edge("maxZ", max_z),
                BASIN_Y, BASIN_Y - 0.4
            )

    # ---- dry tile ----------------------------------------------------------
    for name, min_x, max_x, min_z, max_z, is_apron in DECKS:
        top = APRON_TOP if is_apron else DECK_Y
        box("deck", (min_x + max_x) * 0.5, (min_z + max_z) * 0.5, top,
            max_x - min_x, max_z - min_z, top - DECK_BOTTOM)
        emit_collider(f"deck_{name}", min_x, max_x, min_z, max_z, top, DECK_BOTTOM)
        if name in INLAY_DECKS:
            width = max_x - min_x
            depth = max_z - min_z
            shrink_x = INLAY_SHRINK if width >= depth else 0.0
            shrink_z = INLAY_SHRINK if depth > width else 0.0
            box("inlay", (min_x + max_x) * 0.5, (min_z + max_z) * 0.5, INLAY_TOP,
                width - shrink_x * 2, depth - shrink_z * 2, INLAY_HEIGHT)

    # ---- railings ----------------------------------------------------------
    for axis, fixed, lo, hi, side in RAIL_EDGES:
        offset = fixed - side * RAIL_OFFSET
        length = hi - lo
        centre = (lo + hi) * 0.5
        lay = QUAT_ALONG_X if axis == "x" else QUAT_ALONG_Z
        for height in RAIL_RUN_HEIGHTS:
            at = (centre, offset) if axis == "x" else (offset, centre)
            rod("rail_run", at[0], at[1], height, RAIL_RUN_DIAMETER, length, lay)
        posts = max(2, int(round(length / RAIL_POST_PITCH)) + 1)
        for index in range(posts):
            along = lo + length * index / (posts - 1)
            at = (along, offset) if axis == "x" else (offset, along)
            rod("rail_post", at[0], at[1], RAIL_POST_TOP - RAIL_POST_HEIGHT * 0.5,
                RAIL_POST_DIAMETER, RAIL_POST_HEIGHT)

    # ---- ladders -----------------------------------------------------------
    for axis, fixed, along, side in LADDERS:
        offset = fixed - side * LADDER_OFFSET
        lay = QUAT_ALONG_X if axis == "x" else QUAT_ALONG_Z
        for rail in (-LADDER_GAUGE * 0.5, LADDER_GAUGE * 0.5):
            at = (along + rail, offset) if axis == "x" else (offset, along + rail)
            rod("ladder_rail", at[0], at[1], LADDER_RAIL_CENTRE,
                LADDER_RAIL_DIAMETER, LADDER_RAIL_HEIGHT)
        # Rungs hang a shade nearer the water than the rails they bridge.
        rung_offset = offset + 0.03 * side
        for rung in range(LADDER_RUNGS):
            y = LADDER_RUNG_BASE + LADDER_RUNG_STEP * rung
            at = (along, rung_offset) if axis == "x" else (rung_offset, along)
            rod("ladder_rung", at[0], at[1], y, LADDER_RUNG_DIAMETER, LADDER_GAUGE + 0.08, lay)

    # ---- springboards ------------------------------------------------------
    for axis, fixed, along, side in BOARDS:
        plank = fixed + side * BOARD_REACH
        support = fixed - side * 0.45
        post = fixed + side * 0.35
        if axis == "x":
            box("board", along, plank, BOARD_TOP, BOARD_WIDTH, BOARD_LENGTH, BOARD_THICK)
            box("board", along, support, 6.32, 1.20, 0.24, 0.70)
            box("board", along, post, 6.51, 0.20, 0.20, 0.90)
        else:
            box("board", plank, along, BOARD_TOP, BOARD_LENGTH, BOARD_WIDTH, BOARD_THICK)
            box("board", support, along, 6.32, 0.24, 1.20, 0.70)
            box("board", post, along, 6.51, 0.20, 0.20, 0.90)

    return counts, collider_count


def main():
    args = parse_args()
    repo = os.path.realpath(args.repo)
    expected = os.path.realpath(os.path.join(repo, "assets-src/world/sites/sutro-baths.blend"))
    if os.path.realpath(bpy.data.filepath) != expected:
        raise RuntimeError(f"Expected {expected}, opened {bpy.data.filepath}")

    visual = bpy.data.collections.get("VISUAL")
    colliders = bpy.data.collections.get("COLLIDERS")
    if visual is None or colliders is None:
        raise RuntimeError("Sutro authoring collections are incomplete")

    arch_root = bpy.data.objects.get("sutro_baths_restored_architecture")
    if arch_root is None:
        raise RuntimeError("The architecture root is missing")

    # Reuse the v1 datablocks so the field re-instances the hall's existing
    # primitives instead of adding new ones to the export.
    mesh_for = {
        "floor": "Mesh_0", "wall": "Mesh_1", "band": "Mesh_2", "coping": "Mesh_3",
        "lane": "Mesh_4", "deck": "Mesh_5", "inlay": "Mesh_6",
        "rail_post": "Mesh_15", "rail_run": "Mesh_16",
        "ladder_rail": "Mesh_17", "ladder_rung": "Mesh_18", "board": "Mesh_19",
    }
    meshes = {}
    for key, name in mesh_for.items():
        datablock = bpy.data.meshes.get(name)
        if datablock is None:
            raise RuntimeError(f"Pool datablock {name} ({key}) is missing from the .blend")
        # Nothing references it between the demolition and the rebuild below.
        datablock.use_fake_user = True
        meshes[key] = datablock

    basin_root = bpy.data.objects.get("sutro_baths_seven_pool_basin_and_decks")
    rig_root = bpy.data.objects.get("sutro_baths_pool_railings_ladders_and_diving")
    # The tiered diving tower stands on the mid walkway, which the re-authoring
    # leaves alone — detach it so the demolition below cannot take it with it.
    tower = bpy.data.objects.get("sutro_baths_tiered_diving_tower")
    if tower is not None:
        tower.parent = None

    removed = 0
    for group in list(basin_root.children if basin_root else []) + list(rig_root.children if rig_root else []):
        removed += delete_children(group) + 1
        bpy.data.objects.remove(group, do_unlink=True)

    old_colliders = [
        obj for obj in list(colliders.objects)
        if obj.name.startswith("sutro_collider_pool_")
        or (obj.name.startswith("sutro_collider_") and obj.name[len("sutro_collider_"):].isdigit()
            and int(obj.name[len("sutro_collider_"):]) <= 17)
    ]
    for obj in old_colliders:
        bpy.data.objects.remove(obj, do_unlink=True)

    counts, collider_count = build_pool_field(
        visual, colliders, {"arch_root": arch_root}, meshes
    )

    if tower is not None:
        tower.parent = bpy.data.objects.get("sutro_baths_pool_railings_ladders_and_diving")
    for datablock in meshes.values():
        datablock.use_fake_user = False

    bpy.context.scene["sf_sutro_pool_field_revision"] = 2
    bpy.context.scene["sf_sutro_pool_field"] = "l-shaped-great-plunge-east-tank-stack"
    bpy.context.view_layer.update()
    bpy.ops.wm.save_as_mainfile(filepath=expected)

    contract = {
        "great-plunge": [GREAT_LEG, GREAT_COURT],
        **{name: [(BATH_MIN_X, BATH_MAX_X, span[0], span[1])]
           for name, span in zip(BATH_IDS, BATH_SPANS)},
    }
    print("SUTRO_POOL_CONTRACT " + repr(contract))
    print({
        "source": expected,
        "removed_objects": removed,
        "removed_colliders": len(old_colliders),
        "built": counts,
        "colliders": collider_count,
        "visual_objects": len(visual.objects),
        "total_colliders": len(colliders.objects),
    })


main()
