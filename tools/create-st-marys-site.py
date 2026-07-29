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
FLOOR = 64.6

# --- primary dimensions (meters, local frame: x east, y north, z above plaza)
PODIUM_HALF = 38.85          # 255 ft square podium
GLASS_HALF = 35.65           # curtain wall inset behind the roof overhang
PLAZA_TOP = 1.35             # raised plaza platform
FLOOR_Z = 1.5                # nave floor
GLASS_TOP = 9.0              # curtain wall head
BAND_TOP = 10.9              # travertine mezzanine band under the roof slab
ROOF_TOP = 12.4              # top of the wide fascia roof deck
CUPOLA_HALF = 20.6           # cupola base square half-width (pylon square)
SHELL_Z0 = 15.0              # shell base — floats on the clerestory band
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
    """Nervi's triangular precast coffers for the shell interior."""
    size = 1024
    period, row = 128, 64
    x = np.arange(size)[None, :]
    y = np.arange(size)[:, None]
    img = np.ones((size, size, 4), dtype=np.float32)
    cell = ((y // row) * 977 + ((x + y) // period) * 331 + ((x - y) // period) * 173) % 17
    img[..., :3] = (0.615 + cell[..., None] * 0.004)
    ribs = ((x + y) % period < 5) | ((x - y) % period < 5) | (y % row < 4)
    img[np.broadcast_to(ribs, (size, size)), :3] = 0.40
    depth = np.minimum((x + y) % period, np.minimum((x - y) % period, y % row)) / 24.0
    img[..., :3] *= (0.86 + 0.14 * np.clip(depth, 0, 1))[..., None]
    img[..., :3] = np.clip(img[..., :3], 0.0, 1.0)
    img[..., 3] = 1.0
    return img


def stained_glass_pixels():
    """The dalle-de-verre journey: earth reds through fire to sky blues."""
    width, height = 128, 1024
    rng = np.random.default_rng(3)
    img = np.ones((height, width, 4), dtype=np.float32)
    yy = np.arange(height)[:, None] / height
    stops = np.array([
        [0.30, 0.10, 0.06],
        [0.62, 0.15, 0.07],
        [0.86, 0.42, 0.10],
        [0.74, 0.62, 0.22],
        [0.22, 0.40, 0.64],
        [0.10, 0.19, 0.50],
    ])
    seg = (yy[:, 0] * (len(stops) - 1))
    idx = np.clip(seg.astype(int), 0, len(stops) - 2)
    frac = (seg - idx)[:, None]
    cols = stops[idx] * (1 - frac) + stops[idx + 1] * frac
    img[..., :3] = cols[:, None, :]
    img[..., :3] += rng.normal(0.0, 0.02, (height, width, 1))
    for k in range(0, height, 26):
        img[k : k + 2, :, :3] *= 0.24
    for k in (0, 41, 84, 126):
        img[:, k : k + 2, :3] *= 0.24
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


def add_box(target, root, name, center, half, mat, taper=1.0, yaw=0.0, uv_scale=None):
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
        def uvs(vertex_index, vs, scale=uv_scale):
            x, y, z = vs[vertex_index]
            return ((x + y) / scale, z / scale)
    return mesh_object(target, root, name, verts, faces, mat, uvs=uvs)


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

def seam_profile(t, half=CUPOLA_HALF, arm=ARM_HALF, z0=SHELL_Z0, z1=ARM_TIP_Z):
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


def shell_surface_verts(half, arm, z0, z1_seam, z1_corner):
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
                sx, sz = seam_profile(t, half, arm, z0, z1_seam)
                cr, cz = corner_profile(t, half, z0, z1_corner)
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
    verts, grids = shell_surface_verts(CUPOLA_HALF, ARM_HALF, SHELL_Z0, ARM_TIP_Z, SHELL_TOP)
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

    # inner coffered surface (reversed winding), slightly inset
    iverts, igrids = shell_surface_verts(
        CUPOLA_HALF - SHELL_T, ARM_HALF - 0.45, SHELL_Z0, ARM_TIP_Z - 0.5, SHELL_TOP - 0.5
    )
    ifaces = []
    for grid, mirror in igrids:
        for it in range(SEG_T):
            for iu in range(SEG_U):
                quad = (grid[it][iu], grid[it][iu + 1], grid[it + 1][iu + 1], grid[it + 1][iu])
                ifaces.append(quad[::-1] if mirror < 0 else quad)

    def coffer_uv(vertex_index, vs):
        x, y, z = vs[vertex_index]
        return ((abs(x) + abs(y)) / 17.0, z / 17.0)

    mesh_object(target, root, "cupola_coffered_interior", iverts, ifaces, mat_in, uvs=coffer_uv, smooth=True)

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
                row_out.append(len(rim_verts)); rim_verts.append((xo, yo2, SHELL_Z0))
                row_in.append(len(rim_verts)); rim_verts.append((xi, yi2, SHELL_Z0))
            for iu in range(SEG_U):
                quad = (row_out[iu], row_out[iu + 1], row_in[iu + 1], row_in[iu])
                rim_faces.append(quad if mirror < 0 else quad[::-1])
    mesh_object(target, root, "cupola_base_rim", rim_verts, rim_faces, mat_out)
    return outer


def build_glass_cross(target, root, mat):
    """One continuous ribbon per compass point: up the face seam, folding over
    the arm tip, running the ridge skylight to the centre — the bold cross."""
    verts = []
    faces = []
    uv_data = {}

    def ribbon(points_a, points_b, v_values, quarter):
        start = len(verts)
        for i, (pa, pb) in enumerate(zip(points_a, points_b)):
            for point, u in ((pa, 0.05), (pb, 0.95)):
                x, y = rotate_quarter(point[0], point[1], quarter)
                uv_data[len(verts)] = (u, v_values[i])
                verts.append((x, y, point[2]))
        for i in range(len(points_a) - 1):
            a = start + i * 2
            faces.append((a, a + 1, a + 3, a + 2))

    # path: face seam (recessed) -> over the tip -> ridge to centre
    for quarter in range(4):
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
        ribbon(pa, pb, vv, quarter)

    # centre cap where the four ribbons meet, carrying the cross plinth
    start = len(verts)
    for dx, dy in ((-GLASS_HW, -GLASS_HW), (GLASS_HW, -GLASS_HW), (GLASS_HW, GLASS_HW), (-GLASS_HW, GLASS_HW)):
        uv_data[len(verts)] = (0.5, 0.995)
        verts.append((dx, dy, SHELL_TOP + 0.07))
    faces.append((start, start + 1, start + 2, start + 3))

    def uvs(vertex_index, _vs):
        return uv_data[vertex_index]

    return mesh_object(target, root, "stained_glass_cross", verts, faces, mat, uvs=uvs)


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
    stained_img = write_image(textures / "stained-glass.png", "st-marys dalle de verre", stained_glass_pixels())

    travertine = textured_material("St Mary travertine panels", travertine_img, 0.86)
    coffer = textured_material("Nervi triangular coffers", coffer_img, 0.94)
    stained = textured_material("Dalle de verre light bands", stained_img, 0.26, emission_strength=0.62)
    white_slab = material("Precast fascia white", (0.84, 0.825, 0.79), 0.82)
    step_stone = material("Plaza step stone", (0.74, 0.72, 0.68), 0.9)
    brick = material("Mission red brick", (0.472, 0.253, 0.185), 0.93)
    dark_glass = material("Podium glazing", (0.045, 0.055, 0.075), 0.09, 0.55,
                          emission=(0.82, 0.62, 0.36), emission_strength=0.26)
    bronze = material("Bronze mullion", (0.16, 0.125, 0.09), 0.5, 0.42)
    gold = material("Golden cross", (0.85, 0.65, 0.22), 0.3, 1.0, (0.9, 0.62, 0.15), 0.12)
    marble = material("Sanctuary marble", (0.86, 0.85, 0.83), 0.55)
    wood = material("Walnut pews", (0.21, 0.11, 0.06), 0.6)
    stage("materials ready")

    # ------------------------------------------------------------------ plaza
    add_box(exterior, root, "plaza_platform", (1.0, 4.0, PLAZA_TOP / 2), (45.0, 50.0, PLAZA_TOP / 2), brick)
    add_box(exterior, root, "plaza_step_mid", (1.0, 4.0, 0.45), (46.5, 51.5, 0.45), step_stone)
    add_box(exterior, root, "plaza_step_low", (1.0, 4.0, 0.225), (48.0, 53.0, 0.225), step_stone)
    for step in range(3):
        add_box(exterior, root, f"geary_stair_{step}",
                (0.0, 54.6 + step * 1.5, (PLAZA_TOP - step * 0.45) / 2),
                (15.0, 0.75, (PLAZA_TOP - step * 0.45) / 2), step_stone)
    stage("plaza ready")

    # ----------------------------------------------------------------- podium
    add_box(exterior, root, "roof_deck", (0, 0, (ROOF_TOP + BAND_TOP) / 2),
            (PODIUM_HALF, PODIUM_HALF, (ROOF_TOP - BAND_TOP) / 2), white_slab)
    add_box(exterior, root, "mezzanine_band", (0, 0, (BAND_TOP + GLASS_TOP) / 2),
            (GLASS_HALF + 0.45, GLASS_HALF + 0.45, (BAND_TOP - GLASS_TOP) / 2), travertine, uv_scale=12.4)
    add_box(exterior, root, "curtain_glass", (0, 0, (GLASS_TOP + PLAZA_TOP) / 2),
            (GLASS_HALF, GLASS_HALF, (GLASS_TOP - PLAZA_TOP) / 2), dark_glass)

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
    add_box(exterior, root, "clerestory_band", (0, 0, (SHELL_Z0 + ROOF_TOP) / 2),
            (CUPOLA_HALF - 0.8, CUPOLA_HALF - 0.8, (SHELL_Z0 - ROOF_TOP) / 2 + 0.08), dark_glass)
    for sx in (-1, 1):
        for sy in (-1, 1):
            add_box(exterior, root, f"pylon_{sx}_{sy}", (sx * 18.5, sy * 18.5, (15.6 + FLOOR_Z) / 2),
                    (2.5, 2.5, (15.6 - FLOOR_Z) / 2), travertine, taper=0.8, uv_scale=12.4)
    stage("clerestory ready")

    # ----------------------------------------------------------- cupola shell
    build_shell(cupola, root, travertine, coffer)
    build_glass_cross(glass, root, stained)
    add_box(exterior, root, "summit_cross", (0, 0, SHELL_TOP + 0.14 + CROSS_H / 2),
            (0.31, 0.31, CROSS_H / 2), gold)
    add_box(exterior, root, "summit_cross_arm", (0, 0, SHELL_TOP + 0.14 + CROSS_H * 0.68),
            (3.7, 0.31, 0.31), gold)
    stage("cupola ready")

    # ---------------------------------------------------------------- interior
    add_box(interior, root, "nave_floor", (0, 0, FLOOR_Z - 0.05), (GLASS_HALF, GLASS_HALF, 0.05), brick)
    add_box(furniture, root, "sanctuary_predella", (0, 0, FLOOR_Z + 0.25), (7.6, 7.6, 0.25), marble)
    add_box(furniture, root, "high_altar", (0, 0, FLOOR_Z + 0.5 + 0.48), (1.55, 0.85, 0.48), marble)
    pew_seat = add_box(furniture, root, "pew_seed", (0, 0, FLOOR_Z + 0.42), (2.6, 0.24, 0.06), wood)
    pew_back = add_box(furniture, root, "pew_seed_back", (0, 0.28, FLOOR_Z + 0.7), (2.6, 0.06, 0.34), wood)
    banks = ((0.0, (0, 1)), (math.pi / 2, (1, 0)), (-math.pi / 2, (-1, 0)), (math.pi, (0, -1)))
    for yaw_bank, (dx, dy) in banks[:3]:
        for row in range(9):
            r = 12.5 + row * 2.05
            for lane in (-1, 1):
                off_x, off_y = -dy * lane * 3.4, dx * lane * 3.4
                duplicate_linked(pew_seat, furniture, root, f"pew_{dx}_{dy}_{row}_{lane}",
                                 (dx * r + off_x, dy * r + off_y, 0), yaw_bank)
                duplicate_linked(pew_back, furniture, root, f"pewback_{dx}_{dy}_{row}_{lane}",
                                 (dx * (r + 0.55) + off_x, dy * (r + 0.55) + off_y, 0), yaw_bank)
    for seed in (pew_seat, pew_back):
        seed.hide_render = True
        seed.hide_viewport = True

    add_box(furniture, root, "organ_pedestal", (14.5, -21.0, FLOOR_Z + 1.5), (2.3, 1.9, 1.5), white_slab)
    for rank in range(15):
        height = 2.6 + 5.4 * (1 - abs(rank - 7) / 8)
        add_box(furniture, root, f"organ_pipe_{rank}", (12.6 + rank * 0.28, -21.0 + (rank % 2) * 0.5, FLOOR_Z + 3.0 + height / 2),
                (0.13, 0.13, height / 2), gold)
    stage("interior ready")

    # ---------------------------------------------------------------- colliders
    collider(collider_collection, "sm_plaza", (1, 4, 0.7), (45.0, 50.0, 0.7))
    collider(collider_collection, "sm_steps_n", (1, 56.0, 0.45), (46.5, 2.6, 0.45))
    collider(collider_collection, "sm_steps_s", (1, -48.0, 0.45), (46.5, 2.6, 0.45))
    collider(collider_collection, "sm_steps_e", (49.0, 4, 0.45), (2.6, 52.0, 0.45))
    collider(collider_collection, "sm_steps_w", (-47.0, 4, 0.45), (2.6, 52.0, 0.45))
    collider(collider_collection, "sm_stair_geary", (0, 56.4, 0.65), (15.2, 3.0, 0.65))
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
    collider(collider_collection, "sm_roof_deck", (0, 0, (ROOF_TOP + BAND_TOP) / 2),
             (PODIUM_HALF, PODIUM_HALF, (ROOF_TOP - BAND_TOP) / 2))
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
    collider(collider_collection, "sm_predella", (0, 0, FLOOR_Z + 0.25), (7.6, 7.6, 0.27))
    collider(collider_collection, "sm_altar", (0, 0, FLOOR_Z + 0.95), (1.6, 0.9, 0.5))
    collider(collider_collection, "sm_pews_w", (-21.5, 0, FLOOR_Z + 0.55), (9.6, 6.4, 0.55))
    collider(collider_collection, "sm_pews_n", (0, 21.5, FLOOR_Z + 0.55), (6.4, 9.6, 0.55))
    collider(collider_collection, "sm_pews_e", (21.5, 0, FLOOR_Z + 0.55), (9.6, 6.4, 0.55))
    collider(collider_collection, "sm_organ", (14.5, -21.0, FLOOR_Z + 1.5), (2.4, 2.0, 1.5))
    stage("colliders ready")

    # ------------------------------------------------------- preview niceties
    bpy.ops.object.light_add(type="SUN", location=(CENTER_X + 150, -CENTER_Z - 190, FLOOR + 210))
    sun = bpy.context.object
    sun.name = "Blender preview sun"
    sun.data.energy = 2.4
    sun.rotation_euler = (math.radians(35), math.radians(-12), math.radians(140))
    move_to(sun, preview)

    bpy.ops.object.light_add(type="AREA", location=root.matrix_world @ Vector((0.0, 0.0, 30.0)))
    nave_glow = bpy.context.object
    nave_glow.name = "Blender preview nave glow"
    nave_glow.data.energy = 52000
    nave_glow.data.shape = "DISK"
    nave_glow.data.size = 24
    nave_glow.data.color = (1.0, 0.74, 0.5)
    move_to(nave_glow, preview)

    bpy.ops.object.camera_add(location=root.matrix_world @ Vector((96.0, 118.0, 6.0)))
    camera = bpy.context.object
    camera.name = "St Marys hero camera"
    move_to(camera, preview)
    target_point = root.matrix_world @ Vector((0.0, 0.0, 34.0))
    camera.rotation_euler = (target_point - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.lens = 38
    scene.camera = camera

    bpy.ops.object.camera_add(location=root.matrix_world @ Vector((0.0, 26.0, 3.4)))
    nave_camera = bpy.context.object
    nave_camera.name = "St Marys nave camera"
    interior_target = root.matrix_world @ Vector((0.0, 0.0, 24.0))
    nave_camera.rotation_euler = (interior_target - nave_camera.location).to_track_quat("-Z", "Y").to_euler()
    nave_camera.data.lens = 21
    move_to(nave_camera, preview)
    if scene.world is None:
        scene.world = bpy.data.worlds.new("St Marys preview world")
    scene.world.color = (0.05, 0.07, 0.11)

    bpy.ops.wm.save_as_mainfile(filepath=str(output))
    print(f"[st-marys] saved {output}")


if __name__ == "__main__":
    build(parse_args())
