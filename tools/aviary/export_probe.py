"""Run in background Blender: exports must preserve editing and visibility state.
blender -b assets-src/aviary/aviary.blend --python-exit-code 1 --python tools/aviary/export_probe.py
"""
import bpy,runpy
from pathlib import Path
scene=bpy.context.scene
rigs=[o for o in scene.objects if o.type=='ARMATURE' and 'species_id' in o]
assert len(rigs)==3
layer=bpy.context.view_layer.layer_collection
rigs[0].users_collection[0].hide_viewport=True
hidden_layer=next(c for c in layer.children if c.collection==rigs[1].users_collection[0])
hidden_layer.exclude=True
rigs[2].children[0].hide_set(True)
bpy.ops.object.select_all(action='DESELECT')
rigs[2].select_set(True);bpy.context.view_layer.objects.active=rigs[2]
bpy.ops.object.mode_set(mode='POSE');scene.frame_set(17)
def snapshot():
    bpy.context.view_layer.update()
    return {
        'frame':scene.frame_current,'mode':bpy.context.object.mode,
        'selected':sorted(o.name for o in bpy.context.selected_objects),
        'excluded':hidden_layer.exclude,
        'rigs':[(o.name,tuple(o.location),tuple(o.rotation_euler),o.users_collection[0].hide_viewport,tuple(t.mute for t in o.animation_data.nla_tracks)) for o in rigs],
        'meshes':[(m.name,m.hide_get(),tuple(tuple(v.co) for v in m.data.vertices),tuple((v.name,v.show_viewport,v.show_render) for v in m.modifiers)) for o in rigs for m in o.children if m.type=='MESH'],
    }
before=snapshot()
runpy.run_path(str(Path(__file__).with_name('export_blender.py')))
after=snapshot()
for key in before:
    if after[key]!=before[key]:
        print('Changed field:',key)
        if key!='meshes':print('Before:',before[key],'After:',after[key])
        else:
            for a,b in zip(before[key],after[key]):
                if a!=b:print(a[0],'changed components',[i for i in range(len(a)) if a[i]!=b[i]])
assert after==before,'Export mutated the editable Blender state'
assert len([o for o in scene.objects if o.type=='MESH' and o.parent in rigs])==3,'Temporary export copies leaked'
print('Aviary export probe passed: hidden/excluded collections, pose mode, frame, meshes and actions restored.')
