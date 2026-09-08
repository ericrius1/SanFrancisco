"""Add an editable folded-wing rest action without rebuilding the artist meshes."""
import bpy, math
from mathutils import Quaternion, Vector
for sid in ['pearl-gull','lagoon-jay','ember-kestrel']:
    rig=bpy.data.objects[sid+'.rig']
    for track in list(rig.animation_data.nla_tracks):
        if track.name=='Perch': rig.animation_data.nla_tracks.remove(track)
    action=bpy.data.actions.new(sid+'.Perch');action.use_fake_user=True
    rig.animation_data.action=action
    for frame in range(1,50,2):
        t=(frame-1)/48*math.pi*2
        for bone in rig.pose.bones:
            q=Quaternion()
            sign=1 if bone.name.endswith('L') else -1
            if bone.name.startswith('wing.'):
                q=Quaternion(Vector((0,0,1)),sign*1.4) @ Quaternion(Vector((0,1,0)),sign*.23)
            elif bone.name.startswith('tip.'):
                q=Quaternion(Vector((0,0,1)),0)
            elif bone.name=='root':q=Quaternion(Vector((1,0,0)),-.65+math.sin(t)*.012)
            elif bone.name=='head':q=Quaternion(Vector((0,0,1)),math.sin(t)*.24) @ Quaternion(Vector((1,0,0)),.35)
            elif bone.name=='tail':q=Quaternion(Vector((1,0,0)),.2)
            rest=bone.bone.matrix_local.to_quaternion()
            bone.rotation_mode='QUATERNION';bone.rotation_quaternion=rest.inverted() @ q @ rest
            bone.keyframe_insert('rotation_quaternion',frame=frame,group=bone.name)
    track=rig.animation_data.nla_tracks.new();track.name='Perch'
    strip=track.strips.new('Perch',1,action);strip.action_frame_start=1;strip.action_frame_end=49;track.mute=True
    rig.animation_data.action=None
bpy.context.scene.frame_set(5)
bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath,compress=True)
