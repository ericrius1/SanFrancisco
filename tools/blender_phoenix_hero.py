"""Build the Tripo-authored phoenix into the open San Francisco weather scene.

Run inside Blender. The generated GLBs contain no baked clips: the semantic
17-bone rig and `_PHX_*` point attributes are intended for procedural Three.js
animation and shader effects.
"""

from __future__ import annotations

import math
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


PROJECT = Path("/Users/eric/.codex/worktrees/46d3/sanfrancisco")
TRIPO_SOURCE = PROJECT / "assets-src/phoenix/tripo/source/521366b4-a10c-4d77-9350-8dd2ad6856a2-pbr_model.glb"
ASSET_BLEND = PROJECT / "assets-src/phoenix/phoenix-hero.blend"
EXPORT_LOD0 = PROJECT / "public/models/phoenix-hero.glb"
EXPORT_LOD1 = PROJECT / "public/models/phoenix-hero-lod1.glb"
PREVIEW = PROJECT / ".data/phoenix/phoenix_hero_tripo_weather.png"

COLLECTION_NAME = "PHOENIX_HERO"
RIG_NAME = "PhoenixRig"
MESH_NAME = "PhoenixHeroMesh"
SKY_LOCATION = Vector((384.0, 1952.0, 700.0))
ASSET_SCALE = 10.0
LOD0_TRIANGLES = 58_000
LOD1_TRIANGLES = 23_000
BIRD_YAW = math.radians(-74.25)


BONES = {
    "root": ((0.0, 0.0, -0.85), (0.0, 0.0, 0.20), None),
    "spine01": ((0.0, 0.0, -0.55), (0.0, 0.0, 0.82), "root"),
    "chest": ((0.0, 0.0, 0.35), (0.0, 0.0, 1.95), "spine01"),
    "neck01": ((0.0, 0.0, 1.60), (0.10, 0.0, 2.55), "chest"),
    "neck02": ((0.10, 0.0, 2.48), (0.52, 0.0, 3.05), "neck01"),
    "head": ((0.48, 0.0, 2.95), (1.42, 0.0, 3.12), "neck02"),
    "wing_arm_L": ((0.0, 0.45, 1.55), (0.0, 2.05, 3.12), "chest"),
    "wing_forearm_L": ((0.0, 2.05, 3.12), (0.0, 3.72, 4.72), "wing_arm_L"),
    "wing_hand_L": ((0.0, 3.72, 4.72), (0.0, 5.36, 5.88), "wing_forearm_L"),
    "wing_arm_R": ((0.0, -0.45, 1.55), (0.0, -2.05, 3.12), "chest"),
    "wing_forearm_R": ((0.0, -2.05, 3.12), (0.0, -3.72, 4.72), "wing_arm_R"),
    "wing_hand_R": ((0.0, -3.72, 4.72), (0.0, -5.36, 5.88), "wing_forearm_R"),
    "tail01": ((-0.18, 0.0, -0.12), (-0.30, 0.0, -1.38), "spine01"),
    "tail02": ((-0.30, 0.0, -1.38), (-0.40, 0.0, -2.55), "tail01"),
    "tail03": ((-0.40, 0.0, -2.55), (-0.48, 0.0, -3.72), "tail02"),
    "tail04": ((-0.48, 0.0, -3.72), (-0.55, 0.0, -4.88), "tail03"),
    "tail05": ((-0.55, 0.0, -4.88), (-0.62, 0.0, -6.05), "tail04"),
}

BODY_BONES = ("root", "spine01", "chest", "neck01", "neck02", "head")
TAIL_BONES = ("tail01", "tail02", "tail03", "tail04", "tail05")
WING_BONES = {
    "L": ("wing_arm_L", "wing_forearm_L", "wing_hand_L"),
    "R": ("wing_arm_R", "wing_forearm_R", "wing_hand_R"),
}


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    t = max(0.0, min(1.0, (value - edge0) / (edge1 - edge0)))
    return t * t * (3.0 - 2.0 * t)


def segment_distance(point: Vector, a: Vector, b: Vector) -> float:
    line = b - a
    denom = line.length_squared
    if denom <= 1e-12:
        return (point - a).length
    t = max(0.0, min(1.0, (point - a).dot(line) / denom))
    return (point - (a + line * t)).length


