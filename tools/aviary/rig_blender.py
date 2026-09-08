"""Bind the refined meshes to shared flight controls; preserve edited actions."""
import bpy,math
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[2]
def smooth(a,b,x):
 t=max(0,min(1,(x-a)/(b-a)));return t*t*(3-2*t)
for sid in ['pearl-gull','lagoon-jay','ember-kestrel']:
    rig=bpy.data.objects[sid+'.rig'];ob=bpy.data.objects[sid+'.plumage']
    # Reset edited binds safely; mesh data remains at rest.
    ob.vertex_groups.clear()
    for m in list(ob.modifiers):ob.modifiers.remove(m)
    ob.parent=rig;ob.location=(0,0,0);ob.rotation_euler=(0,0,0);ob.scale=(1,1,1)
    for name in ['root','head','tail','wing.L','wing.R','tip.L','tip.R']:ob.vertex_groups.new(name=name)
    half=max(abs(v.co.x) for v in ob.data.vertices)
    for v in ob.data.vertices:
        x,y,z=v.co;side='L' if x>=0 else 'R';ax=abs(x)
        wing=smooth(.16,.38,ax)
        tip=smooth(half*.49,half*.67,ax)
        head=smooth(-.12,-.37,y)*(1-wing)
        tail=smooth(.26,.68,y)*(1-wing)
        root=max(0,1-wing-head-tail)
        weights={'root':root,'head':head,'tail':tail,'wing.'+side:wing*(1-tip),'tip.'+side:wing*tip}
        weights={k:w for k,w in weights.items() if w>.0001};total=sum(weights.values())
        for bone,w in weights.items():ob.vertex_groups[bone].add([v.index],w/total,'REPLACE')
    dec=ob.modifiers.new('Game export • 55% geometry / editable source retained','DECIMATE');dec.ratio=.55
    # Studio keeps the full modeled feather surface; export applies this modifier.
    dec.show_viewport=False;dec.show_render=False
    mod=ob.modifiers.new('Shared flight skeleton','ARMATURE');mod.object=rig
    rig.show_in_front=False
    rig['concept_reference']=ob['concept_reference']
    print(sid,len(ob.data.vertices),'vertices bound; all weights normalized')
scene=bpy.context.scene
for ob in scene.objects:
 if ob.type=='ARMATURE':
  for track in ob.animation_data.nla_tracks:track.mute=track.name!='Fly'
scene.frame_set(5)
# Reference art travels inside this single blend file, separately toggleable.
old=bpy.data.collections.get('90  REFERENCES / GPT concept art')
if old:
 for o in list(old.objects):bpy.data.objects.remove(o,do_unlink=True)
else:
 old=bpy.data.collections.new('90  REFERENCES / GPT concept art');scene.collection.children.link(old)
old.hide_render=True;old.hide_viewport=True
for i,name in enumerate(['concept-v2','pearl-reference-v2','lagoon-reference-v2','ember-reference-v3']):
 img=bpy.data.images.load(str(ROOT/'assets-src/aviary'/(name+'.png')),check_existing=True);img.pack()
 o=bpy.data.objects.new(name,None);o.empty_display_type='IMAGE';o.data=img;o.empty_display_size=5;o.location=(i*6-9,6,2);old.objects.link(o)
text=bpy.data.texts.get('AVIARY — READ ME');text.clear();text.write('AVIARY / GPT art direction → image-based mesh → Blender refinement & rig → compressed glTF\n\nThree numbered collections toggle each bird. Space plays Fly.\nSelect a rig and switch an area to NLA Editor: mute Fly, unmute Glide or Scatter.\nAll three animations use the same seven controls, with blended shoulder/wrist weights.\n90 REFERENCES contains the packed GPT concept sheet and individual species studies.\nThe meshes keep full detail in Blender; Game export modifier reduces geometry for shipping.\n\nExport edits without regeneration:\nexec(compile(open(\"'+str(ROOT/'tools/aviary/export_blender.py')+'\").read(), \"export_blender.py\", \"exec\"))\nThen: npm run birds:pack\n\nSource inputs and prompts are in assets-src/aviary. Do not run rebuild to export manual edits.\n')
for area in bpy.context.screen.areas:
 if area.type=='VIEW_3D':
  space=area.spaces.active;space.overlay.show_overlays=False;space.shading.type='MATERIAL'
  space.region_3d.view_perspective='CAMERA';space.region_3d.view_camera_zoom=10
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'assets-src/aviary/aviary.blend'),compress=True)
