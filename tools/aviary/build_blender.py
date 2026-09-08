"""Authored geometry + shared rig. Run via Blender MCP, or Blender --background --python.
Only replaces our named Aviary scene; never deletes other scenes or user edits.
"""
import bpy, math, json, os
from mathutils import Vector, Quaternion
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'assets-src/aviary'
OUT.mkdir(parents=True, exist_ok=True)
SPECS = [
 dict(id='pearl-gull', name='01  PEARL / Coastal Gull', x=-3.3, span=1.65, body=(.18,.43,.19), head=(0,-.39,.12), tail=.58, crest=False,
      colors=['#e5e6df','#879eac','#243d55','#f5c058','#fff6de'], beats=2),
 dict(id='lagoon-jay', name='02  LAGOON / Crested Jay', x=0, span=1.24, body=(.17,.34,.22), head=(0,-.29,.24), tail=.87, crest=True,
      colors=['#188d9d','#39c9c4','#142b50','#222b43','#b9f1df'], beats=3),
 dict(id='ember-kestrel', name='03  EMBER / Copper Kestrel', x=3.3, span=1.48, body=(.18,.34,.21), head=(0,-.30,.20), tail=.68, crest=False,
      colors=['#bc653d','#efac64','#323e58','#e9be57','#f0d9b6'], beats=4),
]
def linear(h):
    a=[int(h[i:i+2],16)/255 for i in (1,3,5)]
    return tuple(c/12.92 if c<=.04045 else ((c+.055)/1.055)**2.4 for c in a)+(1,)

def setup():
    old=bpy.data.scenes.get('AVIARY • Flight atelier')
    if old: bpy.data.scenes.remove(old)
    scene=bpy.data.scenes.new('AVIARY • Flight atelier')
    bpy.context.window.scene=scene
    scene.render.engine='CYCLES'; scene.cycles.samples=32
    scene.render.resolution_x=1600; scene.render.resolution_y=900; scene.render.resolution_percentage=100
    scene.render.fps=24; scene.frame_start=1; scene.frame_end=48
    scene.world=bpy.data.worlds.new('Aviary midnight studio'); scene.world.use_nodes=True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.12,.17,.23,1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value=.4
    scene.view_settings.view_transform='AgX'
    mat=bpy.data.materials.new('Aviary • pigment / zero textures'); mat.use_nodes=True
    bs=mat.node_tree.nodes.get('Principled BSDF'); bs.inputs['Roughness'].default_value=.57
    v=mat.node_tree.nodes.new('ShaderNodeVertexColor'); v.layer_name='Plumage'
    mat.node_tree.links.new(v.outputs['Color'],bs.inputs['Base Color'])
    return scene,mat

class Sculpt:
    def __init__(self,colors): self.v=[]; self.f=[]; self.c=[]; self.b=[]; self.colors=[linear(c) for c in colors]
    def vert(self,p,c,b):
        self.v.append(tuple(p)); self.c.append(self.colors[c] if isinstance(c,int) else c); self.b.append(b); return len(self.v)-1
    def face(self,*v): self.f.append(v)
    def ellipsoid(self,center,scale,c,b,segments=16,rings=10):
        base=len(self.v)
        for j in range(rings+1):
            ph=math.pi*j/rings
            for i in range(segments):
                th=2*math.pi*i/segments
                p=(center[0]+scale[0]*math.sin(ph)*math.cos(th),center[1]+scale[1]*math.sin(ph)*math.sin(th),center[2]+scale[2]*math.cos(ph))
                self.vert(p,c,b)
        for j in range(rings):
            for i in range(segments):
                a=base+j*segments+i; d=base+j*segments+(i+1)%segments
                self.face(a,d,d+segments,a+segments)
    def feather(self,start,end,width,c,b,curve=.035):
        # Closed, tapered feather with a raised rachis. No alpha cards.
        s,e=Vector(start),Vector(end); direction=(e-s).normalized()
        side=Vector((-direction.y,direction.x,0)).normalized()
        base=len(self.v)
        for t,w in [(0,.18),(.24,.87),(.57,1),(.84,.62),(1,.015)]:
            mid=s.lerp(e,t); mid.z+=math.sin(t*math.pi)*curve
            for k in range(4):
                p=mid+side*(math.cos(k*math.pi/2)*width*w)
                p.z+=math.sin(k*math.pi/2)*width*.18*w
                color=self.colors[c]; fac=1.12 if k==1 else (.88 if k==3 else 1)
                self.vert(p,tuple(min(1,x*fac) for x in color[:3])+(1,),b)
        for j in range(4):
            for k in range(4):
                a=base+j*4+k; d=base+j*4+(k+1)%4
                self.face(a,d,d+4,a+4)
        self.face(*[base+k for k in reversed(range(4))]); self.face(*[base+16+k for k in range(4)])
    def mesh(self,name,collection,mat):
        mesh=bpy.data.meshes.new(name); mesh.from_pydata(self.v,[],self.f); mesh.update()
        color=mesh.color_attributes.new(name='Plumage',type='FLOAT_COLOR',domain='POINT')
        for i,c in enumerate(self.c): color.data[i].color=c
        ob=bpy.data.objects.new(name,mesh); collection.objects.link(ob); ob.data.materials.append(mat)
        for poly in mesh.polygons: poly.use_smooth=True
        for bone in sorted(set(self.b)):
            vg=ob.vertex_groups.new(name=bone); vg.add([i for i,x in enumerate(self.b) if x==bone],1,'REPLACE')
        return ob