def remove_object(obj) -> None:
    data = obj.data
    bpy.data.objects.remove(obj, do_unlink=True)
    if data is not None and getattr(data, "users", 1) == 0:
        collection = getattr(bpy.data, f"{data.__class__.__name__.lower()}s", None)
        if collection is not None:
            try:
                collection.remove(data)
            except Exception:
                pass


def clean_previous(main_scene: bpy.types.Scene) -> None:
    bpy.context.window.scene = main_scene
    for scene in list(bpy.data.scenes):
        if scene != main_scene and scene.name.startswith("PHOENIX_TEMP"):
            bpy.data.scenes.remove(scene)

    collection_names = {COLLECTION_NAME, "PHOENIX_TRIPO_REVIEW", "PHOENIX_TEMP_RENDER"}
    doomed = set()
    for coll in list(bpy.data.collections):
        if coll.name in collection_names:
            doomed.update(coll.all_objects)
    for obj in list(doomed):
        remove_object(obj)
    for coll in list(bpy.data.collections):
        if coll.name in collection_names:
            bpy.data.collections.remove(coll)

    for obj in list(bpy.data.objects):
        if (
            obj.get("phoenix_generated")
            or obj.name.startswith("PHX_")
            or obj.name.startswith("PhoenixHero")
            or obj.name == RIG_NAME
        ):
            remove_object(obj)
    for material in list(bpy.data.materials):
        if material.name.startswith("PHX_") and (
            material.users == 0 or (material.use_fake_user and material.users == 1)
        ):
            material.use_fake_user = False
            bpy.data.materials.remove(material)
    for image in list(bpy.data.images):
        if image.name.startswith("PHX_") and (
            image.users == 0 or (image.use_fake_user and image.users == 1)
        ):
            image.use_fake_user = False
            bpy.data.images.remove(image)
    for mesh in list(bpy.data.meshes):
        if (mesh.name.startswith("PHX_") or mesh.name.startswith("PhoenixHero")) and (
            mesh.users == 0 or (mesh.use_fake_user and mesh.users == 1)
        ):
            mesh.use_fake_user = False
            bpy.data.meshes.remove(mesh)
    for armature in list(bpy.data.armatures):
        if armature.name.startswith(RIG_NAME) and (
            armature.users == 0 or (armature.use_fake_user and armature.users == 1)
        ):
            armature.use_fake_user = False
            bpy.data.armatures.remove(armature)


def new_hero_collection(scene: bpy.types.Scene) -> bpy.types.Collection:
    coll = bpy.data.collections.new(COLLECTION_NAME)
    scene.collection.children.link(coll)
    return coll


def link_only(obj: bpy.types.Object, coll: bpy.types.Collection) -> None:
    for current in list(obj.users_collection):
        current.objects.unlink(obj)
    coll.objects.link(obj)


def active_object(obj: bpy.types.Object) -> None:
    bpy.ops.object.mode_set(mode="OBJECT") if bpy.context.object and bpy.context.object.mode != "OBJECT" else None
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def import_source(coll: bpy.types.Collection) -> bpy.types.Object:
    if not TRIPO_SOURCE.exists():
        raise RuntimeError(f"Tripo source is missing: {TRIPO_SOURCE}")
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(TRIPO_SOURCE))
    created = [obj for obj in bpy.data.objects if obj not in before]
    meshes = [obj for obj in created if obj.type == "MESH"]
    if len(meshes) != 1:
        raise RuntimeError(f"Expected one fused Tripo mesh, found {len(meshes)}")
    mesh = meshes[0]
    link_only(mesh, coll)
    mesh.name = MESH_NAME
    mesh.data.name = f"{MESH_NAME}Geometry"
    mesh.scale = (ASSET_SCALE,) * 3
    active_object(mesh)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    source_triangles = sum(max(1, len(poly.vertices) - 2) for poly in mesh.data.polygons)
    ratio = min(1.0, LOD0_TRIANGLES / source_triangles)
    if ratio < 0.999:
        modifier = mesh.modifiers.new("PHX_SilhouetteDecimate", "DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = ratio
        modifier.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=modifier.name)

    for polygon in mesh.data.polygons:
        polygon.use_smooth = True
    mesh["phoenix_generated"] = True
    mesh["phoenix_role"] = "hero_lod0_skinned_mesh"
    mesh["source_task_id"] = "521366b4-a10c-4d77-9350-8dd2ad6856a2"
    return mesh


