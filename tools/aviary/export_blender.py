"""Export edited birds from the open atelier; no regeneration of meshes/actions."""
import bpy
from pathlib import Path
ROOT=Path(bpy.data.filepath).resolve().parents[2]
OUT=ROOT/'.data/aviary/raw';OUT.mkdir(parents=True,exist_ok=True)
scene=bpy.context.scene
frame=scene.frame_current
selection=list(bpy.context.selected_objects)
active=bpy.context.view_layer.objects.active
mode=active.mode if active else 'OBJECT'
report=[]
rigs=[o for o in scene.objects if o.type=='ARMATURE' and 'species_id' in o]
owned={ob for rig in rigs for ob in [rig,*rig.children]}
layers=[]
collections=[]
visibility=[(ob,ob.hide_viewport,ob.hide_render,ob.hide_get()) for ob in owned]
def record_layers(layer):
    # Snapshot every path first: changing a parent's exclude flag can reset
    # child flags in Blender, even before we visit the child.
    if any(ob in owned for ob in layer.collection.all_objects):
        layers.append((layer,layer.exclude,layer.hide_viewport))
        collections.append((layer.collection,layer.collection.hide_viewport))
        for child in layer.children:record_layers(child)
try:
    if mode!='OBJECT':bpy.ops.object.mode_set(mode='OBJECT')
    record_layers(bpy.context.view_layer.layer_collection)
    for layer,_,_ in layers:
        if layer.exclude:layer.exclude=False
        layer.hide_viewport=False;layer.collection.hide_viewport=False
    for ob,_,_,_ in visibility:ob.hide_viewport=False;ob.hide_render=False;ob.hide_set(False)
    for rig in rigs:
        pos=rig.location.copy();rotation=rig.rotation_euler.copy();sid=rig['species_id'];tracks=rig.animation_data.nla_tracks
        states=[t.mute for t in tracks];copies=[]
        try:
            rig.location=(0,0,0);rig.rotation_euler=(0,0,0)
            scene.frame_set(1)
            for source in list(rig.children):
                if source.type!='MESH':continue
                ob=source.copy();ob.data=source.data.copy();source.users_collection[0].objects.link(ob);copies.append(ob)
                # Apply reduction once on a disposable copy. Keeping an active
                # decimator during animation sampling recalculates it every frame.
                bpy.ops.object.select_all(action='DESELECT');ob.select_set(True);bpy.context.view_layer.objects.active=ob
                for modifier in list(ob.modifiers):
                    if modifier.type=='DECIMATE':
                        modifier.show_viewport=True;modifier.show_render=True
                        bpy.ops.object.modifier_apply(modifier=modifier.name)
            bpy.ops.object.select_all(action='DESELECT');rig.select_set(True)
            for ob in copies:ob.select_set(True)
            bpy.context.view_layer.objects.active=rig
            for t in tracks:t.mute=False
            bpy.ops.export_scene.gltf(filepath=str(OUT/(sid+'.glb')),export_format='GLB',use_selection=True,export_animations=True,export_animation_mode='NLA_TRACKS',export_force_sampling=True,export_frame_range=False,export_skins=True,export_def_bones=True,export_yup=True,export_apply=True,export_cameras=False,export_lights=False)
            report.append(sid)
        finally:
            for ob in copies:
                mesh=ob.data;bpy.data.objects.remove(ob,do_unlink=True)
                if mesh.users==0:bpy.data.meshes.remove(mesh)
            rig.location=pos;rig.rotation_euler=rotation
            for track,mute in zip(tracks,states):track.mute=mute
finally:
    scene.frame_set(frame)
    bpy.ops.object.select_all(action='DESELECT')
    for ob in selection:ob.select_set(True)
    bpy.context.view_layer.objects.active=active
    if active and mode!='OBJECT':bpy.ops.object.mode_set(mode=mode)
    for ob,viewport,render,hidden in visibility:ob.hide_set(hidden);ob.hide_viewport=viewport;ob.hide_render=render
    for collection,hidden in reversed(collections):collection.hide_viewport=hidden
    for layer,excluded,hidden in layers:
        if layer.exclude!=excluded:layer.exclude=excluded
        layer.hide_viewport=hidden
print('Exported editable rigs:',report)