def bird(spec,mat):
    coll=bpy.data.collections.new(spec['name']); bpy.context.scene.collection.children.link(coll)
    m=Sculpt(spec['colors']); span=spec['span']; sid=spec['id']
    m.ellipsoid((0,0,0),spec['body'],0,'root',20,12)
    m.ellipsoid((0,-.11,-.075),(.145,.28,.14),4,'root')
    h=spec['head']; hs=.153 if sid!='pearl-gull' else .14
    m.ellipsoid(h,(hs,hs*.97,hs),0 if spec['crest'] else 4,'head',20,12)
    # Cheek accents, glossy eyes with small pale catchlights, tapered beak.
    for side in [-1,1]:
        x=side*hs*.86
        m.ellipsoid((x,h[1]-.022,h[2]+.026),(.038,.057,.044),2,'head',12,8)
        m.ellipsoid((side*(hs+.001),h[1]-.039,h[2]+.035),(.018,.024,.024),3 if sid=='ember-kestrel' else 2,'head',12,8)
        m.ellipsoid((side*(hs+.014),h[1]-.049,h[2]+.044),(.005,.007,.007),4,'head',8,6)
        if sid=='ember-kestrel':
            m.feather((side*.115,h[1]-.07,h[2]),(side*.12,h[1]+.01,h[2]-.13),.021,2,'head',.006)
    m.feather((0,h[1]-.105,h[2]-.018),(0,h[1]-(.33 if sid=='pearl-gull' else .245),h[2]-.052),.047,3,'head',.006)
    if spec['crest']:
        for i in range(5):
            m.feather(((i-2)*.029,h[1]+.015,h[2]+.11),((i-2)*.018,h[1]+.20,h[2]+.37-abs(i-2)*.04),.032,1 if i%2 else 2,'head',.015)
    for side in [-1,1]:
        suffix='L' if side>0 else 'R'
        wing='wing.'+suffix; tip='tip.'+suffix
        # Filled, aerodynamic coverts under the individual flight feathers.
        m.feather((side*.12,-.08,.065),(side*span*.71,.03,.015),.205,0,wing,.018)
        for i in range(9):
            t=i/8
            x=.23+(span*.56-.23)*t
            m.feather((side*x,-.095+t*.075,.053),(side*(x+.10),.33+t*.12,-.022),.062,1 if i%3 else 0,wing,.02)
        for i in range(9):
            t=i/8
            x=span*(.52+.31*t)
            endx=span*(.69+.31*t)
            endy=.46-.31*t
            m.feather((side*x,-.02,.02),(side*endx,endy,-.045),.075-(t*.022),2 if (sid=='pearl-gull' or i>5) else 0,tip,.028)
            # Contrasting upper feather panel, follows each primary.
            if sid!='pearl-gull':
                m.feather((side*x,-.023,.036),(side*(x+(endx-x)*.72),endy*.62,.023),.042,1 if i%2 else 0,tip,.023)
        for row in range(2):
            for i in range(8):
                t=i/7; x=.22+t*span*.55
                m.feather((side*x,-.115+row*.085,.087),(side*(x+.095),.03+row*.09,.066),.043,1 if (i+row)%3 else 0,wing,.018)
        # Tucked legs, three small toes.
        m.feather((side*.083,.18,-.12),(side*.08,.31,-.22),.018,3,'root',0)
        for j in range(3): m.feather((side*.08,.30,-.22),(side*.08+(j-1)*.025,.40,-.22),.008,3,'root',0)
    for i in range(7):
        t=(i-3)/3
        m.feather((t*.055,.23,.015),(t*.22,spec['tail']-.09*abs(t),-.04),.053,2 if i%3==0 else 0,'tail',.025)
        if sid!='pearl-gull': m.feather((t*.06,.36,.03),(t*.18,spec['tail']*.85-.06*abs(t),-.01),.033,1,'tail',.015)
    # Scalloped mantle feathers keep the torso from reading as a plain capsule.
    for row in range(4):
        for i in range(5):
            x=(i-2)*.048; y=-.10+row*.082
            z=.17*math.sqrt(max(.1,1-(x/.2)**2))
            m.feather((x,y,z),(x*.90,y+.17,z-.025),.029,1 if (i+row)%4==0 else 0,'root',.012)
    ob=m.mesh(sid+'.plumage',coll,mat)
    arm=bpy.data.armatures.new(sid+'.skeleton'); rig=bpy.data.objects.new(sid+'.rig',arm); coll.objects.link(rig)
    bpy.context.view_layer.objects.active=rig; rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    specs=[('root',(0,0,0),(0,-.2,0),None),('head',(0,-.25,.10),(0,-.48,.12),'root'),('tail',(0,.22,0),(0,.5,0),'root')]
    for side,suff in [(1,'L'),(-1,'R')]:
        specs.extend([('wing.'+suff,(side*.13,-.04,.04),(side*span*.56,-.02,.04),'root'),('tip.'+suff,(side*span*.56,-.02,.04),(side*span,.12,0),'wing.'+suff)])
    for name,head,tail,parent in specs:
        b=arm.edit_bones.new(name); b.head=head; b.tail=tail
        if parent:b.parent=arm.edit_bones[parent]
    bpy.ops.object.mode_set(mode='OBJECT'); rig.select_set(False)
    ob.parent=rig; mod=ob.modifiers.new('Shared flight skeleton','ARMATURE'); mod.object=rig
    rig.location=(spec['x'],0,1.9); rig.show_in_front=True
    rig['species_id']=sid; rig['preview_help']='Space to play. NLA tracks: Fly / Glide / Scatter. Solo a track to preview. Collections toggle each species.'
    ob['asset_role']='game_mesh'; rig['wingspan_m']=span*2
    rig.animation_data_create()
    for clip in ['Fly','Glide','Scatter']:
        action=bpy.data.actions.new(sid+'.'+clip); rig.animation_data.action=action
        action.use_fake_user=True
        for frame in range(1,50,2):
            t=(frame-1)/48; phase=t*2*math.pi*spec['beats']*(1.5 if clip=='Scatter' else 1)
            for bone in rig.pose.bones:
                angle=0; axis=Vector((0,1,0))
                if bone.name.startswith('wing.'):
                    sign=1 if bone.name.endswith('L') else -1
                    angle=sign*((.07+math.sin(t*2*math.pi)*.035) if clip=='Glide' else math.sin(phase)*(.68 if clip=='Scatter' else .49))
                elif bone.name.startswith('tip.'):
                    sign=1 if bone.name.endswith('L') else -1
                    angle=sign*(.08 if clip=='Glide' else math.sin(phase-.7)*.30)
                elif bone.name=='tail':axis=Vector((1,0,0));angle=.06*math.sin(phase+.7)+(.23 if clip=='Scatter' else 0)
                elif bone.name=='head':axis=Vector((0,0,1));angle=math.sin(t*math.pi*2)*(.18 if clip=='Glide' else .045)
                else:axis=Vector((1,0,0));angle=.035*math.sin(phase)
                rest=bone.bone.matrix_local.to_quaternion()
                bone.rotation_mode='QUATERNION';bone.rotation_quaternion=rest.inverted() @ Quaternion(axis,angle) @ rest
                bone.keyframe_insert('rotation_quaternion',frame=frame,group=bone.name)
        track=rig.animation_data.nla_tracks.new();track.name=clip
        strip=track.strips.new(clip,1,action);strip.action_frame_start=1;strip.action_frame_end=49
        track.mute=clip!='Fly'
    rig.animation_data.action=None
    return rig,ob