def optimize_source_images(mesh: bpy.types.Object) -> list[dict]:
    used_images = []
    seen = set()
    for material in mesh.data.materials:
        if not material or not material.use_nodes:
            continue
        incumbent = bpy.data.materials.get("PHX_FeatherPBR")
        if incumbent and incumbent != material:
            incumbent.name = "PHX_FeatherPBR_orphan"
        material.name = "PHX_FeatherPBR"
        nodes = material.node_tree.nodes
        shader = next((node for node in nodes if node.type == "BSDF_PRINCIPLED"), None)
        if shader:
            base = shader.inputs.get("Base Color")
            emission_color = shader.inputs.get("Emission Color") or shader.inputs.get("Emission")
            emission_strength = shader.inputs.get("Emission Strength")
            if base and base.links and emission_color:
                material.node_tree.links.new(base.links[0].from_socket, emission_color)
            if emission_strength:
                emission_strength.default_value = 0.34
            for socket_name, value in (("Coat Weight", 0.16), ("Coat Roughness", 0.24), ("Sheen Weight", 0.20)):
                socket = shader.inputs.get(socket_name)
                if socket and not socket.is_linked:
                    socket.default_value = value

        for node in nodes:
            if node.type != "TEX_IMAGE" or not node.image or node.image in seen:
                continue
            image = node.image
            seen.add(image)
            original = tuple(image.size)
            target = 2048
            if max(original) > target:
                image.scale(target, target)
            if image.packed_file is None:
                image.pack()
            lower = image.name.lower()
            if "normal" in lower:
                shipping_name = "PHX_Normal_2K"
            elif "orm" in lower:
                shipping_name = "PHX_ORM_2K"
            else:
                shipping_name = "PHX_BaseColor_2K"
            incumbent = bpy.data.images.get(shipping_name)
            if incumbent and incumbent != image:
                incumbent.name = f"{shipping_name}_orphan"
            image.name = shipping_name
            used_images.append({"name": image.name, "source": original, "shipping": tuple(image.size)})
    return used_images


def build_rig(coll: bpy.types.Collection) -> bpy.types.Object:
    bpy.ops.object.armature_add(enter_editmode=True, location=SKY_LOCATION)
    arm = bpy.context.object
    arm.name = RIG_NAME
    arm.data.name = f"{RIG_NAME}Data"
    link_only(arm, coll)
    arm.rotation_euler.z = BIRD_YAW
    arm.show_in_front = True
    arm.data.display_type = "OCTAHEDRAL"
    for bone in list(arm.data.edit_bones):
        arm.data.edit_bones.remove(bone)
    edit_bones = {}
    for name, (head, tail, _parent) in BONES.items():
        bone = arm.data.edit_bones.new(name)
        bone.head = Vector(head)
        bone.tail = Vector(tail)
        bone.use_deform = True
        edit_bones[name] = bone
    for name, (_head, _tail, parent) in BONES.items():
        if parent:
            edit_bones[name].parent = edit_bones[parent]
            edit_bones[name].use_connect = (
                Vector(BONES[name][0]) - Vector(BONES[parent][1])
            ).length < 1e-4
    bpy.ops.object.mode_set(mode="OBJECT")
    arm["phoenix_generated"] = True
    arm["phoenix_asset_version"] = 3
    arm["runtime_animation"] = "procedural_threejs"
    arm["runtime_forward"] = "+X in Blender asset space; glTF converted Y-up"
    arm["runtime_triangle_budget_lod0"] = LOD0_TRIANGLES
    arm["runtime_triangle_budget_lod1"] = LOD1_TRIANGLES
    arm["runtime_material_budget"] = 2
    arm["runtime_clip_count"] = 0
    for bone in arm.data.bones:
        if bone.name.startswith("wing_"):
            bone["phoenix_channel"] = "wing_flap_fold_twist"
        elif bone.name.startswith("tail"):
            bone["phoenix_channel"] = "tail_sway_curl"
        elif bone.name in {"neck01", "neck02", "head"}:
            bone["phoenix_channel"] = "look_and_breath"
        else:
            bone["phoenix_channel"] = "body_flight"
    return arm


def normalized_scores(point: Vector, names: tuple[str, ...]) -> dict[str, float]:
    scores = {}
    for name in names:
        head, tail, _parent = BONES[name]
        distance = segment_distance(point, Vector(head), Vector(tail))
        scores[name] = 1.0 / (0.07 + distance * distance)
    total = sum(scores.values()) or 1.0
    return {name: value / total for name, value in scores.items()}


