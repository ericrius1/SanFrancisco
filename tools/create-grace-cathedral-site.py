"""Build the independently editable Grace Cathedral authored Blender project.

The model is intentionally authored at real-world scale and world placement.
It is detailed enough to read as Grace Cathedral from Nob Hill and to support a
walkable nave, but it keeps repeated architectural pieces linked so the GLB is
reasonable for a proximity-streamed WebGPU landmark.
"""

from __future__ import annotations

import argparse
import math
import os
import sys
from pathlib import Path

import bpy
from mathutils import Vector


SITE_ID = "grace-cathedral"
TILE = "12_10"
CENTER_X = 2687.5
CENTER_Z = -205.2
YAW = 0.153
FLOOR = 94.0


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
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)


def collection(parent, name, hidden=False):
    result = bpy.data.collections.new(name)
    parent.children.link(result)
    result.hide_render = hidden
    # Authoring guides must stay in the evaluated view layer for the headless
    # exporter to read their matrix_world transforms.  hide_render keeps them
    # out of beauty renders and GLB selection without collapsing those matrices
    # to identity during a background bake.
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


def glass_material(name, color_path, normal_path, emission_strength):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = (0.08, 0.16, 0.55, 1.0)
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = 0.22
    bsdf.inputs["Metallic"].default_value = 0.08
    bsdf.inputs["IOR"].default_value = 1.48
    bsdf.inputs["Coat Weight"].default_value = 0.24
    bsdf.inputs["Coat Roughness"].default_value = 0.12

    color = mat.node_tree.nodes.new("ShaderNodeTexImage")
    color.name = "Original stained-glass color"
    color.image = bpy.data.images.load(str(color_path), check_existing=True)
    color.image.colorspace_settings.name = "sRGB"
    normal = mat.node_tree.nodes.new("ShaderNodeTexImage")
    normal.name = "Raised lead and faceted glass normal"
    normal.image = bpy.data.images.load(str(normal_path), check_existing=True)
    normal.image.colorspace_settings.name = "Non-Color"
    normal_map = mat.node_tree.nodes.new("ShaderNodeNormalMap")
    normal_map.inputs["Strength"].default_value = 0.68
    mat.node_tree.links.new(color.outputs["Color"], bsdf.inputs["Base Color"])
    mat.node_tree.links.new(color.outputs["Color"], bsdf.inputs["Emission Color"])
    mat.node_tree.links.new(normal.outputs["Color"], normal_map.inputs["Color"])
    mat.node_tree.links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


