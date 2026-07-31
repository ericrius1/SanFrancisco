"""Build the independently editable St Mary's Cathedral authored Blender project.

Cathedral of Saint Mary of the Assumption (1971, Belluschi / Nervi / McSweeney,
Ryan & Lee) at Geary & Gough on Cathedral Hill. Authored at real-world scale
and world placement like the other authored regions:

  podium   255 ft (77.7 m) square, glass curtain walls behind travertine piers
  cupola   190 ft (57.9 m) to the shell summit — eight hyperbolic-paraboloid
           segments sweeping from a square base to a Greek cross at the top
  glass    narrow stained-glass strips rise from the four compass points and
           cross at the summit; a clear clerestory band floats the shell
  cross    55 ft (16.8 m) golden cross

The saddle shells are generated as explicit outer + inner surfaces (the export
pipeline does not apply modifiers), so the .blend stays directly editable.
Textures are deterministic numpy bakes written into the site's textures/ dir.
"""

from __future__ import annotations

import argparse
import math
import os
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector


SITE_ID = "st-marys"
TILE = "11_11"
CENTER_X = 1642.02
CENTER_Z = 661.16
YAW = 0.152
# Cathedral Hill terrain reads 58.1 m at the site centre and slopes from ~62.8
# on the Geary (north) side down to ~56 on the south. The plaza datum sits just
# under the north sidewalk; the SKIRT below carries the podium down to grade on
# the low sides, exactly like the real building's garage wall.
FLOOR = 61.2
SKIRT_BOTTOM = -16.0         # local z: below every nearby terrain sample

# --- primary dimensions (meters, local frame: x east, y north, z above plaza)
PODIUM_HALF = 38.85          # 255 ft square podium
GLASS_HALF = 35.65           # curtain wall inset behind the roof overhang
PLAZA_TOP = 1.35             # raised plaza platform
FLOOR_Z = 1.5                # nave floor
GLASS_TOP = 9.0              # curtain wall head
BAND_TOP = 10.9              # travertine mezzanine band under the roof slab
ROOF_TOP = 12.4              # top of the wide fascia roof deck
CUPOLA_HALF = 20.6           # cupola base square half-width (pylon square)
SHELL_Z0 = 13.0              # shell corner springing, just above the roof ring
SHELL_SEAM_Z0 = 24.0         # face-midpoint springing: the great pointed arches
SHELL_TOP = 59.4             # 190 ft summit over the nave floor (floor at 1.5)
ARM_TIP_Z = 58.7             # ridge arm tips sit just below the summit crest
ARM_HALF = 8.2               # Greek-cross arm reach at the top
GLASS_HW = 0.92              # stained-glass strip half width (1.83 m bands)
SHELL_T = 0.55               # shell thickness (outer to coffered inner surface)
CROSS_H = 16.8               # 55 ft golden cross
SEG_T = 56                   # shell rows
SEG_U = 14                   # shell columns per half-face


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    values = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return parser.parse_args(values)


def clean_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in list(bpy.data.collections):
        bpy.data.collections.remove(collection)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.cameras, bpy.data.lights, bpy.data.images):
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)


def collection(parent, name, hidden=False):
    result = bpy.data.collections.new(name)
    parent.children.link(result)
    result.hide_render = hidden
    result.hide_viewport = False
    return result


def move_to(obj, target):
    for source in list(obj.users_collection):
        source.objects.unlink(obj)
    target.objects.link(obj)


def tag(obj):
    obj["sf_site"] = SITE_ID
    obj["sf_tile"] = TILE
    return obj


# ----------------------------------------------------------------------------
# Deterministic texture bakes
# ----------------------------------------------------------------------------

def write_image(path, name, rgba):
    height, width = rgba.shape[:2]
    img = bpy.data.images.new(name, width=width, height=height, alpha=False)
    img.pixels.foreach_set(rgba.astype(np.float32).ravel())
    img.filepath_raw = str(path)
    img.file_format = "PNG"
    img.save()
    return img


def travertine_pixels():
    """Roman travertine with the precast panel grid of the cupola cladding."""
    rng = np.random.default_rng(7)
    size = 512
    img = np.ones((size, size, 4), dtype=np.float32)
    img[..., :3] = np.array([0.862, 0.842, 0.796])
    yy = np.arange(size)[:, None] / size
    banding = 0.013 * np.sin(yy * math.pi * 22.0 + 1.7) + 0.009 * np.sin(yy * math.pi * 57.0 + 4.1)
    img[..., :3] += banding[..., None]
    img[..., :3] += rng.normal(0.0, 0.012, (size, size, 1))
    seam = np.zeros((size, size), dtype=bool)
    for k in range(0, size, 64):
        seam[:, k : k + 2] = True
        seam[k : k + 2, :] = True
    img[seam, :3] *= 0.86
    img[..., :3] = np.clip(img[..., :3], 0.0, 1.0)
    img[..., 3] = 1.0
    return img