def skin_and_mask(mesh: bpy.types.Object, arm: bpy.types.Object) -> dict:
    for group in list(mesh.vertex_groups):
        mesh.vertex_groups.remove(group)
    groups = {name: mesh.vertex_groups.new(name=name) for name in BONES}

    flutter = mesh.data.attributes.get("_PHX_FLUTTER") or mesh.data.attributes.new(
        name="_PHX_FLUTTER", type="FLOAT", domain="POINT"
    )
    heat = mesh.data.attributes.get("_PHX_HEAT") or mesh.data.attributes.new(
        name="_PHX_HEAT", type="FLOAT", domain="POINT"
    )

    max_influences = 0
    for vertex in mesh.data.vertices:
        point = vertex.co
        x, y, z = point
        abs_y = abs(y)
        side = "L" if y >= 0.0 else "R"
        tail_back = 1.0 - smoothstep(0.05, 0.75, x)
        tail_strength = smoothstep(0.55, 1.65, -z) * tail_back
        wing_strength = smoothstep(0.40, 1.65, abs_y) * smoothstep(-0.35, 0.80, z)
        wing_strength *= 1.0 - tail_strength
        body_strength = max(0.0, 1.0 - max(tail_strength, wing_strength))

        weights = {}
        for name, value in normalized_scores(point, BODY_BONES).items():
            weights[name] = weights.get(name, 0.0) + value * body_strength
        if wing_strength > 0.0:
            for name, value in normalized_scores(point, WING_BONES[side]).items():
                weights[name] = weights.get(name, 0.0) + value * wing_strength
        if tail_strength > 0.0:
            for name, value in normalized_scores(point, TAIL_BONES).items():
                weights[name] = weights.get(name, 0.0) + value * tail_strength

        strongest = sorted(weights.items(), key=lambda item: item[1], reverse=True)[:4]
        total = sum(value for _name, value in strongest) or 1.0
        for name, value in strongest:
            groups[name].add([vertex.index], value / total, "REPLACE")
        max_influences = max(max_influences, len(strongest))

        wing_tip = smoothstep(0.55, 5.25, abs_y)
        tail_tip = smoothstep(0.60, 5.85, -z) * tail_back
        flutter.data[vertex.index].value = max(wing_tip, tail_tip)
        heat.data[vertex.index].value = max(tail_tip, wing_tip * 0.68, smoothstep(2.35, 3.35, z) * 0.30)

    mesh.parent = arm
    mesh.matrix_parent_inverse = Matrix.Identity(4)
    mesh.location = (0.0, 0.0, 0.0)
    mesh.rotation_euler = (0.0, 0.0, 0.0)
    modifier = mesh.modifiers.new("PhoenixSemanticRig", "ARMATURE")
    modifier.object = arm
    modifier.use_deform_preserve_volume = True
    return {"vertices": len(mesh.data.vertices), "max_influences": max_influences}


def eye_glint_material() -> bpy.types.Material:
    material = bpy.data.materials.new("PHX_EyeGlint")
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (1.0, 0.15, 0.006, 1.0)
    shader.inputs["Metallic"].default_value = 0.0
    shader.inputs["Roughness"].default_value = 0.12
    emission = shader.inputs.get("Emission Color") or shader.inputs.get("Emission")
    if emission:
        emission.default_value = (1.0, 0.045, 0.001, 1.0)
    strength = shader.inputs.get("Emission Strength")
    if strength:
        strength.default_value = 5.0
    return material


def build_eye_glints(coll: bpy.types.Collection, arm: bpy.types.Object) -> bpy.types.Object:
    material = eye_glint_material()
    objects = []
    for y in (0.315, -0.315):
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.035, location=(1.045, y, 2.96))
        obj = bpy.context.object
        obj.data.materials.append(material)
        objects.append(obj)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    glints = bpy.context.object
    glints.name = "PHX_EyeGlints"
    glints.data.name = "PHX_EyeGlintGeometry"
    bpy.context.scene.cursor.location = (0.0, 0.0, 0.0)
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    link_only(glints, coll)
    group = glints.vertex_groups.new(name="head")
    group.add(list(range(len(glints.data.vertices))), 1.0, "REPLACE")
    glints.parent = arm
    glints.matrix_parent_inverse = Matrix.Identity(4)
    glints.location = (0.0, 0.0, 0.0)
    modifier = glints.modifiers.new("PhoenixSemanticRig", "ARMATURE")
    modifier.object = arm
    glints["phoenix_generated"] = True
    glints["phoenix_role"] = "subtle_cornea_highlights"
    return glints