def studio(scene):
    coll=bpy.data.collections.new('00  STUDIO / hide for clean asset view');scene.collection.children.link(coll)
    def link(ob):
        for c in list(ob.users_collection):c.objects.unlink(ob)
        coll.objects.link(ob)
    def mat(name,col,metal=0):
        m=bpy.data.materials.new(name);m.diffuse_color=linear(col);m.use_nodes=True
        b=m.node_tree.nodes.get('Principled BSDF');b.inputs['Base Color'].default_value=linear(col);b.inputs['Roughness'].default_value=.5;b.inputs['Metallic'].default_value=metal;return m
    dark=mat('Studio • ink','#112936'); brass=mat('Studio • brushed brass','#c6a975',.55)
    bpy.ops.mesh.primitive_plane_add(size=200); floor=bpy.context.object;floor.name='Infinite studio floor';link(floor);floor.data.materials.append(dark)
    for spec in SPECS:
        bpy.ops.mesh.primitive_cylinder_add(vertices=64,radius=1.25,depth=.15,location=(spec['x'],0,.075));o=bpy.context.object;link(o);o.data.materials.append(dark)
        bevel=o.modifiers.new('Soft machined edge','BEVEL');bevel.width=.04;bevel.segments=3;o.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
        bpy.ops.mesh.primitive_torus_add(major_radius=1.23,minor_radius=.009,major_segments=64,minor_segments=6,location=(spec['x'],0,.153));o=bpy.context.object;link(o);o.data.materials.append(brass)
        curve=bpy.data.curves.new(spec['id']+'.label','FONT');curve.body=spec['name'].split('  ')[1].upper();curve.align_x='CENTER';curve.size=.17;curve.extrude=.001
        o=bpy.data.objects.new('Label • '+spec['id'],curve);coll.objects.link(o);o.location=(spec['x'],-1.43,.025);curve.materials.append(brass)
    def light(name,loc,power,size,color):
        data=bpy.data.lights.new(name,'AREA');data.energy=power;data.shape='DISK';data.size=size;data.color=color
        ob=bpy.data.objects.new(name,data);coll.objects.link(ob);ob.location=loc;ob.rotation_euler=(Vector((0,0,1))-ob.location).to_track_quat('-Z','Y').to_euler()
    light('Key / warm softbox',(0,-4,8),1700,8,(1,.87,.7));light('Rim / glacier',(2,4,6),2200,6,(.5,.8,1));light('Fill / pearl',(-6,-1,4),900,5,(.7,.95,1))
    data=bpy.data.cameras.new('Lineup camera');cam=bpy.data.objects.new('Lineup camera',data);coll.objects.link(cam)
    cam.location=(4,-11,8);cam.rotation_euler=(Vector((0,0,1.15))-cam.location).to_track_quat('-Z','Y').to_euler();data.type='ORTHO';data.ortho_scale=12.8;scene.camera=cam
    scene.render.filepath=str(ROOT/'.data/aviary/lineup.png')
    scene.frame_set(7)
    for area in bpy.context.screen.areas:
        if area.type in {'VIEW_3D','CONSOLE'}:
            area.type='VIEW_3D';area.spaces.active.region_3d.view_perspective='CAMERA';area.spaces.active.shading.type='MATERIAL'
    bpy.ops.object.select_all(action='DESELECT')
    for marker,frame in [('FLY • loop 1–49',1),('Wing downstroke',13),('Wing recovery',37)]:scene.timeline_markers.new(marker,frame=frame)
    text=bpy.data.texts.get('AVIARY — READ ME') or bpy.data.texts.new('AVIARY — READ ME')
    text.clear();text.write('AVIARY / three species, one portable pipeline\n\nSpace: play the active 48-frame flight loop.\nOutliner: toggle each numbered species collection.\nSelect a rig, switch to NLA Editor; mute Fly and unmute Glide or Scatter.\nEach bird has the same seven named bones and three editable actions.\nMesh colors are in the Plumage point-color attribute. No texture files.\n\nTo export edits (does not regenerate geometry):\nexec(compile(open(\"'+str(ROOT/'tools/aviary/export_blender.py')+'\").read(), \"export_blender.py\", \"exec\"))\nThen in terminal: npm run birds:pack\n\nRebuild original designs: npm run birds:build (overwrites generated .blend).\n')

if __name__=='__main__':
    scene,mat=setup()
    for spec in SPECS:bird(spec,mat)
    studio(scene)
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'aviary.blend'))
    print('AVIARY created:',len(scene.objects),'objects')