def coffer_pixels():
    """Precast concrete for the coffered vault. The coffers themselves are real
    geometry now, so this is only the surface: the warm olive-khaki cast stone
    the reference photographs read as, with faint per-panel tonal variation."""
    rng = np.random.default_rng(19)
    size = 512
    img = np.ones((size, size, 4), dtype=np.float32)
    img[..., :3] = np.array([0.505, 0.486, 0.410])
    x = np.arange(size)[None, :]
    y = np.arange(size)[:, None]
    panel = ((x // 48) * 733 + (y // 48) * 419) % 11
    img[..., :3] *= (0.94 + panel[..., None] * 0.011)
    img[..., :3] += rng.normal(0.0, 0.010, (size, size, 1))
    img[..., :3] = np.clip(img[..., :3], 0.0, 1.0)
    img[..., 3] = 1.0
    return img


def brick_pixels():
    """Warm mission-brick nave floor with narrow pale mortar and running-bond
    offsets. The real interior is visually anchored by this dark red field."""
    rng = np.random.default_rng(41)
    width, height = 512, 512
    img = np.ones((height, width, 4), dtype=np.float32)
    mortar = np.array([0.34, 0.27, 0.22])
    palette = np.array([
        [0.34, 0.135, 0.075],
        [0.41, 0.175, 0.105],
        [0.47, 0.205, 0.125],
        [0.30, 0.105, 0.060],
    ])
    img[..., :3] = mortar
    brick_h, brick_w, joint = 24, 78, 3
    for row, y0 in enumerate(range(0, height, brick_h)):
        offset = -(brick_w // 2) if row % 2 else 0
        for x0 in range(offset, width, brick_w):
            xa, xb = max(0, x0 + joint), min(width, x0 + brick_w - joint)
            ya, yb = y0 + joint, min(height, y0 + brick_h - joint)
            if xa >= xb or ya >= yb:
                continue
            color = palette[(row * 7 + x0 // brick_w) % len(palette)].copy()
            color *= 0.91 + 0.16 * rng.random()
            img[ya:yb, xa:xb, :3] = color
            img[ya:yb, xa:xb, :3] += rng.normal(0.0, 0.012, (yb - ya, xb - xa, 1))
    img[..., :3] = np.clip(img[..., :3], 0.0, 1.0)
    img[..., 3] = 1.0
    return img


# The four window lines carry the four elements — green earth, red fire, blue
# water, gold air — rising to meet in one prismatic cross at the apex.
# Keyed by shell quarter: 0 = +x east, 1 = +y north, 2 = -x west, 3 = -y south.
GLASS_ELEMENTS = {
    0: ("air", [[0.30, 0.19, 0.05], [0.60, 0.42, 0.10], [0.86, 0.66, 0.16], [0.95, 0.83, 0.40]]),
    1: ("earth", [[0.05, 0.15, 0.07], [0.09, 0.32, 0.13], [0.17, 0.54, 0.23], [0.52, 0.79, 0.42]]),
    2: ("fire", [[0.28, 0.05, 0.04], [0.54, 0.10, 0.06], [0.80, 0.22, 0.08], [0.95, 0.48, 0.15]]),
    3: ("water", [[0.04, 0.08, 0.23], [0.07, 0.18, 0.44], [0.12, 0.34, 0.66], [0.38, 0.63, 0.87]]),
}
GLASS_APEX = np.array([0.82, 0.80, 0.95])


def stained_glass_pixels(stops_list, seed):
    """One dalle-de-verre element band: dark at the base, brilliant at the top,
    dissolving into the shared prismatic apex white."""
    width, height = 128, 1024
    rng = np.random.default_rng(seed)
    img = np.ones((height, width, 4), dtype=np.float32)
    yy = np.arange(height)[:, None] / height
    stops = np.array(stops_list)
    seg = (yy[:, 0] * (len(stops) - 1))
    idx = np.clip(seg.astype(int), 0, len(stops) - 2)
    frac = (seg - idx)[:, None]
    cols = stops[idx] * (1 - frac) + stops[idx + 1] * frac
    apex = np.clip((yy[:, 0] - 0.90) / 0.10, 0.0, 1.0)[:, None]
    cols = cols * (1 - apex) + GLASS_APEX[None, :] * apex
    img[..., :3] = cols[:, None, :]
    img[..., :3] += rng.normal(0.0, 0.02, (height, width, 1))
    for k in range(0, height, 26):
        img[k : k + 2, :, :3] *= 0.24
    for k in (0, 41, 84, 126):
        img[:, k : k + 2, :3] *= 0.24
    img[..., :3] = np.clip(img[..., :3], 0.0, 1.0)
    img[..., 3] = 1.0
    return img


def chapel_window_pixels():
    """The dense faceted-glass wall of the side chapel: hot reds and ambers
    shot through with cobalt, leaded into small irregular cells."""
    rng = np.random.default_rng(29)
    size = 512
    img = np.ones((size, size, 4), dtype=np.float32)
    cell = 16
    palette = np.array([
        [0.86, 0.16, 0.07], [0.95, 0.44, 0.09], [0.97, 0.74, 0.18],
        [0.62, 0.09, 0.11], [0.12, 0.28, 0.68], [0.08, 0.45, 0.55],
        [0.75, 0.62, 0.14], [0.35, 0.06, 0.16],
    ])
    weights = np.array([0.2, 0.18, 0.16, 0.14, 0.12, 0.08, 0.08, 0.04])
    tiles = rng.choice(len(palette), size=(size // cell, size // cell), p=weights)
    img[..., :3] = np.repeat(np.repeat(palette[tiles], cell, axis=0), cell, axis=1)
    img[..., :3] *= (0.78 + rng.random((size // cell, size // cell, 1)).repeat(cell, 0).repeat(cell, 1) * 0.44)
    lead = (np.arange(size) % cell) < 2
    img[lead, :, :3] *= 0.18
    img[:, lead, :3] *= 0.18
    img[..., :3] = np.clip(img[..., :3], 0.0, 1.0)
    img[..., 3] = 1.0
    return img


def material(name, base, roughness=0.65, metallic=0.0, emission=None, emission_strength=0.0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*base, 1.0)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*base, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


def textured_material(name, image, roughness=0.8, metallic=0.0, emission_strength=0.0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (0.8, 0.8, 0.78, 1.0)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = image
    tex.image.colorspace_settings.name = "sRGB"
    mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    if emission_strength > 0:
        mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


# ----------------------------------------------------------------------------
# Mesh helpers (explicit geometry: the exporter does not apply modifiers)
# ----------------------------------------------------------------------------

def mesh_object(target, root, name, verts, faces, mat, uvs=None, smooth=False):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    mesh.update()
    if smooth:
        for polygon in mesh.polygons:
            polygon.use_smooth = True
    if uvs is not None:
        layer = mesh.uv_layers.new(name="UVMap")
        for polygon in mesh.polygons:
            for loop_index in polygon.loop_indices:
                layer.data[loop_index].uv = uvs(mesh.loops[loop_index].vertex_index, verts)
    obj = bpy.data.objects.new(name, mesh)
    target.objects.link(obj)
    obj.parent = root
    obj.data.materials.append(mat)
    return tag(obj)


def add_box(target, root, name, center, half, mat, taper=1.0, yaw=0.0,
            uv_scale=None, uv_axis="vertical"):
    cx, cy, cz = center
    hx, hy, hz = half
    verts = []
    for z_sign, spread in ((-1, 1.0), (1, taper)):
        for dx, dy in ((-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)):
            x, y = dx * spread, dy * spread
            if yaw:
                c, s = math.cos(yaw), math.sin(yaw)
                x, y = x * c - y * s, x * s + y * c
            verts.append((cx + x, cy + y, cz + z_sign * hz))
    faces = [(3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    uvs = None
    if uv_scale:
        def uvs(vertex_index, vs, scale=uv_scale, axis=uv_axis):
            x, y, z = vs[vertex_index]
            if axis == "floor":
                return (x / scale, y / scale)
            return ((x + y) / scale, z / scale)
    return mesh_object(target, root, name, verts, faces, mat, uvs=uvs)


def add_prism(target, root, name, center, radius, half_height, sides, mat, rotation=0.0):
    """Explicit capped prism used for the octagonal font and faceted sanctuary."""
    cx, cy, cz = center
    rx, ry = radius if isinstance(radius, tuple) else (radius, radius)
    verts = []
    for z in (cz - half_height, cz + half_height):
        for i in range(sides):
            angle = rotation + i * math.tau / sides
            verts.append((cx + math.cos(angle) * rx, cy + math.sin(angle) * ry, z))
    faces = [tuple(range(sides - 1, -1, -1)), tuple(range(sides, sides * 2))]
    for i in range(sides):
        n = (i + 1) % sides
        faces.append((i, n, sides + n, sides + i))
    return mesh_object(target, root, name, verts, faces, mat)


def add_cylinder(target, root, name, center, radius, half_height, mat, sides=12):
    return add_prism(target, root, name, center, radius, half_height, sides, mat)


def add_vertical_disc(target, root, name, center, radius, half_depth, mat, sides=24):
    """Thin round relief in the XZ plane, facing along local +Y."""
    cx, cy, cz = center
    verts = []
    for y in (cy - half_depth, cy + half_depth):
        for i in range(sides):
            angle = i * math.tau / sides
            verts.append((cx + math.cos(angle) * radius, y, cz + math.sin(angle) * radius))
    faces = [tuple(range(sides - 1, -1, -1)), tuple(range(sides, sides * 2))]
    for i in range(sides):
        n = (i + 1) % sides
        faces.append((i, n, sides + n, sides + i))
    return mesh_object(target, root, name, verts, faces, mat)


def add_textured_panel(target, root, name, center, half_width, half_height, mat, yaw=0.0):
    """Two-sided vertical plane with stable 0..1 UVs for shrine/window artwork."""
    cx, cy, cz = center
    c, s = math.cos(yaw), math.sin(yaw)
    right = Vector((c * half_width, s * half_width, 0.0))
    depth = Vector((-s * 0.025, c * 0.025, 0.0))
    middle = Vector((cx, cy, cz))
    points = [
        middle - right - Vector((0, 0, half_height)) + depth,
        middle + right - Vector((0, 0, half_height)) + depth,
        middle + right + Vector((0, 0, half_height)) + depth,
        middle - right + Vector((0, 0, half_height)) + depth,
    ]
    verts = [tuple(point) for point in points]
    uv_data = {0: (0.0, 0.0), 1: (1.0, 0.0), 2: (1.0, 1.0), 3: (0.0, 1.0)}
    return mesh_object(target, root, name, verts, [(0, 1, 2, 3), (3, 2, 1, 0)], mat,
                       uvs=lambda vi, _vs: uv_data[vi])


def add_pew_seed(target, root, name, mat):
    """One efficient dark-walnut pew mesh: seat, raked back, kneeler and ends."""
    verts = []
    faces = []

    def part(center, half):
        base = len(verts)
        cx, cy, cz = center
        hx, hy, hz = half
        verts.extend([
            (cx - hx, cy - hy, cz - hz), (cx + hx, cy - hy, cz - hz),
            (cx + hx, cy + hy, cz - hz), (cx - hx, cy + hy, cz - hz),
            (cx - hx, cy - hy, cz + hz), (cx + hx, cy - hy, cz + hz),
            (cx + hx, cy + hy, cz + hz), (cx - hx, cy + hy, cz + hz),
        ])
        faces.extend([
            (base + 3, base + 2, base + 1, base), (base + 4, base + 5, base + 6, base + 7),
            (base, base + 1, base + 5, base + 4), (base + 1, base + 2, base + 6, base + 5),
            (base + 2, base + 3, base + 7, base + 6), (base + 3, base, base + 4, base + 7),
        ])

    z = FLOOR_Z
    part((0.0, 0.0, z + 0.48), (2.75, 0.30, 0.075))
    part((0.0, 0.34, z + 0.88), (2.75, 0.075, 0.42))
    part((0.0, -0.52, z + 0.23), (2.65, 0.10, 0.10))
    for side in (-1, 1):
        part((side * 2.82, 0.04, z + 0.55), (0.11, 0.44, 0.55))
    return mesh_object(target, root, name, verts, faces, mat)


def duplicate_linked(source, target, root, name, location, rotation_z=0.0):
    obj = bpy.data.objects.new(name, source.data)
    obj.location = location
    obj.rotation_euler = (0.0, 0.0, rotation_z)
    target.objects.link(obj)
    obj.parent = root
    return tag(obj)


def collider(target, name, local_location, half_extents, yaw=0.0):
    # Local cathedral frame -> Blender world. Game Z is negative Blender Y.
    lx, ly, lz = local_location
    c = math.cos(YAW)
    s = math.sin(YAW)
    world_x = CENTER_X + lx * c - ly * s
    world_y = -CENTER_Z + lx * s + ly * c
    obj = bpy.data.objects.new(name, None)
    target.objects.link(obj)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 1
    obj.location = (world_x, world_y, FLOOR + lz)
    obj.rotation_euler[2] = YAW + yaw
    obj.scale = half_extents
    obj["sf_site"] = SITE_ID
    obj["sf_tile"] = TILE
    obj["sf_role"] = "collider"
    return obj


# ----------------------------------------------------------------------------
# Cupola shell profiles
#
# Face +X, half-face y >= 0 patch P(u, t):
#   u 0 at the stained-glass seam (face midline), 1 at the corner edge
#   t 0 at the shell base, 1 at the summit ridge
# The linear ruling between the two edges IS the hyperbolic-paraboloid saddle.
# ----------------------------------------------------------------------------

def seam_profile(t, half=CUPOLA_HALF, arm=ARM_HALF, z0=SHELL_SEAM_Z0, z1=ARM_TIP_Z):
    x = half + (arm - half) * (t ** 1.55)
    z = z0 + (z1 - z0) * t
    return x, z


def corner_profile(t, half=CUPOLA_HALF, z0=SHELL_Z0, z1=SHELL_TOP):
    # Quarter-cosine sweep: near-vertical at the base, strongest inward pull
    # around two-thirds height, easing out into the crown crest — measured
    # against the north-east reference photograph of the real corner edges.
    r = GLASS_HW + (half - GLASS_HW) * math.cos(t * math.pi / 2)
    z = z0 + (z1 - z0) * t
    return r, z


def rotate_quarter(x, y, quarter):
    for _ in range(quarter):
        x, y = -y, x
    return x, y


def shell_point(quarter, mirror, u, t, half, arm, seam_z0, corner_z0,
                z1_seam, z1_corner):
    """The saddle surface at continuous (u, t) — the coffer builder needs to
    evaluate between grid lines, so the ruling lives in one function."""
    sx, sz = seam_profile(t, half, arm, seam_z0, z1_seam)
    cr, cz = corner_profile(t, half, corner_z0, z1_corner)
    x = sx + (cr - sx) * u
    y = GLASS_HW + (cr - GLASS_HW) * u
    z = sz + (cz - sz) * u
    rx, ry = rotate_quarter(x, mirror * y, quarter)
    return (rx, ry, z)


def shell_surface_verts(half, arm, seam_z0, corner_z0, z1_seam, z1_corner):
    """All 8 patch grids. Verts are shared within a patch only: the corner
    arrises between faces keep split normals so they read as crisp edges
    instead of smoothing into an onion dome."""
    verts = []
    grids = []
    for quarter in range(4):
        for mirror in (1, -1):
            index = {}

            def vert(x, y, z):
                k = (round(x, 4), round(y, 4), round(z, 4))
                if k not in index:
                    index[k] = len(verts)
                    verts.append((x, y, z))
                return index[k]

            grid = []
            for it in range(SEG_T + 1):
                t = it / SEG_T
                sx, sz = seam_profile(t, half, arm, seam_z0, z1_seam)
                cr, cz = corner_profile(t, half, corner_z0, z1_corner)
                row = []
                for iu in range(SEG_U + 1):
                    u = iu / SEG_U
                    x = sx + (cr - sx) * u
                    y = GLASS_HW + (cr - GLASS_HW) * u
                    z = sz + (cz - sz) * u
                    rx, ry = rotate_quarter(x, mirror * y, quarter)
                    row.append(vert(rx, ry, z))
                grid.append(row)
            grids.append((grid, mirror))
    return verts, grids


def build_shell(target, root, mat_out, mat_in):
    # outer surface
    verts, grids = shell_surface_verts(
        CUPOLA_HALF, ARM_HALF, SHELL_SEAM_Z0, SHELL_Z0, ARM_TIP_Z, SHELL_TOP
    )
    faces = []
    for grid, mirror in grids:
        for it in range(SEG_T):
            for iu in range(SEG_U):
                quad = (grid[it][iu], grid[it][iu + 1], grid[it + 1][iu + 1], grid[it + 1][iu])
                faces.append(quad if mirror < 0 else quad[::-1])

    def shell_uv(vertex_index, vs):
        x, y, z = vs[vertex_index]
        return ((abs(x) + abs(y)) / 12.4, z / 12.4)

    outer = mesh_object(target, root, "cupola_shell", verts, faces, mat_out, uvs=shell_uv, smooth=True)

    # Inner surface: Nervi's precast triangular coffers, as real recessed
    # geometry rather than a painted grid. Every cell of a coarse (u, t) grid
    # splits into two triangles; each triangle's rim stays on the rib plane
    # while its inset copy sits on a deeper plane, so one quad per edge is both
    # the rib face and the sloped coffer wall — a truncated-pyramid recess in
    # 7 triangles, with no winding ambiguity. ~2700 coffers, against the real
    # ceiling's 1,680 in 128 sizes. A 20x5 grid split diagonally across all
    # eight shell sectors yields 1,600 recessed triangles: photographically
    # much closer than the former overly fine 2,688-cell lattice.
    COF_T, COF_U = 20, 5
    RIB = 0.19          # inset fraction toward the triangle centroid
    DEPTH = 0.34        # recess depth (toward the outer shell)
    rim_half = CUPOLA_HALF - SHELL_T
    pan_half = CUPOLA_HALF - SHELL_T + DEPTH
    rim = dict(half=rim_half, arm=ARM_HALF - 0.45,
               seam_z0=SHELL_SEAM_Z0, corner_z0=SHELL_Z0,
               z1_seam=ARM_TIP_Z - 0.5, z1_corner=SHELL_TOP - 0.5)
    pan = dict(half=pan_half, arm=ARM_HALF - 0.45 + DEPTH,
               seam_z0=SHELL_SEAM_Z0, corner_z0=SHELL_Z0,
               z1_seam=ARM_TIP_Z - 0.5, z1_corner=SHELL_TOP - 0.5)

    cverts = []
    cfaces = []

    def emit(quarter, mirror, uv_t, plane):
        cverts.append(shell_point(quarter, mirror, uv_t[0], uv_t[1], **plane))
        return len(cverts) - 1

    for quarter in range(4):
        for mirror in (1, -1):
            for it in range(COF_T):
                t0, t1 = it / COF_T, (it + 1) / COF_T
                for iu in range(COF_U):
                    u0, u1 = iu / COF_U, (iu + 1) / COF_U
                    quad = ((u0, t0), (u1, t0), (u1, t1), (u0, t1))
                    for tri in ((0, 1, 2), (0, 2, 3)):
                        params = [quad[k] for k in tri]
                        cu = sum(p[0] for p in params) / 3
                        ct = sum(p[1] for p in params) / 3
                        inset = [(p[0] + (cu - p[0]) * RIB, p[1] + (ct - p[1]) * RIB) for p in params]
                        rim_i = [emit(quarter, mirror, p, rim) for p in params]
                        pan_i = [emit(quarter, mirror, p, pan) for p in inset]
                        for k in range(3):
                            n = (k + 1) % 3
                            wall = (rim_i[k], rim_i[n], pan_i[n], pan_i[k])
                            cfaces.append(wall[::-1] if mirror < 0 else wall)
                        panel = tuple(pan_i)
                        cfaces.append(panel[::-1] if mirror < 0 else panel)

    def coffer_uv(vertex_index, vs):
        x, y, z = vs[vertex_index]
        return ((abs(x) + abs(y)) / 6.0, z / 6.0)

    mesh_object(target, root, "cupola_coffered_interior", cverts, cfaces, mat_in, uvs=coffer_uv)

    # base rim ring closing outer to inner at the clerestory line
    rim_verts = []
    rim_faces = []
    for quarter in range(4):
        for mirror in (1, -1):
            row_out = []
            row_in = []
            for iu in range(SEG_U + 1):
                u = iu / SEG_U
                yo = GLASS_HW + (CUPOLA_HALF - GLASS_HW) * u
                yi = GLASS_HW + (CUPOLA_HALF - SHELL_T - GLASS_HW) * u
                xo, yo2 = rotate_quarter(CUPOLA_HALF, mirror * yo, quarter)
                xi, yi2 = rotate_quarter(CUPOLA_HALF - SHELL_T, mirror * yi, quarter)
                base_z = SHELL_SEAM_Z0 + (SHELL_Z0 - SHELL_SEAM_Z0) * u
                row_out.append(len(rim_verts)); rim_verts.append((xo, yo2, base_z))
                row_in.append(len(rim_verts)); rim_verts.append((xi, yi2, base_z))
            for iu in range(SEG_U):
                quad = (row_out[iu], row_out[iu + 1], row_in[iu + 1], row_in[iu])
                rim_faces.append(quad if mirror < 0 else quad[::-1])
    mesh_object(target, root, "cupola_base_rim", rim_verts, rim_faces, mat_out)
    return outer


def build_glass_cross(target, root, quarter_mats, apex_mat):
    """One continuous ribbon per compass point: up the face seam, folding over
    the arm tip, running the ridge skylight to the centre — the bold cross.
    Each quarter carries its own elemental color band."""

    def ribbon_mesh(quarter, mat):
        verts = []
        faces = []
        uv_data = {}
        pa, pb, vv = [], [], []
        for it in range(SEG_T + 1):
            t = it / SEG_T
            x, z = seam_profile(t)
            recess = 0.34 * (1.0 - max(0.0, (t - 0.92) / 0.08))
            pa.append((x - recess, -GLASS_HW, z))
            pb.append((x - recess, GLASS_HW, z))
            vv.append(t * 0.78)
        for i in range(1, 13):
            s = i / 12
            x = ARM_HALF * (1.0 - s) + GLASS_HW * s
            z = ARM_TIP_Z + (SHELL_TOP - ARM_TIP_Z) * s + 0.07
            pa.append((x, -GLASS_HW, z))
            pb.append((x, GLASS_HW, z))
            vv.append(0.78 + s * 0.22)
        for i, (point_a, point_b) in enumerate(zip(pa, pb)):
            for point, u in ((point_a, 0.05), (point_b, 0.95)):
                x, y = rotate_quarter(point[0], point[1], quarter)
                uv_data[len(verts)] = (u, vv[i])
                verts.append((x, y, point[2]))
        for i in range(len(pa) - 1):
            a = i * 2
            faces.append((a, a + 1, a + 3, a + 2))
        name = f"stained_glass_{GLASS_ELEMENTS[quarter][0]}"
        return mesh_object(target, root, name, verts, faces, mat,
                           uvs=lambda vi, _vs: uv_data[vi])

    for quarter in range(4):
        ribbon_mesh(quarter, quarter_mats[quarter])

    # prismatic centre where the four elements meet, carrying the cross plinth
    verts = []
    uv_data = {}
    for dx, dy in ((-GLASS_HW, -GLASS_HW), (GLASS_HW, -GLASS_HW), (GLASS_HW, GLASS_HW), (-GLASS_HW, GLASS_HW)):
        uv_data[len(verts)] = (0.5, 0.995)
        verts.append((dx, dy, SHELL_TOP + 0.07))
    mesh_object(target, root, "stained_glass_apex", verts, [(0, 1, 2, 3)], apex_mat,
                uvs=lambda vi, _vs: uv_data[vi])


def build_baldacchino(target, root, gold):
    """Richard Lippold's 14-tier aluminum-rod veil and suspended gold cross."""
    rod_short = add_box(target, root, "baldacchino_rod_short_seed", (0, 0, 0),
                        (0.025, 0.025, 0.95), gold)
    rod_long = add_box(target, root, "baldacchino_rod_long_seed", (0, 0, 0),
                       (0.025, 0.025, 1.55), gold)
    TIERS = 14
    Z_TOP, Z_BOT = 37.0, 10.8
    R_TOP, R_BOT = 7.9, 1.7
    for tier in range(TIERS):
        f = tier / (TIERS - 1)
        z = Z_TOP + (Z_BOT - Z_TOP) * f
        radius = R_TOP + (R_BOT - R_TOP) * (f ** 0.78)
        spin = tier * 0.37
        rods_per_side = max(7, int(round(18 * (1.0 - f * 0.46))))
        corners = [
            (math.cos(spin + k * 2 * math.pi / 3) * radius,
             math.sin(spin + k * 2 * math.pi / 3) * radius)
            for k in range(3)
        ]
        for side in range(3):
            ax, ay = corners[side]
            bx, by = corners[(side + 1) % 3]
            length = math.hypot(bx - ax, by - ay)
            yaw = math.atan2(by - ay, bx - ax)
            add_box(target, root, f"baldacchino_tier_edge_{tier}_{side}",
                    ((ax + bx) / 2, (ay + by) / 2, z + 1.1),
                    (length / 2, 0.025, 0.025), gold, yaw=yaw)
            for k in range(rods_per_side):
                g = (k + 0.5) / rods_per_side
                x = ax + (bx - ax) * g
                y = ay + (by - ay) * g
                jitter = 0.42 * math.sin(tier * 2.4 + side * 1.7 + k * 3.1)
                source = rod_long if (tier + side + k) % 3 == 0 else rod_short
                duplicate_linked(source, target, root, f"baldacchino_rod_{tier}_{side}_{k}",
                                 (x, y, z + jitter))
    for rod in (rod_short, rod_long):
        rod.hide_render = True
        rod.hide_viewport = True
    # suspension wires up into the cupola, and the crucifix at the heart
    for k in range(3):
        angle = k * 2 * math.pi / 3
        add_box(target, root, f"baldacchino_wire_{k}",
                (math.cos(angle) * R_TOP * 0.72, math.sin(angle) * R_TOP * 0.72, 46.8),
                (0.022, 0.022, 9.8), gold)
    add_box(target, root, "baldacchino_crucifix", (0, 0, 7.35), (0.055, 0.055, 2.35), gold)
    add_box(target, root, "baldacchino_crucifix_arm", (0, 0, 8.25), (1.25, 0.055, 0.055), gold)


def build_arch_infill(target, root, glass_mat, mullion_mat):
    """Four V-headed clerestory walls below the saddle springing. Their high
    face midpoints produce the giant pointed openings seen in interior photos."""
    radius = CUPOLA_HALF - 0.72
    segments = 8
    # Only the entrance and sanctuary faces need the V-headed infill. Leaving
    # the east/west faces open exposes the coffered saddle and the cathedral's
    # vast corner glazing instead of boxing the nave into a white pyramid.
    for quarter in (1, 3):
        verts = []
        faces = []
        for i in range(segments + 1):
            along = -radius + 2 * radius * i / segments
            u = abs(along) / radius
            top_z = SHELL_SEAM_Z0 + (SHELL_Z0 - SHELL_SEAM_Z0) * u - 0.12
            if quarter == 0:
                x, y = radius, along
            elif quarter == 1:
                x, y = -along, radius
            elif quarter == 2:
                x, y = -radius, -along
            else:
                x, y = along, -radius
            verts.extend([(x, y, ROOF_TOP), (x, y, top_z)])
        for i in range(segments):
            a = i * 2
            faces.append((a, a + 2, a + 3, a + 1))
        mesh_object(target, root, f"pointed_clerestory_glass_{quarter}", verts, faces, glass_mat)

        for i in range(segments + 1):
            along = -radius + 2 * radius * i / segments
            u = abs(along) / radius
            top_z = SHELL_SEAM_Z0 + (SHELL_Z0 - SHELL_SEAM_Z0) * u
            if quarter == 0:
                center = (radius - 0.03, along, (ROOF_TOP + top_z) / 2)
                half = (0.09, 0.09, max(0.08, (top_z - ROOF_TOP) / 2))
            elif quarter == 1:
                center = (-along, radius - 0.03, (ROOF_TOP + top_z) / 2)
                half = (0.09, 0.09, max(0.08, (top_z - ROOF_TOP) / 2))
            elif quarter == 2:
                center = (-radius + 0.03, -along, (ROOF_TOP + top_z) / 2)
                half = (0.09, 0.09, max(0.08, (top_z - ROOF_TOP) / 2))
            else:
                center = (along, -radius + 0.03, (ROOF_TOP + top_z) / 2)
                half = (0.09, 0.09, max(0.08, (top_z - ROOF_TOP) / 2))
            add_box(target, root, f"pointed_clerestory_mullion_{quarter}_{i}",
                    center, half, mullion_mat)


def build(args):
    def stage(label):
        print(f"[st-marys] {label}", flush=True)

    repo = Path(args.repo).resolve()
    project_dir = repo / "assets-src/world/sites/st-marys"
    textures = project_dir / "textures"
    textures.mkdir(parents=True, exist_ok=True)
    output = project_dir / "st-marys.blend"

    clean_scene()
    scene = bpy.context.scene
    scene["sf_authoring_schema"] = 2
    scene["sf_region"] = SITE_ID
    scene["sf_tile"] = TILE
    scene["sf_architecture_reference"] = (
        "Cathedral of Saint Mary of the Assumption: 255 ft square podium, 190 ft "
        "hyperbolic-paraboloid cupola, 55 ft golden cross (smcsf.org, C20 Society)"
    )
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
    scene.render.resolution_percentage = 60
    scene.view_settings.exposure = -0.35
    try:
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass

    site = bpy.data.collections.new("SITE_st_marys")
    scene.collection.children.link(site)
    visual = collection(site, "VISUAL")
    exterior = collection(visual, "ARCHITECTURE_EXTERIOR")
    cupola = collection(visual, "CUPOLA_SHELL")
    glass = collection(visual, "STAINED_GLASS")
    interior = collection(visual, "ARCHITECTURE_INTERIOR")
    furniture = collection(visual, "FURNISHINGS")
    collider_collection = collection(site, "COLLIDERS", hidden=True)
    collection(site, "AUTHORING", hidden=True)
    collection(site, "TERRAIN_OWNERSHIP", hidden=True)
    preview = collection(site, "BLENDER_PREVIEW_ONLY")

    root = bpy.data.objects.new("st_marys_authored_landmark", None)
    visual.objects.link(root)
    root.location = (CENTER_X, -CENTER_Z, FLOOR)
    root.rotation_euler[2] = YAW
    tag(root)

    stage("baking textures")
    travertine_img = write_image(textures / "travertine.png", "st-marys travertine", travertine_pixels())
    coffer_img = write_image(textures / "coffer.png", "st-marys coffers", coffer_pixels())
    brick_img = write_image(textures / "mission-brick.png", "st-marys mission brick", brick_pixels())
    stained_mats = {}
    for quarter, (element, stops) in GLASS_ELEMENTS.items():
        img = write_image(textures / f"stained-glass-{element}.png",
                          f"st-marys dalle de verre {element}",
                          stained_glass_pixels(stops, seed=11 + quarter))
        stained_mats[quarter] = textured_material(
            f"Dalle de verre · {element}", img, 0.26, emission_strength=0.62)

    travertine = textured_material("St Mary travertine panels", travertine_img, 0.86)
    coffer = textured_material("Nervi triangular coffers", coffer_img, 0.94)
    chapel_img = write_image(textures / "chapel-window.png", "st-marys chapel glass", chapel_window_pixels())
    chapel_glass = textured_material("Chapel faceted glass wall", chapel_img, 0.3, emission_strength=0.9)
    guadalupe_img = bpy.data.images.load(str(textures / "guadalupe-mosaic.png"), check_existing=True)
    guadalupe_img.name = "st-marys original Guadalupe mosaic"
    guadalupe = textured_material("Our Lady of Guadalupe mosaic", guadalupe_img, 0.64)
    apex_glass = material("Prismatic apex glass", (*GLASS_APEX,), 0.2,
                          emission=(*GLASS_APEX,), emission_strength=0.8)
    white_slab = material("Precast fascia white", (0.84, 0.825, 0.79), 0.82)
    interior_concrete = material("Board-formed interior concrete", (0.355, 0.345, 0.325), 0.88)
    step_stone = material("Plaza step stone", (0.74, 0.72, 0.68), 0.9)
    brick = textured_material("Mission red brick", brick_img, 0.88)
    dark_glass = material("Podium glazing", (0.045, 0.055, 0.075), 0.09, 0.55,
                          emission=(0.82, 0.62, 0.36), emission_strength=0.26)
    bronze = material("Bronze mullion", (0.16, 0.125, 0.09), 0.5, 0.42)
    gold = material("Golden cross", (0.85, 0.65, 0.22), 0.3, 1.0, (0.9, 0.62, 0.15), 0.12)
    marble = material("Sanctuary marble", (0.86, 0.85, 0.83), 0.55)
    dark_marble = material("Sanctuary dark marble", (0.055, 0.060, 0.055), 0.24)
    rosa_marble = material("Rosa Antica marble", (0.48, 0.20, 0.19), 0.48)
    wood = material("Walnut pews", (0.075, 0.026, 0.012), 0.42)
    wood_panel = material("Vertical walnut acoustic slats", (0.145, 0.067, 0.028), 0.55)
    organ_silver = material("Ruffatti tin pipes", (0.46, 0.49, 0.51), 0.24, 0.78)
    font_water = material("Baptismal water", (0.18, 0.34, 0.34), 0.10, 0.05,
                          emission=(0.15, 0.30, 0.32), emission_strength=0.16)
    tapestry_red = material("Blessed Sacrament tapestry", (0.42, 0.035, 0.018), 0.72)
    stage("materials ready")

    # ------------------------------------------------------------------ plaza
    # Podium skirt: the garage mass under the plaza. Buried where the hill is
    # high, a travertine retaining wall where it falls away to the south — the
    # plaza can never read as floating regardless of the terrain beneath it.
    add_box(exterior, root, "podium_skirt", (1.0, 4.0, (PLAZA_TOP + SKIRT_BOTTOM) / 2),
            (45.6, 50.6, (PLAZA_TOP - SKIRT_BOTTOM) / 2), travertine, uv_scale=16.0)
    add_box(exterior, root, "plaza_platform", (1.0, 4.0, PLAZA_TOP / 2), (45.0, 50.0, PLAZA_TOP / 2), brick)
    add_box(exterior, root, "plaza_step_mid", (1.0, 4.0, 0.45), (46.5, 51.5, 0.45), step_stone)
    add_box(exterior, root, "plaza_step_low", (1.0, 4.0, 0.225), (48.0, 53.0, 0.225), step_stone)
    for step in range(3):
        add_box(exterior, root, f"geary_stair_{step}",
                (0.0, 54.6 + step * 1.5, (PLAZA_TOP - step * 0.45) / 2),
                (15.0, 0.75, (PLAZA_TOP - step * 0.45) / 2), step_stone)
    # South and east flights walk the hill down off the raised plaza.
    for step in range(9):
        drop = step * 0.62
        add_box(exterior, root, f"south_stair_{step}",
                (0.0, -(48.6 + step * 1.35), PLAZA_TOP / 2 - drop),
                (13.0, 0.68, PLAZA_TOP / 2 + drop), step_stone)
        add_box(exterior, root, f"east_stair_{step}",
                (46.6 + step * 1.35, 4.0, PLAZA_TOP / 2 - drop),
                (0.68, 12.0, PLAZA_TOP / 2 + drop), step_stone)
    stage("plaza ready")

    # ----------------------------------------------------------------- podium
    # The roof deck is an annulus: the nave opens straight up into the cupola.
    ROOF_HOLE = CUPOLA_HALF - 0.8
    ring_w = (PODIUM_HALF - ROOF_HOLE) / 2
    ring_c = (PODIUM_HALF + ROOF_HOLE) / 2
    roof_z = (ROOF_TOP + BAND_TOP) / 2
    roof_h = (ROOF_TOP - BAND_TOP) / 2
    add_box(exterior, root, "roof_deck_n", (0, ring_c, roof_z), (PODIUM_HALF, ring_w, roof_h), white_slab)
    add_box(exterior, root, "roof_deck_s", (0, -ring_c, roof_z), (PODIUM_HALF, ring_w, roof_h), white_slab)
    add_box(exterior, root, "roof_deck_e", (ring_c, 0, roof_z), (ring_w, ROOF_HOLE, roof_h), white_slab)
    add_box(exterior, root, "roof_deck_w", (-ring_c, 0, roof_z), (ring_w, ROOF_HOLE, roof_h), white_slab)
    # Perimeter band only — a solid slab here would cap the nave and hide the
    # whole cupola from inside.
    band_z = (BAND_TOP + GLASS_TOP) / 2
    band_h = (BAND_TOP - GLASS_TOP) / 2
    band_r = GLASS_HALF + 0.45
    for axis, (bx, by, hx, hy) in enumerate((
        (0, band_r, band_r, 0.55), (0, -band_r, band_r, 0.55),
        (band_r, 0, 0.55, band_r), (-band_r, 0, 0.55, band_r),
    )):
        add_box(exterior, root, f"mezzanine_band_{axis}", (bx, by, band_z),
                (hx, hy, band_h), travertine, uv_scale=12.4)
    # curtain walls as four slabs so the north entry bay stays genuinely open
    glass_z = (GLASS_TOP + PLAZA_TOP) / 2
    glass_h = (GLASS_TOP - PLAZA_TOP) / 2
    add_box(exterior, root, "curtain_glass_s", (0, -GLASS_HALF, glass_z), (GLASS_HALF, 0.12, glass_h), dark_glass)
    add_box(exterior, root, "curtain_glass_e", (GLASS_HALF, 0, glass_z), (0.12, GLASS_HALF, glass_h), dark_glass)
    add_box(exterior, root, "curtain_glass_w", (-GLASS_HALF, 0, glass_z), (0.12, GLASS_HALF, glass_h), dark_glass)
    for side in (-1, 1):
        add_box(exterior, root, f"curtain_glass_n_{side}", (side * (GLASS_HALF + 7.5) / 2, GLASS_HALF, glass_z),
                ((GLASS_HALF - 7.5) / 2, 0.12, glass_h), dark_glass)

    bays = 8
    for i in range(bays + 1):
        p = -GLASS_HALF + 2 * GLASS_HALF * i / bays
        corner = abs(abs(p) - GLASS_HALF) < 0.1
        wide = 3.3 if corner else 1.1
        for axis in range(4):
            if axis == 0 and not corner and abs(p) < 7.5:
                continue  # entry bay stays open on the north face
            cx, cy = ((p, GLASS_HALF), (p, -GLASS_HALF), (-GLASS_HALF, p), (GLASS_HALF, p))[axis]
            hx, hy = ((wide, 0.65), (wide, 0.65), (0.65, wide), (0.65, wide))[axis]
            add_box(exterior, root, f"pier_{axis}_{i}", (cx, cy, (GLASS_TOP + PLAZA_TOP) / 2),
                    (hx, hy, (GLASS_TOP - PLAZA_TOP) / 2), travertine, uv_scale=12.4)
        if i < bays:
            for m in range(1, 4):
                q = p + 2 * GLASS_HALF / bays * m / 4
                for axis in range(4):
                    if axis == 0 and abs(q) < 7.5:
                        continue
                    cx, cy = ((q, GLASS_HALF), (q, -GLASS_HALF), (-GLASS_HALF, q), (GLASS_HALF, q))[axis]
                    hx, hy = ((0.14, 0.5), (0.14, 0.5), (0.5, 0.14), (0.5, 0.14))[axis]
                    add_box(exterior, root, f"mullion_{axis}_{i}_{m}",
                            (cx, cy, (GLASS_TOP + PLAZA_TOP) / 2),
                            (hx, hy, (GLASS_TOP - PLAZA_TOP) / 2), bronze)

    # entry: recessed portal on the north (Geary plaza) face, doors ajar
    add_box(exterior, root, "entry_lintel", (0, GLASS_HALF - 0.6, (GLASS_TOP + 7.1) / 2),
            (7.5, 1.25, (GLASS_TOP - 7.1) / 2), travertine, uv_scale=12.4)
    add_box(exterior, root, "entry_reveal_west", (-7.2, GLASS_HALF - 0.6, (7.1 + PLAZA_TOP) / 2),
            (0.45, 1.25, (7.1 - PLAZA_TOP) / 2), travertine, uv_scale=12.4)
    add_box(exterior, root, "entry_reveal_east", (7.2, GLASS_HALF - 0.6, (7.1 + PLAZA_TOP) / 2),
            (0.45, 1.25, (7.1 - PLAZA_TOP) / 2), travertine, uv_scale=12.4)
    add_box(exterior, root, "entry_transom", (0, GLASS_HALF - 1.1, 6.35), (6.7, 0.1, 0.75), dark_glass)
    for side in (-1, 1):
        add_box(exterior, root, f"entry_door_{side}", (side * 4.1, GLASS_HALF - 1.7, (5.6 + PLAZA_TOP) / 2),
                (2.35, 0.14, (5.6 - PLAZA_TOP) / 2), bronze, yaw=side * 0.38)
    stage("podium ready")

    # ------------------------------------------------- clerestory and pylons
    # clerestory as four glass walls — open above so the cupola, the glass
    # bands and the baldacchino all read from the nave floor
    cl_z = (SHELL_Z0 + ROOF_TOP) / 2
    cl_h = (SHELL_Z0 - ROOF_TOP) / 2 + 0.08
    add_box(exterior, root, "clerestory_n", (0, ROOF_HOLE, cl_z), (ROOF_HOLE, 0.3, cl_h), dark_glass)
    add_box(exterior, root, "clerestory_s", (0, -ROOF_HOLE, cl_z), (ROOF_HOLE, 0.3, cl_h), dark_glass)
    add_box(exterior, root, "clerestory_e", (ROOF_HOLE, 0, cl_z), (0.3, ROOF_HOLE - 0.3, cl_h), dark_glass)
    add_box(exterior, root, "clerestory_w", (-ROOF_HOLE, 0, cl_z), (0.3, ROOF_HOLE - 0.3, cl_h), dark_glass)
    build_arch_infill(interior, root, interior_concrete, interior_concrete)
    for sx in (-1, 1):
        for sy in (-1, 1):
            add_box(exterior, root, f"pylon_{sx}_{sy}", (sx * 18.5, sy * 18.5, (15.6 + FLOOR_Z) / 2),
                    (2.5, 2.5, (15.6 - FLOOR_Z) / 2), interior_concrete, taper=0.8)
    stage("clerestory ready")

    # ----------------------------------------------------------- cupola shell
    build_shell(cupola, root, travertine, coffer)
    build_glass_cross(glass, root, stained_mats, apex_glass)
    add_box(exterior, root, "summit_cross", (0, 0, SHELL_TOP + 0.14 + CROSS_H / 2),
            (0.31, 0.31, CROSS_H / 2), gold)
    add_box(exterior, root, "summit_cross_arm", (0, 0, SHELL_TOP + 0.14 + CROSS_H * 0.68),
            (3.7, 0.31, 0.31), gold)
    stage("cupola ready")

    # ---------------------------------------------------------------- interior
    add_box(interior, root, "nave_floor", (0, 0, FLOOR_Z - 0.05),
            (GLASS_HALF, GLASS_HALF, 0.05), brick, uv_scale=5.2, uv_axis="floor")

    # The real sanctuary is a dark polished-marble island with pale faceted
    # steps and a monolithic Botticino altar, not a stack of square platforms.
    add_prism(furniture, root, "sanctuary_dark_marble", (0, 0, FLOOR_Z + 0.09),
              (9.2, 8.5), 0.09, 16, dark_marble, rotation=math.pi / 16)
    add_prism(furniture, root, "sanctuary_step_lower", (0, 0, FLOOR_Z + 0.22),
              (6.9, 6.35), 0.13, 12, marble, rotation=math.pi / 12)
    add_prism(furniture, root, "sanctuary_predella", (0, 0, FLOOR_Z + 0.39),
              (5.8, 5.2), 0.17, 12, marble, rotation=math.pi / 12)
    add_box(furniture, root, "high_altar", (0, 0, FLOOR_Z + 1.05),
            (1.70, 0.92, 0.53), marble, taper=0.78)
    add_box(furniture, root, "altar_mensa", (0, 0, FLOOR_Z + 1.60),
            (1.88, 1.04, 0.07), marble)
    add_box(furniture, root, "ambo", (-4.4, 2.8, FLOOR_Z + 1.06),
            (0.62, 0.52, 0.68), marble, taper=0.78, yaw=-0.18)
    add_box(furniture, root, "cathedra_seat", (0, -5.8, FLOOR_Z + 0.78),
            (0.95, 0.78, 0.30), marble)
    add_box(furniture, root, "cathedra_back", (0, -6.45, FLOOR_Z + 1.85),
            (0.95, 0.14, 1.35), marble)
    lippold_gold = material("Lippold gold rods", (0.54, 0.38, 0.12), 0.28, 0.88,
                            emission=(0.62, 0.40, 0.12), emission_strength=0.025)
    build_baldacchino(furniture, root, lippold_gold)

    # Warm acoustic-slatted sanctuary wall, central jeweled window and cross.
    backdrop_y = -35.15
    add_box(interior, root, "sanctuary_walnut_backdrop",
            (0, backdrop_y, FLOOR_Z + 4.15), (30.2, 0.18, 4.15), wood_panel)
    for slat in range(-48, 49):
        x = slat * 0.61
        add_box(interior, root, f"sanctuary_acoustic_slat_{slat}",
                (x, backdrop_y + 0.205, FLOOR_Z + 4.2), (0.045, 0.035, 4.05), bronze)
    add_textured_panel(interior, root, "sanctuary_jewel_window",
                       (0, backdrop_y + 0.26, FLOOR_Z + 5.0), 2.45, 3.65, stained_mats[3])
    add_box(furniture, root, "sanctuary_cross_upright",
            (0, backdrop_y + 0.31, FLOOR_Z + 5.15), (0.10, 0.07, 2.75), gold)
    add_box(furniture, root, "sanctuary_cross_arm",
            (0, backdrop_y + 0.31, FLOOR_Z + 6.25), (1.25, 0.07, 0.10), gold)

    # Our Lady of Guadalupe mosaic and burning-bush bronze surround.
    shrine_x = -14.1
    add_textured_panel(furniture, root, "guadalupe_mosaic",
                       (shrine_x, backdrop_y + 0.30, FLOOR_Z + 4.25), 1.40, 2.55, guadalupe)
    for ray in range(18):
        angle = math.tau * ray / 18
        x = shrine_x + math.cos(angle) * 1.65
        z = FLOOR_Z + 4.25 + math.sin(angle) * 2.85
        add_box(furniture, root, f"guadalupe_burning_bush_{ray}",
                (x, backdrop_y + 0.27, z), (0.06, 0.06, 0.28), bronze, yaw=-angle)
    add_box(furniture, root, "guadalupe_shrine_plinth",
            (shrine_x, backdrop_y + 0.20, FLOOR_Z + 1.28), (1.85, 0.62, 0.25), marble)

    # Blessed Sacrament shrine: flame tapestry, golden host and stone tabernacle.
    sacrament_x = 14.2
    add_box(furniture, root, "sacrament_tapestry",
            (sacrament_x, backdrop_y + 0.28, FLOOR_Z + 4.6), (1.55, 0.05, 2.65), tapestry_red)
    add_vertical_disc(furniture, root, "sacrament_host",
                      (sacrament_x, backdrop_y + 0.20, FLOOR_Z + 5.0), 0.72, 0.055, gold, sides=32)
    add_box(furniture, root, "sacrament_tabernacle",
            (sacrament_x, backdrop_y + 0.10, FLOOR_Z + 1.65), (0.92, 0.66, 0.82), marble, taper=0.88)
    add_box(furniture, root, "sacrament_plinth",
            (sacrament_x, backdrop_y + 0.02, FLOOR_Z + 0.62), (1.45, 0.82, 0.18), rosa_marble)

    # Baptismal font immediately inside the north entrance: three-step,
    # faceted Botticino basin with Rosa Antica rails and the Paschal candle.
    font_y = 29.2
    add_prism(furniture, root, "baptism_font_step_1",
              (0, font_y, FLOOR_Z + 0.08), 2.75, 0.08, 8, brick, rotation=math.pi / 8)
    add_prism(furniture, root, "baptism_font_step_2",
              (0, font_y, FLOOR_Z + 0.19), 2.42, 0.11, 8, marble, rotation=math.pi / 8)
    add_prism(furniture, root, "baptism_font_bowl",
              (0, font_y, FLOOR_Z + 0.69), 2.02, 0.50, 8, marble, rotation=math.pi / 8)
    add_prism(furniture, root, "baptism_font_water",
              (0, font_y, FLOOR_Z + 1.205), 1.42, 0.025, 8, font_water, rotation=math.pi / 8)
    add_prism(furniture, root, "baptism_font_center",
              (0, font_y, FLOOR_Z + 1.29), 0.43, 0.08, 8, marble, rotation=math.pi / 8)
    for side in (-1, 1):
        add_box(furniture, root, f"baptism_rosa_rail_{side}",
                (side * 4.4, font_y + 0.25, FLOOR_Z + 1.02),
                (2.15, 0.28, 0.20), rosa_marble, yaw=side * 0.10)
        for leg in (-1, 1):
            add_box(furniture, root, f"baptism_rail_leg_{side}_{leg}",
                    (side * 4.4 + leg * 1.55, font_y + 0.25, FLOOR_Z + 0.52),
                    (0.08, 0.08, 0.52), bronze)
    add_cylinder(furniture, root, "paschal_candle",
                 (-4.7, font_y - 2.2, FLOOR_Z + 2.95), 0.13, 1.65, marble, sides=20)
    add_prism(furniture, root, "paschal_candle_holder",
              (-4.7, font_y - 2.2, FLOOR_Z + 0.72), 0.56, 0.72, 8, bronze, rotation=math.pi / 8)

    # Fourteen small bronze Stations of the Cross around the side walls.
    for side in (-1, 1):
        wall_x = side * (GLASS_HALF - 0.32)
        for station in range(7):
            y = -24.0 + station * 8.0
            add_box(furniture, root, f"station_plaque_{side}_{station}",
                    (wall_x, y, FLOOR_Z + 3.6), (0.62, 0.10, 0.76), bronze, yaw=math.pi / 2)
            relief_x = wall_x - side * 0.12
            add_box(furniture, root, f"station_cross_upright_{side}_{station}",
                    (relief_x, y, FLOOR_Z + 3.66), (0.07, 0.07, 0.42), gold)
            add_box(furniture, root, f"station_cross_arm_{side}_{station}",
                    (relief_x, y, FLOOR_Z + 3.80), (0.07, 0.30, 0.07), gold)

    # --- north-west chapel: the faceted glass wall and the bronze crucifix ---
    chapel_x, chapel_y = -26.5, 26.5
    add_box(interior, root, "chapel_wall", (chapel_x, chapel_y, FLOOR_Z + 4.6),
            (7.0, 0.5, 4.6), travertine, yaw=math.pi / 4, uv_scale=12.4)
    add_box(interior, root, "chapel_glass_wall", (chapel_x - 1.3, chapel_y + 1.3, FLOOR_Z + 4.3),
            (6.0, 0.14, 4.0), chapel_glass, yaw=math.pi / 4)
    # a restrained geometric corpus on the cross, as at the real shrine
    cross_x, cross_y = chapel_x + 0.75, chapel_y - 0.75
    add_box(furniture, root, "chapel_cross_upright", (cross_x, cross_y, FLOOR_Z + 5.0),
            (0.16, 0.16, 2.5), bronze, yaw=math.pi / 4)
    add_box(furniture, root, "chapel_cross_arm", (cross_x, cross_y, FLOOR_Z + 6.0),
            (1.5, 0.16, 0.16), bronze, yaw=math.pi / 4)
    add_box(furniture, root, "chapel_corpus_torso", (cross_x + 0.2, cross_y - 0.2, FLOOR_Z + 5.6),
            (0.34, 0.2, 0.72), bronze, yaw=math.pi / 4)
    add_box(furniture, root, "chapel_corpus_legs", (cross_x + 0.2, cross_y - 0.2, FLOOR_Z + 4.5),
            (0.22, 0.2, 0.6), bronze, yaw=math.pi / 4)
    add_box(furniture, root, "chapel_corpus_arms", (cross_x + 0.2, cross_y - 0.2, FLOOR_Z + 6.0),
            (1.1, 0.18, 0.16), bronze, yaw=math.pi / 4)
    add_box(furniture, root, "chapel_corpus_head", (cross_x + 0.22, cross_y - 0.22, FLOOR_Z + 6.5),
            (0.2, 0.18, 0.24), bronze, yaw=math.pi / 4)
    for k in (-1, 0, 1):
        kx = chapel_x + 3.0 + k * 1.6 * math.cos(math.pi / 4)
        ky = chapel_y - 3.0 + k * 1.6 * math.sin(math.pi / 4)
        add_box(furniture, root, f"chapel_kneeler_{k}", (kx, ky, FLOOR_Z + 0.24),
                (0.7, 0.28, 0.24), wood, yaw=math.pi / 4)
    collider(collider_collection, "sm_chapel_wall", (chapel_x, chapel_y, FLOOR_Z + 4.6),
             (7.0, 0.6, 4.6), yaw=math.pi / 4)
    pew_seed = add_pew_seed(furniture, root, "pew_seed", wood)
    # Pews fan around the central sanctuary in three wedges, every bench turned
    # to face the altar with processional aisles between the lanes.
    # West, north-entry and east wedges. The north bank splits around the
    # processional aisle, as in the entrance photographs; the south side stays
    # open for the organ, shrines and sanctuary backdrop.
    PEW_BANKS = (math.pi, math.pi / 2, 0.0)
    for bank, base_angle in enumerate(PEW_BANKS):
        for row in range(9):
            if base_angle == math.pi / 2 and row >= 7:
                continue  # keep the baptismal font and entrance rail clear
            r = 12.8 + row * 2.05
            if base_angle == math.pi / 2:
                for segment, x in enumerate((-12.0, -6.3, 6.3, 12.0)):
                    duplicate_linked(
                        pew_seed, furniture, root,
                        f"pew_{bank}_{row}_entry_{segment}", (x, r, 0), 0.0
                    )
                continue
            for lane in (-1, 1):
                spread = math.atan2(lane * 4.6, r)
                for wedge in range(3):
                    angle = base_angle + spread + (wedge - 1) * math.atan2(lane * 2.55, r)
                    px, py = math.cos(angle) * r, math.sin(angle) * r
                    yaw_bench = angle + math.pi / 2
                    duplicate_linked(pew_seed, furniture, root,
                                     f"pew_{bank}_{row}_{lane}_{wedge}", (px, py, 0), yaw_bench)
    pew_seed.hide_render = True
    pew_seed.hide_viewport = True

    # Ruffatti organ: the flaring concrete pedestal that seems to rise out of
    # the floor, crowned by three interleaved fans of silver pipes.
    organ_x, organ_y = 13.5, -20.5
    add_box(furniture, root, "organ_pedestal", (organ_x, organ_y, FLOOR_Z + 1.9), (1.7, 1.5, 1.9),
            white_slab, taper=1.55)
    add_box(furniture, root, "organ_deck", (organ_x, organ_y, FLOOR_Z + 3.9), (2.75, 2.45, 0.14), marble)
    add_box(furniture, root, "organ_wind_chest", (organ_x, organ_y, FLOOR_Z + 4.25),
            (2.15, 1.65, 0.28), wood_panel)
    aim = math.atan2(0 - organ_y, 0 - organ_x)
    for fan in range(3):
        pipe_count = 17
        for rank in range(pipe_count):
            f = rank / (pipe_count - 1)
            spread = (f - 0.5) * math.radians(104 - fan * 10)
            angle = aim + math.pi + spread
            r = 1.65 + fan * 0.42 + 0.18 * abs(math.sin(spread * 3))
            px = organ_x + math.cos(angle) * r
            py = organ_y + math.sin(angle) * r
            height = 1.7 + fan * 0.35 + 5.2 * (1 - abs(f - 0.5) * 2) ** 1.25
            add_cylinder(
                furniture, root, f"organ_pipe_{fan}_{rank}",
                (px, py, FLOOR_Z + 4.46 + height / 2),
                0.095 + fan * 0.012, height / 2, organ_silver, sides=10
            )
    stage("interior ready")

    # ---------------------------------------------------------------- colliders
    collider(collider_collection, "sm_plaza", (1, 4, 0.7), (45.0, 50.0, 0.7))
    collider(collider_collection, "sm_steps_n", (1, 56.0, 0.45), (46.5, 2.6, 0.45))
    collider(collider_collection, "sm_steps_s", (1, -48.0, 0.45), (46.5, 2.6, 0.45))
    collider(collider_collection, "sm_steps_e", (49.0, 4, 0.45), (2.6, 52.0, 0.45))
    collider(collider_collection, "sm_steps_w", (-47.0, 4, 0.45), (2.6, 52.0, 0.45))
    collider(collider_collection, "sm_stair_geary", (0, 56.4, 0.65), (15.2, 3.0, 0.65))
    for step in range(9):
        drop = step * 0.62
        collider(collider_collection, f"sm_south_stair_{step}", (0.0, -(48.6 + step * 1.35), PLAZA_TOP / 2 - drop),
                 (13.0, 0.7, PLAZA_TOP / 2 + drop))
        collider(collider_collection, f"sm_east_stair_{step}", (46.6 + step * 1.35, 4.0, PLAZA_TOP / 2 - drop),
                 (0.7, 12.0, PLAZA_TOP / 2 + drop))
    wall_z = (BAND_TOP + FLOOR_Z) / 2
    wall_h = (BAND_TOP - FLOOR_Z) / 2
    collider(collider_collection, "sm_wall_e", (GLASS_HALF, 0, wall_z), (0.6, GLASS_HALF + 0.4, wall_h))
    collider(collider_collection, "sm_wall_w", (-GLASS_HALF, 0, wall_z), (0.6, GLASS_HALF + 0.4, wall_h))
    collider(collider_collection, "sm_wall_s", (0, -GLASS_HALF, wall_z), (GLASS_HALF + 0.4, 0.6, wall_h))
    collider(collider_collection, "sm_wall_n_west", (-21.5, GLASS_HALF, wall_z), (14.6, 0.6, wall_h))
    collider(collider_collection, "sm_wall_n_east", (21.5, GLASS_HALF, wall_z), (14.6, 0.6, wall_h))
    collider(collider_collection, "sm_entry_lintel", (0, GLASS_HALF - 0.5, (BAND_TOP + 7.1) / 2),
             (7.5, 1.4, (BAND_TOP - 7.1) / 2))
    for side in (-1, 1):
        collider(collider_collection, f"sm_entry_door_{side}", (side * 4.1, GLASS_HALF - 1.7, (5.6 + PLAZA_TOP) / 2),
                 (2.35, 0.2, (5.6 - PLAZA_TOP) / 2), yaw=side * 0.38)
    collider(collider_collection, "sm_roof_n", (0, ring_c, roof_z), (PODIUM_HALF, ring_w, roof_h))
    collider(collider_collection, "sm_roof_s", (0, -ring_c, roof_z), (PODIUM_HALF, ring_w, roof_h))
    collider(collider_collection, "sm_roof_e", (ring_c, 0, roof_z), (ring_w, ROOF_HOLE, roof_h))
    collider(collider_collection, "sm_roof_w", (-ring_c, 0, roof_z), (ring_w, ROOF_HOLE, roof_h))
    for axis, (cx, cy, hx, hy) in enumerate((
        (0, CUPOLA_HALF - 0.8, CUPOLA_HALF - 0.8, 0.5),
        (0, -(CUPOLA_HALF - 0.8), CUPOLA_HALF - 0.8, 0.5),
        (CUPOLA_HALF - 0.8, 0, 0.5, CUPOLA_HALF - 0.8),
        (-(CUPOLA_HALF - 0.8), 0, 0.5, CUPOLA_HALF - 0.8),
    )):
        collider(collider_collection, f"sm_clerestory_{axis}", (cx, cy, (SHELL_Z0 + ROOF_TOP) / 2),
                 (hx, hy, (SHELL_Z0 - ROOF_TOP) / 2 + 0.1))
    for sx in (-1, 1):
        for sy in (-1, 1):
            collider(collider_collection, f"sm_pylon_{sx}_{sy}", (sx * 18.9, sy * 18.9, 9.0), (2.6, 2.6, 7.5))
    shell_bands = ((21.5, 6.5, 20.0, 17.0), (34.5, 6.5, 16.6, 12.0), (47.0, 6.0, 11.0, 6.0))
    for band, (bz, bh, radial, half_len) in enumerate(shell_bands):
        for axis in range(4):
            cx, cy = ((radial, 0), (-radial, 0), (0, radial), (0, -radial))[axis]
            hx, hy = ((0.9, half_len), (0.9, half_len), (half_len, 0.9), (half_len, 0.9))[axis]
            collider(collider_collection, f"sm_shell_{band}_{axis}", (cx, cy, bz), (hx, hy, bh))
    for band, (bz, bh, radial) in enumerate(((21.5, 6.5, 19.4), (34.5, 6.5, 15.8))):
        for sx in (-1, 1):
            for sy in (-1, 1):
                collider(collider_collection, f"sm_shell_corner_{band}_{sx}_{sy}",
                         (sx * radial, sy * radial, bz), (3.6, 0.9, bh), yaw=sx * sy * (math.pi / 4))
    collider(collider_collection, "sm_nave_floor", (0, 0, FLOOR_Z - 0.06), (GLASS_HALF, GLASS_HALF, 0.12))
    collider(collider_collection, "sm_sanctuary_step", (0, 0, FLOOR_Z + 0.14), (8.6, 8.6, 0.14))
    collider(collider_collection, "sm_predella", (0, 0, FLOOR_Z + 0.25), (7.6, 7.6, 0.27))
    collider(collider_collection, "sm_altar", (0, 0, FLOOR_Z + 0.95), (1.6, 0.9, 0.5))
    collider(collider_collection, "sm_baptism_font", (0, font_y, FLOOR_Z + 0.62), (2.45, 2.45, 0.72))
    # Broad group colliders preserve the center and cross aisles between banks.
    for bank, base_angle in enumerate(PEW_BANKS):
        if base_angle == math.pi / 2:
            for side in (-1, 1):
                collider(collider_collection, f"sm_pews_{bank}_entry_{side}",
                         (side * 9.15, 19.0, FLOOR_Z + 0.55),
                         (5.75, 7.35, 0.55))
            continue
        for lane in (-1, 1):
            for wedge in range(3):
                r_mid = 21.0
                spread = math.atan2(lane * 4.6, r_mid)
                angle = base_angle + spread + (wedge - 1) * math.atan2(lane * 2.55, r_mid)
                collider(collider_collection, f"sm_pews_{bank}_{lane}_{wedge}",
                         (math.cos(angle) * r_mid, math.sin(angle) * r_mid, FLOOR_Z + 0.55),
                         (8.4, 1.15, 0.55), yaw=angle)
    collider(collider_collection, "sm_organ", (13.5, -20.5, FLOOR_Z + 2.0), (2.8, 2.5, 2.0))
    collider(collider_collection, "sm_ambo", (-4.2, 3.4, FLOOR_Z + 1.1), (0.6, 0.55, 0.65))
    collider(collider_collection, "sm_cathedra", (0, -6.2, FLOOR_Z + 1.5), (1.0, 0.9, 1.6))
    stage("colliders ready")

    # ------------------------------------------------------- preview niceties
    bpy.ops.object.light_add(type="SUN", location=(CENTER_X + 150, -CENTER_Z - 190, FLOOR + 210))
    sun = bpy.context.object
    sun.name = "Blender preview sun"
    sun.data.energy = 1.35
    sun.rotation_euler = (math.radians(35), math.radians(-12), math.radians(140))
    move_to(sun, preview)

    bpy.ops.object.light_add(type="AREA", location=root.matrix_world @ Vector((0.0, 0.0, 30.0)))
    nave_glow = bpy.context.object
    nave_glow.name = "Blender preview nave glow"
    nave_glow.data.energy = 2800
    nave_glow.data.shape = "DISK"
    nave_glow.data.size = 24
    nave_glow.data.color = (1.0, 0.74, 0.5)
    nave_glow.data.use_shadow = False
    move_to(nave_glow, preview)

    bpy.ops.object.light_add(type="AREA", location=root.matrix_world @ Vector((0.0, 25.0, 8.0)))
    sanctuary_fill = bpy.context.object
    sanctuary_fill.name = "Blender preview sanctuary fill"
    sanctuary_fill.data.energy = 2450
    sanctuary_fill.data.shape = "DISK"
    sanctuary_fill.data.size = 11
    sanctuary_fill.data.color = (1.0, 0.82, 0.62)
    sanctuary_fill.data.use_shadow = False
    sanctuary_target = root.matrix_world @ Vector((0.0, -26.0, 5.2))
    sanctuary_fill.rotation_euler = (sanctuary_target - sanctuary_fill.location).to_track_quat("-Z", "Y").to_euler()
    move_to(sanctuary_fill, preview)

    # Interior preview rig: the apex shaft plus one tinted fill per element
    # band, so opening the .blend shows the nave the way the game's god-ray
    # layer plays it. EEVEE emission alone does not light neighbors.
    bpy.ops.object.light_add(type="AREA", location=root.matrix_world @ Vector((0.0, 0.0, 50.0)))
    apex_shaft = bpy.context.object
    apex_shaft.name = "Blender preview apex shaft"
    apex_shaft.data.energy = 4200
    apex_shaft.data.shape = "DISK"
    apex_shaft.data.size = 7
    apex_shaft.data.color = (1.0, 0.88, 0.62)
    apex_shaft.data.use_shadow = False
    move_to(apex_shaft, preview)

    element_tints = {0: (1.0, 0.82, 0.35), 1: (0.42, 0.95, 0.5), 2: (1.0, 0.42, 0.3), 3: (0.4, 0.62, 1.0)}
    for quarter, tint in element_tints.items():
        lx, ly = rotate_quarter(11.5, 0.0, quarter)
        bpy.ops.object.light_add(type="AREA", location=root.matrix_world @ Vector((lx, ly, 32.0)))
        fill = bpy.context.object
        fill.name = f"Blender preview {GLASS_ELEMENTS[quarter][0]} fill"
        fill.data.energy = 1100
        fill.data.shape = "DISK"
        fill.data.size = 9
        fill.data.color = tint
        fill.data.use_shadow = False
        target_point = root.matrix_world @ Vector((0.0, 0.0, 4.0))
        fill.rotation_euler = (target_point - fill.location).to_track_quat("-Z", "Y").to_euler()
        move_to(fill, preview)
        # opposing wall wash so Nervi's coffered vault reads in the preview
        wx, wy = rotate_quarter(7.5, 0.0, quarter)
        bpy.ops.object.light_add(type="AREA", location=root.matrix_world @ Vector((wx, wy, 10.0)))
        wash = bpy.context.object
        wash.name = f"Blender preview {GLASS_ELEMENTS[quarter][0]} vault wash"
        wash.data.energy = 2650
        wash.data.shape = "DISK"
        wash.data.size = 12
        wash.data.color = (1.0, 0.9, 0.74)
        wash.data.use_shadow = False
        wash_target = root.matrix_world @ Vector((-wx * 2.2, -wy * 2.2, 42.0))
        wash.rotation_euler = (wash_target - wash.location).to_track_quat("-Z", "Y").to_euler()
        move_to(wash, preview)

    bpy.ops.object.camera_add(location=root.matrix_world @ Vector((96.0, 118.0, 6.0)))
    camera = bpy.context.object
    camera.name = "St Marys hero camera"
    move_to(camera, preview)
    target_point = root.matrix_world @ Vector((0.0, 0.0, 34.0))
    camera.rotation_euler = (target_point - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.lens = 38
    scene.camera = camera

    bpy.ops.object.camera_add(location=root.matrix_world @ Vector((0.0, 31.0, 3.4)))
    nave_camera = bpy.context.object
    nave_camera.name = "St Marys nave camera"
    interior_target = root.matrix_world @ Vector((0.0, -1.5, 8.2))
    nave_camera.rotation_euler = (interior_target - nave_camera.location).to_track_quat("-Z", "Y").to_euler()
    nave_camera.data.lens = 23
    move_to(nave_camera, preview)
    scene.camera = nave_camera
    if scene.world is None:
        scene.world = bpy.data.worlds.new("St Marys preview world")
    scene.world.color = (0.24, 0.25, 0.30)

    bpy.ops.wm.save_as_mainfile(filepath=str(output))
    print(f"[st-marys] saved {output}")


if __name__ == "__main__":
    build(parse_args())