def marker(coll: bpy.types.Collection, arm: bpy.types.Object, name: str, bone_name: str, local_offset) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "SPHERE"
    obj.empty_display_size = 0.13
    obj["phoenix_generated"] = True
    obj["runtime_attachment"] = name
    coll.objects.link(obj)
    obj.parent = arm
    obj.parent_type = "BONE"
    obj.parent_bone = bone_name
    bone = arm.data.bones[bone_name]
    obj.matrix_world = arm.matrix_world @ bone.matrix_local @ Matrix.Translation(Vector(local_offset))
    return obj


def aim_object(obj: bpy.types.Object, target: Vector) -> None:
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def build_preview(coll: bpy.types.Collection, scene: bpy.types.Scene) -> bpy.types.Camera:
    camera_data = bpy.data.cameras.new("PHX_Gen_CameraData")
    camera_data.lens = 48
    camera = bpy.data.objects.new("PHX_Gen_Camera", camera_data)
    camera["phoenix_generated"] = True
    coll.objects.link(camera)
    camera.location = SKY_LOCATION + Vector((6.2, -22.0, 1.8))
    aim_object(camera, SKY_LOCATION + Vector((0.0, 0.0, 0.0)))
    scene.camera = camera

    specs = (
        ("PHX_Gen_Key", "AREA", (-6.5, -8.0, 8.5), (1.0, 0.22, 0.035), 1650, 7.0),
        ("PHX_Gen_Rim", "AREA", (5.5, 3.5, 6.5), (1.0, 0.055, 0.008), 1950, 5.0),
        ("PHX_Gen_Fill", "AREA", (3.2, -10.5, 1.6), (0.20, 0.30, 1.0), 820, 8.0),
    )
    for name, kind, offset, color, energy, size in specs:
        data = bpy.data.lights.new(f"{name}Data", kind)
        data.energy = energy
        data.color = color
        data.shape = "DISK"
        data.size = size
        light = bpy.data.objects.new(name, data)
        light["phoenix_generated"] = True
        coll.objects.link(light)
        light.location = SKY_LOCATION + Vector(offset)
        aim_object(light, SKY_LOCATION + Vector((0.0, 0.0, 0.3)))

    core_data = bpy.data.lights.new("PHX_Gen_CoreLightData", "POINT")
    core_data.energy = 850
    core_data.color = (1.0, 0.055, 0.004)
    core_data.shadow_soft_size = 3.0
    core = bpy.data.objects.new("PHX_Gen_CoreLight", core_data)
    core["phoenix_generated"] = True
    coll.objects.link(core)
    core.location = SKY_LOCATION + Vector((0.0, 0.0, -0.4))

    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1200
    scene.render.resolution_y = 1200
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.render.filepath = str(PREVIEW)
    scene.view_settings.look = "AgX - Medium High Contrast"
    return camera


def build_collision_reference(coll: bpy.types.Collection, arm: bpy.types.Object) -> bpy.types.Object:
    collision = bpy.data.objects.new("PHX_CollisionReference", None)
    collision.empty_display_type = "SPHERE"
    collision.empty_display_size = 6.1
    coll.objects.link(collision)
    collision.hide_render = True
    collision.hide_set(True)
    collision.parent = arm
    collision["phoenix_generated"] = True
    collision["phoenix_role"] = "reference_only_not_exported"
    collision["collision_radius"] = 6.1
    return collision


def select_export(objects: list[bpy.types.Object]) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.hide_set(False)
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]


