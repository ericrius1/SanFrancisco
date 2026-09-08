"""Replace the blockout with GPT-reference / Tripo geometry, keep the common rig.
Re-running intentionally replaces the imported meshes, not the rigs or actions.
"""
import bpy,math
from mathutils import Matrix,Vector
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
SPECS=[('pearl-gull',3.3),('lagoon-jay',2.9),('ember-kestrel',3.2)]
# Tripo default bird coordinates: span along Y, head along Z, dorsal along X.
ROT=Matrix(((0,-1,0),(0,0,-1),(1,0,0)))
for sid,span in SPECS:
    rig=bpy.data.objects[sid+'.rig'];coll=rig.users_collection[0]
    for ob in list(coll.objects):
        if ob.type=='MESH':bpy.data.objects.remove(ob,do_unlink=True)
    # Remove the earlier inspection-only import if present.
    for ob in list(bpy.context.scene.objects):
        if ob.name.startswith('tripo_node_'):bpy.data.objects.remove(ob,do_unlink=True)
    bpy.ops.import_scene.gltf(filepath=str(ROOT/'assets-src/aviary/source'/(sid+'.glb')))
    meshes=[o for o in bpy.context.selected_objects if o.type=='MESH']
    assert len(meshes)==1
    ob=meshes[0];ob.name=sid+'.plumage'
    bpy.context.view_layer.objects.active=ob
    bpy.ops.object.transform_apply(location=False,rotation=True,scale=True)
    for c in list(ob.users_collection):c.objects.unlink(ob)
    coll.objects.link(ob)
    if sid=='ember-kestrel':
        # v3 was generated in a horizontal flight pose, already X-span / -Y-forward.
        ob.data.transform(Matrix.Scale(span,4))
    else:
        for v in ob.data.vertices:v.co=ROT @ v.co * span
        if sid=='pearl-gull':
            ob.data.transform(Matrix.Rotation(math.pi/2,4,'X'))
            ob.data.transform(Matrix.Rotation(math.pi,4,'Y'))
        import numpy as np
        coords=np.array([v.co[:] for v in ob.data.vertices]); wings=coords[np.abs(coords[:,0])>.5]
        slope=float(np.polyfit(wings[:,1],wings[:,2],1)[0])
        ob.data.transform(Matrix.Rotation(-math.atan(slope),4,'X'))
        coords=np.array([v.co[:] for v in ob.data.vertices]); inner=coords[(np.abs(coords[:,0])>.35)&(np.abs(coords[:,0])<.55)]
        origin=Vector((0,float(np.median(inner[:,1]))-.13,float(np.median(inner[:,2]))))
        for v in ob.data.vertices:v.co-=origin
    ob.data.update()
    # Keep the first version unrigged in rest pose for visual orientation QA.
    ob.location=rig.location;ob['asset_role']='game_mesh';ob['concept_reference']=str(ROOT/'assets-src/aviary'/({'pearl-gull':'pearl','lagoon-jay':'lagoon','ember-kestrel':'ember'}[sid]+('-reference-v3.png' if sid=='ember-kestrel' else '-reference-v2.png')))
    for mat in ob.data.materials:
        bs=mat.node_tree.nodes.get('Principled BSDF')
        if bs:
            # Feather color/normal carry detail. Uniform satin roughness avoids
            # paying for a nearly uniform 4K ORM texture in the runtime.
            for key in ['Metallic','Roughness']:
                for link in list(bs.inputs[key].links):mat.node_tree.links.remove(link)
            bs.inputs['Metallic'].default_value=0;bs.inputs['Roughness'].default_value=.68
    print(sid,'bounds',[(round(min(v.co[i] for v in ob.data.vertices),3),round(max(v.co[i] for v in ob.data.vertices),3)) for i in range(3)])
scene=bpy.context.scene
scene.camera.location=(4,-11,10)
scene.camera.rotation_euler=(Vector((0,0,1.45))-scene.camera.location).to_track_quat('-Z','Y').to_euler()
scene.camera.data.ortho_scale=12.7
scene.cycles.samples=32
scene.render.filepath=str(ROOT/'.data/aviary/refine-lineup.png')
scene.frame_set(1)
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'assets-src/aviary/aviary.blend'),compress=True)