def add_box(target, root, name, location, scale, mat, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    move_to(obj, target)
    obj.parent = root
    obj.data.materials.append(mat)
    if bevel > 0:
        modifier = obj.modifiers.new("subtle cast-stone edge", "BEVEL")
        modifier.width = bevel
        modifier.segments = 2
    return tag(obj)


def add_cylinder(target, root, name, location, radius, depth, mat, vertices=12, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices, radius=radius, depth=depth, location=location, rotation=rotation
    )
    obj = bpy.context.object
    obj.name = name
    move_to(obj, target)
    obj.parent = root
    obj.data.materials.append(mat)
    return tag(obj)


def add_cone(target, root, name, location, radius1, radius2, depth, mat, vertices=12):
    bpy.ops.mesh.primitive_cone_add(
        vertices=vertices, radius1=radius1, radius2=radius2, depth=depth, location=location
    )
    obj = bpy.context.object
    obj.name = name
    move_to(obj, target)
    obj.parent = root
    obj.data.materials.append(mat)
    return tag(obj)


def add_polyline(target, root, name, points, radius, mat, cyclic=False):
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = 1
    curve.bevel_depth = radius
    curve.bevel_resolution = 2
    spline = curve.splines.new("POLY")
    spline.points.add(len(points) - 1)
    for slot, point in zip(spline.points, points):
        slot.co = (*point, 1.0)
    spline.use_cyclic_u = cyclic
    obj = bpy.data.objects.new(name, curve)
    target.objects.link(obj)
    obj.parent = root
    obj.data.materials.append(mat)
    return tag(obj)


def quadratic_points(a, control, b, count=12):
    result = []
    for index in range(count + 1):
        t = index / count
        u = 1 - t
        result.append(
            (
                u * u * a[0] + 2 * u * t * control[0] + t * t * b[0],
                u * u * a[1] + 2 * u * t * control[1] + t * t * b[1],
                u * u * a[2] + 2 * u * t * control[2] + t * t * b[2],
            )
        )
    return result


def add_gabled_roof(target, root, name, center, length, width, eave_z, ridge_z, mat, along_x=True):
    half_l = length / 2
    half_w = width / 2
    if along_x:
        verts = [
            (-half_l, -half_w, eave_z), (half_l, -half_w, eave_z),
            (-half_l, half_w, eave_z), (half_l, half_w, eave_z),
            (-half_l, 0, ridge_z), (half_l, 0, ridge_z),
        ]
        faces = [(0, 1, 5, 4), (2, 4, 5, 3), (0, 4, 2), (1, 3, 5)]
    else:
        verts = [
            (-half_w, -half_l, eave_z), (-half_w, half_l, eave_z),
            (half_w, -half_l, eave_z), (half_w, half_l, eave_z),
            (0, -half_l, ridge_z), (0, half_l, ridge_z),
        ]
        faces = [(0, 4, 5, 1), (2, 3, 5, 4), (0, 2, 4), (1, 5, 3)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = center
    target.objects.link(obj)
    obj.parent = root
    obj.data.materials.append(mat)
    return tag(obj)


def pointed_outline(width, height, spring, steps=8):
    points = [(-width / 2, 0), (width / 2, 0), (width / 2, spring)]
    for index in range(1, steps + 1):
        t = index / steps
        u = 1 - t
        points.append((u * u * width / 2, spring + (height - spring) * (2 * t - t * t)))
    for index in range(steps - 1, -1, -1):
        t = index / steps
        u = 1 - t
        points.append((-u * u * width / 2, spring + (height - spring) * (2 * t - t * t)))
    return points


def add_pointed_panel(target, root, name, location, width, height, spring, depth, mat, rotation_z=0.0):
    outline = pointed_outline(width, height, spring)
    count = len(outline)
    verts = [(x, -depth / 2, z) for x, z in outline] + [(x, depth / 2, z) for x, z in outline]
    faces = [tuple(range(count)), tuple(range(count, count * 2))[::-1]]
    for index in range(count):
        nxt = (index + 1) % count
        faces.append((index, nxt, count + nxt, count + index))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    uv = mesh.uv_layers.new(name="UVMap")
    for polygon in mesh.polygons:
        for loop_index in polygon.loop_indices:
            vertex_index = mesh.loops[loop_index].vertex_index % count
            x, z = outline[vertex_index]
            uv.data[loop_index].uv = (x / width + 0.5, z / height)
    obj = bpy.data.objects.new(name, mesh)
    obj.location = location
    obj.rotation_euler[2] = rotation_z
    target.objects.link(obj)
    obj.parent = root
    obj.data.materials.append(mat)
    return tag(obj)


def add_torus(target, root, name, location, major_radius, minor_radius, mat, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major_radius,
        minor_radius=minor_radius,
        major_segments=64,
        minor_segments=8,
        location=location,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    move_to(obj, target)
    obj.parent = root
    obj.data.materials.append(mat)
    return tag(obj)


def duplicate_linked(source, target, root, name, location, rotation=(0, 0, 0)):
    obj = bpy.data.objects.new(name, source.data)
    obj.location = location
    obj.rotation_euler = rotation
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


def build(args):
    def stage(label):
        print(f"[grace-cathedral] {label}", flush=True)

    repo = Path(args.repo).resolve()
    project_dir = repo / "assets-src/world/sites/grace-cathedral"
    textures = project_dir / "textures"
    output = project_dir / "grace-cathedral.blend"
    required = [
        textures / "rose-window.jpg",
        textures / "rose-window-normal.jpg",
        textures / "angel-lancet.jpg",
        textures / "angel-lancet-normal.jpg",
    ]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise RuntimeError(f"Build the Grace Cathedral textures first: {missing}")

    clean_scene()
    scene = bpy.context.scene
    scene["sf_authoring_schema"] = 2
    scene["sf_region"] = SITE_ID
    scene["sf_tile"] = TILE
    scene["sf_architecture_reference"] = "Grace Cathedral official architecture and treasures pages"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1000
    scene.render.resolution_percentage = 60

    site = bpy.data.collections.new("SITE_grace_cathedral")
    scene.collection.children.link(site)
    visual = collection(site, "VISUAL")
    exterior = collection(visual, "ARCHITECTURE_EXTERIOR")
    interior = collection(visual, "ARCHITECTURE_INTERIOR")
    glass = collection(visual, "STAINED_GLASS")
    furniture = collection(visual, "FURNISHINGS")
    collider_collection = collection(site, "COLLIDERS", hidden=True)
    collection(site, "AUTHORING", hidden=True)
    collection(site, "TERRAIN_OWNERSHIP", hidden=True)
    preview = collection(site, "BLENDER_PREVIEW_ONLY")

    root = bpy.data.objects.new("grace_cathedral_authored_landmark", None)
    visual.objects.link(root)
    root.location = (CENTER_X, -CENTER_Z, FLOOR)
    root.rotation_euler[2] = YAW
    tag(root)

    cast_stone = material("Grace cast stone", (0.49, 0.47, 0.43), 0.82)
    pale_stone = material("Grace interior stone", (0.64, 0.61, 0.55), 0.76)
    vault_tile = material("Guastavino acoustic tile", (0.72, 0.68, 0.6), 0.88)
    roof = material("Lead coated copper roof", (0.10, 0.13, 0.14), 0.58, 0.34)
    shadow = material("Deep architectural shadow", (0.012, 0.018, 0.024), 0.95)
    bronze = material("Ghiberti warm bronze", (0.36, 0.19, 0.055), 0.32, 0.72)
    gold = material("Sanctuary gold", (0.72, 0.45, 0.08), 0.27, 0.65, (0.8, 0.37, 0.05), 0.2)
    wood = material("Dark oak pews", (0.18, 0.065, 0.028), 0.56)
    labyrinth_mat = material("Chartres labyrinth inlay", (0.10, 0.13, 0.15), 0.42, 0.18)
    rose_glass = glass_material(
        "Canticle rose · original faceted glass",
        textures / "rose-window.jpg",
        textures / "rose-window-normal.jpg",
        0.72,
    )
    lancet_glass = glass_material(
        "Connick blue angel · original leaded glass",
        textures / "angel-lancet.jpg",
        textures / "angel-lancet-normal.jpg",
        0.58,
    )
    stage("materials ready")

    # Foundation and primary cruciform massing: 100 m long, 49 m at transepts.
    add_box(exterior, root, "foundation", (0, 0, -2.15), (51.0, 15.0, 2.15), cast_stone, 0.18)
    add_box(interior, root, "walkable_nave_floor", (2.0, 0, 0.1), (49.0, 14.0, 0.1), pale_stone)
    add_box(interior, root, "transept_floor", (-17.0, 0, 0.12), (8.5, 24.0, 0.12), pale_stone)

    # Exterior side aisles, nave clerestory, choir and transept arms.
    add_box(exterior, root, "north_aisle_wall", (8.0, 13.7, 8.0), (41.0, 0.55, 8.0), cast_stone, 0.12)
    add_box(exterior, root, "south_aisle_wall", (8.0, -13.7, 8.0), (41.0, 0.55, 8.0), cast_stone, 0.12)
    add_box(exterior, root, "north_clerestory", (2.0, 7.25, 20.5), (47.0, 0.55, 7.5), cast_stone, 0.12)
    add_box(exterior, root, "south_clerestory", (2.0, -7.25, 20.5), (47.0, 0.55, 7.5), cast_stone, 0.12)
    add_box(exterior, root, "north_transept", (-17.0, 18.0, 13.0), (8.5, 6.5, 13.0), cast_stone, 0.16)
    add_box(exterior, root, "south_transept", (-17.0, -18.0, 13.0), (8.5, 6.5, 13.0), cast_stone, 0.16)
    add_box(exterior, root, "choir_mass", (-37.0, 0, 13.2), (12.0, 7.5, 13.2), cast_stone, 0.15)

    add_gabled_roof(exterior, root, "nave_roof", (2.0, 0, 0), 94.0, 16.0, 25.8, 31.5, roof)
    add_gabled_roof(exterior, root, "north_aisle_roof", (8.0, 10.5, 0), 82.0, 7.0, 15.8, 18.0, roof)
    add_gabled_roof(exterior, root, "south_aisle_roof", (8.0, -10.5, 0), 82.0, 7.0, 15.8, 18.0, roof)
    add_gabled_roof(exterior, root, "transept_roof", (-17.0, 0, 0), 48.0, 17.0, 25.5, 31.0, roof, along_x=False)
    add_gabled_roof(exterior, root, "choir_roof", (-39.0, 0, 0), 22.0, 16.0, 25.8, 30.2, roof)
    stage("primary massing ready")

    # Polygonal apse in five stone facets.
    apse_center_x = -48.0
    apse_radius = 8.0
    for index, angle in enumerate([math.radians(v) for v in (-72, -36, 0, 36, 72)]):
        x = apse_center_x - math.cos(angle) * apse_radius
        y = math.sin(angle) * apse_radius
        wall = add_box(
            exterior, root, f"apse_facet_{index}", (x, y, 13.0), (2.55, 0.5, 13.0), cast_stone, 0.12
        )
        wall.rotation_euler[2] = angle + math.pi / 2

    # East façade: open central portal, twin 53 m towers and rose-window gable.
    for side in (-1, 1):
        y = side * 9.6
        add_box(exterior, root, f"facade_tower_{side}", (48.0, y, 25.8), (5.7, 5.7, 25.8), cast_stone, 0.18)
        for corner_y in (-4.9, 4.9):
            add_box(
                exterior,
                root,
                f"tower_pier_{side}_{corner_y}",
                (53.1, y + corner_y, 25.4),
                (0.9, 0.7, 25.4),
                pale_stone,
                0.1,
            )
        for belfry_y in (-1.8, 1.8):
            add_pointed_panel(
                exterior,
                root,
                f"tower_belfry_{side}_{belfry_y}",
                (53.75, y + belfry_y, 35.0),
                2.5,
                9.0,
                5.2,
                0.10,
                shadow,
                math.pi / 2,
            )
        for merlon in range(-2, 3):
            add_box(exterior, root, f"tower_merlon_{side}_{merlon}", (48.0, y + merlon * 2.2, 53.1), (5.8, 0.55, 0.8), cast_stone)

    add_box(exterior, root, "facade_left_of_portal", (50.1, 6.5, 13.0), (1.0, 4.0, 13.0), cast_stone, 0.12)
    add_box(exterior, root, "facade_right_of_portal", (50.1, -6.5, 13.0), (1.0, 4.0, 13.0), cast_stone, 0.12)
    add_box(exterior, root, "facade_over_portal", (50.1, 0, 20.0), (1.0, 3.0, 6.0), cast_stone, 0.12)
    add_pointed_panel(exterior, root, "portal_shadow", (51.15, 0, 0.2), 6.1, 12.6, 7.0, 0.12, shadow, math.pi / 2)
    # Open bronze leaves preserve a walkable center gap and read as the Doors of Paradise.
    for side in (-1, 1):
        door = add_box(exterior, root, f"door_of_paradise_{side}", (51.35, side * 2.9, 4.0), (0.16, 2.7, 4.0), bronze, 0.08)
        door.rotation_euler[2] = -side * 0.30
        for row in range(5):
            for col in range(2):
                add_box(
                    exterior,
                    root,
                    f"ghiberti_relief_{side}_{row}_{col}",
                    (51.52, side * (1.25 + col * 1.2), 0.85 + row * 1.45),
                    (0.05, 0.48, 0.54),
                    gold,
                    0.04,
                )

    # The original generated rose is a real PBR surface: base/emission texture + lead normal.
    rose_front = add_cylinder(
        glass, root, "east_rose_window", (51.22, 0, 29.0), 4.7, 0.12, rose_glass, 64, (0, math.pi / 2, 0)
    )
    add_torus(glass, root, "east_rose_tracery", (51.30, 0, 29.0), 4.9, 0.36, cast_stone, (0, math.pi / 2, 0))
    duplicate_linked(rose_front, glass, root, "east_rose_window_interior", (49.02, 0, 29.0), (0, math.pi / 2, 0))
    stage("facade ready")

    # Central flèche rises to 75 m above the adjacent street, as in the real silhouette.
    add_box(exterior, root, "crossing_lantern", (-17.0, 0, 34.0), (4.5, 4.5, 5.0), cast_stone, 0.16)
    add_cone(exterior, root, "central_fleche", (-17.0, 0, 55.5), 4.4, 0.28, 35.0, roof, 12)
    add_cylinder(exterior, root, "fleche_cross_vertical", (-17.0, 0, 74.0), 0.12, 3.4, gold, 10)
    crossbar = add_cylinder(exterior, root, "fleche_cross_horizontal", (-17.0, 0, 73.8), 0.12, 2.2, gold, 10, (0, math.pi / 2, 0))

    # Buttress rhythm and flying arches make the exterior unmistakably Gothic.
    bay_x = [38, 31, 24, 17, 10, 3, -4, -11, -23, -30, -37, -44]
    for side in (-1, 1):
        for index, x in enumerate(bay_x):
            add_box(exterior, root, f"buttress_pier_{side}_{index}", (x, side * 15.5, 8.2), (0.75, 1.35, 8.2), cast_stone, 0.10)
            start = (x, side * 7.7, 23.2)
            end = (x, side * 15.5, 13.8)
            control = (x, side * 12.6, 22.5)
            add_polyline(
                exterior,
                root,
                f"flying_buttress_{side}_{index}",
                quadratic_points(start, control, end, 9),
                0.34,
                cast_stone,
            )
            add_cone(exterior, root, f"buttress_pinnacle_{side}_{index}", (x, side * 15.5, 18.5), 0.72, 0.08, 4.2, cast_stone, 8)
    stage("buttresses ready")

    # Clerestory glass: linked repeated geometry keeps both Blender and GLB sane.
    window_positions = [38, 31, 24, 17, 10, 3, -4, -11, -29, -36, -43]
    window_sources = {}
    for side in (-1, 1):
        for index, x in enumerate(window_positions):
            # Slight alternating offsets keep a repeated plate from feeling tiled.
            panel = add_pointed_panel(
                glass,
                root,
                f"clerestory_glass_{side}_{index}",
                (x, side * 6.65, 15.7),
                3.8,
                9.2,
                5.3,
                0.10,
                lancet_glass,
                math.pi if side > 0 else 0,
            )
            panel.scale.x = -1 if (index + (1 if side > 0 else 0)) % 2 else 1
            add_pointed_panel(
                glass,
                root,
                f"clerestory_shadow_frame_{side}_{index}",
                (x, side * 6.76, 15.35),
                4.45,
                10.0,
                5.7,
                0.08,
                shadow,
                math.pi if side > 0 else 0,
            )
    stage("stained glass ready")

    # Interior narrow piers, pointed arcades and a readable rib-vault system.
    arcade_x = [43, 36, 29, 22, 15, 8, 1, -6, -13, -21, -29, -37, -45]
    for index, x in enumerate(arcade_x):
        for side in (-1, 1):
            add_cylinder(interior, root, f"nave_pier_{side}_{index}", (x, side * 7.0, 9.1), 0.62, 18.2, pale_stone, 12)
            add_cylinder(interior, root, f"nave_capital_{side}_{index}", (x, side * 7.0, 18.4), 0.95, 0.7, cast_stone, 12)
        arch_points = quadratic_points((x, -7.0, 18.5), (x, 0, 31.0), (x, 7.0, 18.5), 16)
        add_polyline(interior, root, f"transverse_vault_rib_{index}", arch_points, 0.20, vault_tile)
        if index < len(arcade_x) - 1:
            next_x = arcade_x[index + 1]
            mid_x = (x + next_x) / 2
            for side in (-1, 1):
                side_arch = quadratic_points((x, side * 7.0, 18.4), (mid_x, side * 7.0, 25.2), (next_x, side * 7.0, 18.4), 10)
                add_polyline(interior, root, f"arcade_arch_{side}_{index}", side_arch, 0.24, pale_stone)
            # Four diagonal ribs meet at each bay crown.
            for side in (-1, 1):
                diag = quadratic_points((x, side * 7.0, 18.5), (mid_x, side * 3.0, 28.2), (mid_x, 0, 28.0), 8)
                add_polyline(interior, root, f"diagonal_rib_a_{side}_{index}", diag, 0.13, vault_tile)
                diag_b = quadratic_points((next_x, side * 7.0, 18.5), (mid_x, side * 3.0, 28.2), (mid_x, 0, 28.0), 8)
                add_polyline(interior, root, f"diagonal_rib_b_{side}_{index}", diag_b, 0.13, vault_tile)
    add_polyline(interior, root, "nave_ridge_rib", [(46, 0, 28.0), (-48, 0, 28.0)], 0.16, vault_tile)
    stage("nave vault ready")

    # Pews use one linked mesh datablock for all 40 benches.
    pew_seed = add_box(furniture, root, "pew_seed", (0, 0, 1.0), (2.75, 0.35, 0.12), wood, 0.08)
    pew_back_seed = add_box(furniture, root, "pew_seed_back", (0, 0.35, 1.65), (2.75, 0.11, 0.65), wood, 0.07)
    for row in range(20):
        x = 39.0 - row * 3.15
        for side in (-1, 1):
            duplicate_linked(pew_seed, furniture, root, f"pew_seat_{side}_{row}", (x, side * 3.85, 1.0))
            duplicate_linked(pew_back_seed, furniture, root, f"pew_back_{side}_{row}", (x - 0.36, side * 4.18, 1.65))
    pew_seed.hide_render = True
    pew_seed.hide_viewport = True
    pew_back_seed.hide_render = True
    pew_back_seed.hide_viewport = True
    stage("pews ready")

    # Chartres-inspired floor labyrinth, altar, choir and organ.
    labyrinth_center = (28.0, 0.0, 0.24)
    for ring in range(1, 8):
        radius = ring * 0.58
        points = [
            (labyrinth_center[0] + math.cos(i * math.tau / 96) * radius,
             labyrinth_center[1] + math.sin(i * math.tau / 96) * radius,
             labyrinth_center[2])
            for i in range(96)
        ]
        add_polyline(furniture, root, f"labyrinth_ring_{ring}", points, 0.055, labyrinth_mat, cyclic=True)
    for turn_index, angle in enumerate((0, math.pi / 2, math.pi, 3 * math.pi / 2)):
        points = []
        for index in range(16):
            radius = 0.45 + index * 0.25
            a = angle + math.sin(index * math.pi / 2) * 0.18
            points.append((28 + math.cos(a) * radius, math.sin(a) * radius, 0.24))
        add_polyline(furniture, root, f"labyrinth_turn_{turn_index}", points, 0.055, labyrinth_mat)
    stage("labyrinth ready")

    add_box(furniture, root, "high_altar", (-20.0, 0, 1.25), (2.5, 1.15, 1.25), pale_stone, 0.14)
    add_box(furniture, root, "altar_redwood_mensa", (-20.0, 0, 2.65), (2.8, 1.35, 0.18), wood, 0.08)
    add_cylinder(furniture, root, "baptismal_font", (42.0, 0, 1.1), 1.0, 1.6, pale_stone, 16)
    add_cylinder(furniture, root, "font_basin", (42.0, 0, 2.0), 1.35, 0.28, cast_stone, 16)
    for side in (-1, 1):
        for row in range(7):
            add_box(furniture, root, f"choir_stall_{side}_{row}", (-27.0 - row * 2.0, side * 4.8, 1.2), (0.72, 1.35, 1.2), wood, 0.08)
    add_box(furniture, root, "organ_case", (-45.5, 0, 9.0), (1.0, 5.6, 9.0), wood, 0.12)
    for rank in range(17):
        y = -4.7 + rank * 0.59
        height = 3.0 + 7.0 * (1 - abs(rank - 8) / 9)
        add_cylinder(furniture, root, f"organ_pipe_{rank}", (-44.35, y, 8.0 + height / 2), 0.16, height, gold, 12)
    stage("sanctuary and organ ready")

    # A restrained geometric Saint Francis presence near the labyrinth.
    add_cylinder(furniture, root, "francis_plinth", (31.0, -8.7, 0.65), 1.0, 1.3, cast_stone, 16)
    add_cone(furniture, root, "francis_robe", (31.0, -8.7, 2.7), 0.82, 0.35, 3.4, bronze, 16)
    add_cylinder(furniture, root, "francis_head", (31.0, -8.7, 4.65), 0.38, 0.72, bronze, 16)
    add_polyline(furniture, root, "francis_bird_arm", [(31, -8.7, 3.7), (31, -7.6, 3.5), (31, -6.9, 3.9)], 0.12, bronze)
    add_cone(furniture, root, "francis_bird", (31.0, -6.82, 4.05), 0.22, 0.04, 0.48, gold, 8)
    stage("interior furnishings ready")

    # Broad entrance stair and exterior labyrinth plaza.
    for step in range(8):
        x = 51.4 + step * 0.82
        add_box(exterior, root, f"california_street_step_{step}", (x, 0, -0.15 - step * 0.48), (0.44, 13.0, 0.24), pale_stone, 0.05)
    add_box(exterior, root, "huntington_park_forecourt", (57.5, 0, -4.0), (5.8, 15.5, 0.18), pale_stone, 0.08)

    # Static collision: walkable floor/steps, perimeter walls and robust tower masses.
    collider(collider_collection, "grace_floor_collider", (0, 0, 0.0), (51.0, 14.0, 0.16))
    collider(collider_collection, "grace_north_wall_collider", (2, 14.0, 8.0), (49.0, 0.55, 8.0))
    collider(collider_collection, "grace_south_wall_collider", (2, -14.0, 8.0), (49.0, 0.55, 8.0))
    collider(collider_collection, "grace_west_apse_collider", (-49.0, 0, 10.0), (2.0, 8.0, 10.0))
    collider(collider_collection, "grace_facade_north_collider", (50.0, 8.5, 13.0), (1.0, 5.5, 13.0))
    collider(collider_collection, "grace_facade_south_collider", (50.0, -8.5, 13.0), (1.0, 5.5, 13.0))
    collider(collider_collection, "grace_facade_lintel_collider", (50.0, 0, 19.0), (1.0, 3.0, 7.0))
    collider(collider_collection, "grace_north_tower_collider", (48.0, 9.6, 25.8), (5.7, 5.7, 25.8))
    collider(collider_collection, "grace_south_tower_collider", (48.0, -9.6, 25.8), (5.7, 5.7, 25.8))
    for step in range(8):
        collider(collider_collection, f"grace_step_collider_{step}", (51.4 + step * 0.82, 0, -0.15 - step * 0.48), (0.44, 13.0, 0.24))
    stage("colliders ready")

    # The source .blend opens as a useful standalone project, with a cinematic
    # preview camera and lighting kept outside VISUAL so none leaks into the GLB.
    bpy.ops.object.light_add(type="SUN", location=(CENTER_X + 120, -CENTER_Z - 150, FLOOR + 180))
    sun = bpy.context.object
    sun.name = "Blender preview sun"
    sun.data.energy = 2.2
    sun.rotation_euler = (math.radians(28), math.radians(-20), math.radians(132))
    move_to(sun, preview)
    bpy.ops.object.light_add(type="AREA", location=(CENTER_X + 45, -CENTER_Z - 70, FLOOR + 34))
    area = bpy.context.object
    area.name = "Blender preview stained-glass fill"
    area.data.energy = 2400
    area.data.shape = "DISK"
    area.data.size = 22
    area.data.color = (0.32, 0.5, 1.0)
    move_to(area, preview)

    interior_target = root.matrix_world @ Vector((-24.0, 0.0, 9.0))
    bpy.ops.object.light_add(type="AREA", location=root.matrix_world @ Vector((20.0, -1.0, 15.0)))
    interior_area = bpy.context.object
    interior_area.name = "Blender preview nave glow"
    interior_area.data.energy = 5200
    interior_area.data.shape = "DISK"
    interior_area.data.size = 18
    interior_area.data.color = (1.0, 0.72, 0.46)
    interior_area.rotation_euler = (interior_target - interior_area.location).to_track_quat("-Z", "Y").to_euler()
    move_to(interior_area, preview)

    bpy.ops.object.camera_add(location=(CENTER_X + 190, -CENTER_Z - 170, FLOOR + 92))
    camera = bpy.context.object
    camera.name = "Grace Cathedral hero camera"
    move_to(camera, preview)
    direction = Vector((CENTER_X, -CENTER_Z, FLOOR + 24)) - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    camera.data.lens = 52
    scene.camera = camera

    bpy.ops.object.camera_add(location=root.matrix_world @ Vector((32.0, 0.0, 3.1)))
    nave_camera = bpy.context.object
    nave_camera.name = "Grace Cathedral nave camera"
    nave_camera.rotation_euler = (interior_target - nave_camera.location).to_track_quat("-Z", "Y").to_euler()
    nave_camera.data.lens = 25
    move_to(nave_camera, preview)
    scene.world.color = (0.018, 0.026, 0.045)

    bpy.ops.wm.save_as_mainfile(filepath=str(output))
    print(f"[grace-cathedral] saved {output}")


if __name__ == "__main__":
    build(parse_args())