def export_glb(path: Path, objects: list[bpy.types.Object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    select_export(objects)
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=False,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
        export_attributes=True,
        export_all_influences=False,
        export_influence_nb=4,
        export_image_format="WEBP",
        export_image_quality=92,
    )


def duplicate_lod1(mesh: bpy.types.Object, arm: bpy.types.Object, coll: bpy.types.Collection) -> bpy.types.Object:
    lod = mesh.copy()
    lod.data = mesh.data.copy()
    lod.name = "PhoenixHeroMesh_LOD1"
    lod.data.name = "PhoenixHeroLOD1Geometry"
    coll.objects.link(lod)
    for modifier in list(lod.modifiers):
        lod.modifiers.remove(modifier)
    active_object(lod)
    source_triangles = sum(max(1, len(poly.vertices) - 2) for poly in lod.data.polygons)
    modifier = lod.modifiers.new("PHX_LOD1Decimate", "DECIMATE")
    modifier.decimate_type = "COLLAPSE"
    modifier.ratio = min(1.0, LOD1_TRIANGLES / source_triangles)
    modifier.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
    rig_modifier = lod.modifiers.new("PhoenixSemanticRig", "ARMATURE")
    rig_modifier.object = arm
    rig_modifier.use_deform_preserve_volume = True
    lod["phoenix_role"] = "hero_lod1_skinned_mesh"
    return lod


def main() -> dict:
    main_scene = bpy.data.scenes.get("Scene")
    if main_scene is None:
        raise RuntimeError("The open weather scene named 'Scene' is missing")
    clean_previous(main_scene)
    coll = new_hero_collection(main_scene)
    mesh = import_source(coll)
    image_stats = optimize_source_images(mesh)
    arm = build_rig(coll)
    skin_stats = skin_and_mask(mesh, arm)
    attachments = [
        marker(coll, arm, "PHX_Gen_Trail_L", "tail05", (0.0, 0.48, 0.0)),
        marker(coll, arm, "PHX_Gen_Trail_R", "tail05", (0.0, -0.48, 0.0)),
        marker(coll, arm, "PHX_Gen_Fire_Core", "chest", (0.0, 0.0, -0.15)),
        marker(coll, arm, "PHX_Gen_Wingtip_L", "wing_hand_L", (0.0, 0.0, 0.0)),
        marker(coll, arm, "PHX_Gen_Wingtip_R", "wing_hand_R", (0.0, 0.0, 0.0)),
    ]
    collision = build_collision_reference(coll, arm)
    camera = build_preview(coll, main_scene)

    # The live hero stays at SKY_LOCATION and faces the look-dev camera, while
    # every handoff asset is exported at the origin with an identity root.
    placed_matrix = arm.matrix_world.copy()
    arm.matrix_world = Matrix.Identity(4)
    bpy.context.view_layer.update()
    hero_export = [arm, mesh, *attachments]
    export_glb(EXPORT_LOD0, hero_export)
    lod1 = duplicate_lod1(mesh, arm, coll)
    export_glb(EXPORT_LOD1, [arm, lod1, *attachments])
    lod1_triangles = sum(max(1, len(poly.vertices) - 2) for poly in lod1.data.polygons)
    remove_object(lod1)

    ASSET_BLEND.parent.mkdir(parents=True, exist_ok=True)
    asset_coll = bpy.data.collections.new("PHOENIX_HERO_ASSET")
    for obj in [arm, mesh, *attachments, collision]:
        asset_coll.objects.link(obj)
    bpy.data.libraries.write(str(ASSET_BLEND), {asset_coll}, fake_user=False, compress=True)
    bpy.data.collections.remove(asset_coll)
    arm.matrix_world = placed_matrix
    bpy.context.view_layer.update()

    main_scene["phoenix_handoff"] = (
        "Load phoenix-hero-lod1.glb at distance and phoenix-hero.glb near camera. "
        "Drive semantic bones procedurally; use _PHX_FLUTTER and _PHX_HEAT in TSL/WGSL."
    )
    main_scene["phoenix_runtime"] = (
        "No baked clips. One feather PBR material with textured raptor eyes. "
        "Spawn fire ribbons/embers from PHX_Gen_* attachment nodes only after phoenix activation."
    )
    main_scene["phoenix_lazy_loading"] = "Optional asset: zero model/texture requests at clean boot."
    main_scene.render.filepath = str(PREVIEW)
    PREVIEW.parent.mkdir(parents=True, exist_ok=True)

    select_export([arm, mesh])
    bpy.context.view_layer.objects.active = mesh
    bpy.context.view_layer.update()
    bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)

    lod0_triangles = sum(max(1, len(poly.vertices) - 2) for poly in mesh.data.polygons)
    return {
        "armature": arm.name,
        "bones": [bone.name for bone in arm.data.bones],
        "mesh": mesh.name,
        "lod0_triangles": lod0_triangles,
        "lod1_triangles": lod1_triangles,
        "materials": [material.name for material in mesh.data.materials],
        "skin": skin_stats,
        "images": image_stats,
        "attachments": [obj.name for obj in attachments],
        "collision_reference": collision.name,
        "camera": camera.name,
        "preview": str(PREVIEW),
        "glb_lod0": str(EXPORT_LOD0),
        "glb_lod1": str(EXPORT_LOD1),
        "asset_blend": str(ASSET_BLEND),
    }


RESULT = main()
