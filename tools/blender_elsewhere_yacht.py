"""Reproducible Elsewhere yacht. Blender coordinates are (game x, -game z, game y).
Run: /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/blender_elsewhere_yacht.py
Source .blend and raw export live under .data; only packed GLB ships.
"""
import bpy, math, random, os
from mathutils import Vector
random.seed(71)
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT=os.path.join(ROOT,'.data/yacht'); os.makedirs(OUT,exist_ok=True)
def mat(name,hex,metal=0,rough=.5,emission=0):
    rgb=tuple(int(hex[i:i+2],16)/255 for i in (0,2,4)); m=bpy.data.materials.new(name); m.diffuse_color=(*rgb,1); m.use_nodes=True
    p=m.node_tree.nodes.get('Principled BSDF'); p.inputs['Base Color'].default_value=(*rgb,1); p.inputs['Metallic'].default_value=metal; p.inputs['Roughness'].default_value=rough
    p.inputs['Emission Color'].default_value=(*rgb,1); p.inputs['Emission Strength'].default_value=emission
    return m
pearl=mat('Pearl ceramic','e9eee8',.25,.29); navy=mat('Midnight hull','102e3e',.35,.32); teal=mat('Lagoon upholstery','168c91'); wood=mat('Honey teak','ad7950'); gold=mat('Champagne brass','d8b572',.65,.28); glass=mat('Smoked blue glazing','284e60',.5,.18); coral=mat('Coral velvet','eb856d'); white=mat('Warm linen','fff1d6'); water=mat('Luminous pool mosaic','31cbd1',.3,.17,.18); pink=mat('Rose lantern','ef91b7',.1,.5,.35); ink=mat('Night library','20253f'); glow=mat('Starlight','b0f4e8',0,.4,1.4)
parts=[]
def xyz(p): return (p[0],-p[2],p[1])
def finish(o,name,m):
    o.name=name; o.data.materials.append(m); parts.append(o); return o
def box(name,p,s,m,bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1,location=xyz(p)); o=bpy.context.object; o.dimensions=(s[0],s[2],s[1]); bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    if bevel:
        mod=o.modifiers.new('Soft crafted edges','BEVEL'); mod.width=bevel; mod.segments=3; bpy.context.view_layer.objects.active=o; bpy.ops.object.modifier_apply(modifier=mod.name)
        o.modifiers.new('Weighted corner normals','WEIGHTED_NORMAL'); bpy.ops.object.modifier_apply(modifier=o.modifiers[-1].name)
    return finish(o,name,m)
def uv(name,p,s,m):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16,ring_count=8,location=xyz(p)); o=bpy.context.object; o.scale=(s[0],s[2],s[1]); bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    for f in o.data.polygons:f.use_smooth=True
    return finish(o,name,m)
def cyl(name,p,r,d,m):
    bpy.ops.mesh.primitive_cylinder_add(vertices=24,radius=r,depth=d,location=xyz(p)); return finish(bpy.context.object,name,m)
def line(name,a,b,r,m):
    av=Vector(xyz(a)); bv=Vector(xyz(b)); mid=(av+bv)/2; bpy.ops.mesh.primitive_cylinder_add(vertices=8,radius=r,depth=(bv-av).length,location=mid); o=bpy.context.object; o.rotation_euler=(bv-av).to_track_quat('Z','Y').to_euler(); return finish(o,name,m)
def text(name,p,size,m,face='floor'):
    bpy.ops.object.text_add(location=xyz(p)); o=bpy.context.object; o.data.body=name; o.data.align_x='CENTER'; o.data.size=size; o.data.extrude=.003
    if face=='wall':o.rotation_euler=(math.pi/2,0,0)
    bpy.ops.object.convert(target='MESH'); return finish(bpy.context.object,'Lettering '+name,m)
def outline(name,y,depth,w,z0,z1,m):
    pts=[(0,z0),(.48*w,z0+3),(.85*w,z0+8),(w,z0+16),(w,z1-3),(.85*w,z1),(-.85*w,z1),(-w,z1-3),(-w,z0+16),(-.85*w,z0+8),(-.48*w,z0+3)]
    vs=[xyz((x,h,z)) for h in [y-depth,y] for x,z in pts]; n=len(pts); fs=[tuple(range(n-1,-1,-1)),tuple(range(n,2*n))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    me=bpy.data.meshes.new(name);me.from_pydata(vs,[],[tuple(reversed(f)) for f in fs]);me.update();o=bpy.data.objects.new(name,me);bpy.context.collection.objects.link(o);finish(o,name,m);return o
def pool(x,y,z,w,l):
    box('Pool surround',(x,y+.1,z),(w+.65,.25,l+.65),pearl,.18);box('Mosaic basin',(x,y+.24,z),(w,.13,l),water,.15)
    for i in range(1,int(l*2)):
        box('Pool tile glint',(x,y+.313,z-l/2+i*.5),(w-.2,.01,.023),white)
    for sx in [-1,1]:line('Pool ladder',(x+sx*.3,y+.3,z+l/2),(x+sx*.3,y+1,z+l/2+.4),.035,gold)
def sofa(x,y,z,m=teal):
    box('Floating sofa plinth',(x,y+.2,z),(2.9,.35,1.15),gold,.1);box('Velvet seat',(x,y+.48,z),(3,.36,1.25),m,.16);box('Curved sofa back',(x,y+.85,z+.52),(3,.75,.24),m,.12)
    for xx in [-1,1]:box('Linen cushion',(x+xx,y+.8,z+.25),(.55,.5,.2),white,.08)
def pad(z,y,number):
    cyl('Helipad '+number,(0,y,z),6,.18,navy)
    # broken brass ring and the two bars of H
    for i in range(64):
        a=i*math.tau/64;b=(i+.8)*math.tau/64;line('Landing circle',(5.1*math.cos(a),y+.105,z+5.1*math.sin(a)),(5.1*math.cos(b),y+.105,z+5.1*math.sin(b)),.045,gold)
    for x in [-1,1]:box('Helipad H',(x,y+.12,z),(.32,.025,3.4),white)
    box('Helipad H bridge',(0,y+.12,z),(2,.025,.32),white);text(number,(0,y+.13,z+4),.55,gold)
# Swept full-size hull, 76m long, with stepped terraces.
outline('Deep blue displacement hull',2.9,5,10,-40,36,navy);outline('Champagne sheer line',3,.16,10.05,-40,36,gold);outline('Main teak promenade',3.15,.15,9.85,-39.7,35.8,wood)
for y,w,z0,z1 in [(7.15,8,-18,29),(11.15,6.7,-15,26)]:
    deck=outline('Sculpted terrace edge',y,.48,w,z0,z1,pearl);inlay=outline('Teak terrace inlay',y+.04,.05,w-.25,z0+.3,z1-.25,wood)
    if y>10:
        cutter=box('Temporary pool skylight',(0,y,7),(6.2,2,9),pearl)
        for o in [deck,inlay]:
            mod=o.modifiers.new('Open sky over infinity pool','BOOLEAN');mod.operation='DIFFERENCE';mod.object=cutter;bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=mod.name)
        parts.remove(cutter);bpy.data.objects.remove(cutter,do_unlink=True)
        for sx in [-1,1]:
            for z in range(3,12,2):line('Skylight safety rail',(sx*3.15,y,z),(sx*3.15,y+1,z),.03,gold)
            line('Skylight top rail',(sx*3.15,y+1,2.5),(sx*3.15,y+1,11.5),.035,gold)
# Long sweeping railings with brass stanchions and three horizontal strands.
for y,w,z0,z1 in [(3.15,9.65,-23,34),(7.19,7.7,-2,27),(11.19,6.4,1,24)]:
    for sx in [-1,1]:
        for z in range(int(z0),int(z1)+1,3):line('Rail stanchion',(sx*w,y,z),(sx*w,y+1.05,z),.035,gold)
        for h in [.4,.72,1.05]:line('Continuous rail',(sx*w,y+h,z0),(sx*w,y+h,z1),.024,pearl)
# Main salon walls; center passage stays open. Rooms occupy either side.
for sx in [-1,1]:
    box('Salon glazing',(sx*6.8,5,-1),(.12,3.4,25),glass)
    for z in [-13,-5,3,11]:box('Pearl window mullion',(sx*6.7,5,z),(.25,3.8,.2),pearl)
    for z in [-5,3]:box('Cabin partition',(sx*4.25,5,z),(4.8,3.7,.18),pearl)
box('Salon forward wall',(0,5,-13),(13.6,3.7,.2),pearl)
# Listening lounge, art salon, dining club, guest suite.
for x,z,m in [(-4,-9,coral),(4,-9,teal),(-4,-1,teal),(4,7,coral)]:sofa(x,3.2,z,m);cyl('Brass cocktail table',(x,3.8,z-1.4),.7,.12,gold)
box('Guest suite king bed',(-4,3.7,7),(3.4,.85,3.8),white,.2);box('Velvet bed runner',(-4,4.16,7.6),(3.45,.04,1),teal)
box('Dining table',(4,4.1,-.7),(2.2,.15,4),wood,.15)
for z in [-2,0,1]:
    for x in [2.2,5.8]:box('Dining chair',(x,3.8,z),(.7,1,.7),coral,.12)
# Piano: recognizable keys, curved body, raised lid.
box('Midnight grand piano',(-4.5,4.1,-11),(2.5,.65,1.6),navy,.3)
for i in range(19):box('Ivory piano key',(-5.6+i*.12,4.47,-10.35),(.105,.06,.44),white)
for i in range(13):box('Ebony piano key',(-5.5+i*.16,4.53,-10.5),(.055,.05,.23),ink)
# Gallery artworks: physical brass frames and jewel-tone abstract constellations.
for x,z in [(-4.1,-4.87),(4.1,-4.87),(-4.1,3.13),(4.1,3.13)]:
    box('Gallery brass frame',(x,5.25,z),(2.35,1.65,.1),gold,.04);box('Gallery canvas',(x,5.25,z+.06),(2.16,1.46,.04),ink)
    for i in range(9):uv('Painted orbital study',(x+random.uniform(-.85,.85),random.uniform(4.7,5.8),z+.12),(.08+random.random()*.18,.08+random.random()*.17,.035),[coral,teal,gold,pink][i%4])
# Main pool, sunbeds and bow heliport.
pool(0,3.2,31.5,6,5);pad(-29,3.32,'01')
for x in [-6.5,6.5]:
    for z in [16,20,24,28]:box('Sun lounger',(x,3.65,z),(1.4,.6,2.5),white,.2);box('Rolled pool towel',(x,4,z+.7),(1.1,.15,.35),teal,.08)
# Bridge / observatory: walls leave aft entry and generous side promenades.
for x in [-4.8,4.8]:box('Bridge window',(x,9,-7),(.1,3,12),glass)
box('Forward panoramic glazing',(0,9,-13),(9.6,3,.1),glass);box('Helm console',(0,7.9,-11),(5,1.3,1),pearl,.2)
for x in [-1.5,0,1.5]:box('Navigation screen',(x,8.64,-11),(1.1,.035,.6),glow)
sofa(-3,7.2,-4);sofa(3,7.2,-4,coral)
pool(0,7.23,7,5,7)
# Top spa: hot tub and sculpture garden (no foliage).
cyl('Hot tub marble rim',(0,11.5,-5),2.35,.65,pearl);cyl('Hot tub turquoise water',(0,11.86,-5),1.95,.04,water)
for i in range(16):a=i*math.tau/16;uv('Spa foam',(1.65*math.cos(a),11.9,-5+1.65*math.sin(a)),(.1,.025,.1),white)
pad(18,11.35,'02');sofa(-3.6,11.2,1,coral);sofa(3.6,11.2,1)
# Two flights of real stairs in side promenades. Shared nav uses these same dimensions.
for x,y,z in [(8.5,3.15,5),(-6,7.19,0)]:
    for i in range(20):box('Promenade stair',(x,y+(i+1)*.101,z-i*.4),(1.7,(i+1)*.202,.4),pearl)
    line('Stair handrail',(x+.8,y+1,z+.2),(x+.8,y+5,z-7.8),.04,gold)
# Secret room behind a hinged star painting, entered from the main passage.
box('Hidden room floor',(0,3.23,-19),(9,.16,10),ink)
for x in [-4.5,4.5]:box('Hidden chamber wall',(x,5.1,-19),(.14,3.8,10),ink)
box('Hidden chamber bow wall',(0,5.1,-24),(9,3.8,.14),ink)
box('Secret ceiling',(0,6.85,-19),(9,.15,10),ink)
# Door remains a separate animated node at x=0, y=4.8, z=-13.
secret=box('SecretDoor',(0,4.9,-12.86),(2.1,3.4,.14),ink,.03)
# brass star on door, bound to door
for i in range(5):
    a=i*math.tau/5; b=(i+2)*math.tau/5;o=line('Door star',(.65*math.sin(a),5+.65*math.cos(a),-12.74),(.65*math.sin(b),5+.65*math.cos(b),-12.74),.024,gold);mw=o.matrix_world.copy();o.parent=secret;o.matrix_world=mw
# Door cutout: replace center of forward wall.
for o in list(parts):
    if o.name=='Salon forward wall':parts.remove(o);bpy.data.objects.remove(o,do_unlink=True)
for x in [-3.9,3.9]:box('Salon forward wall',(x,5,-13),(5.7,3.7,.2),pearl)
# The museum of things that almost happened: a whale carrying tiny houses.
uv('Dream whale',(0,4.55,-20),(2.1,.6,.85),teal);uv('Whale tail',(2.1,4.7,-20),(.65,.13,.7),gold)
for x in [-1,0,1]:
    box('Tiny remembered home',(x,5.2,-20),(.48,.6,.48),[coral,white,pink][int(x)+1],.04)
    vs=[xyz((x+dx,y,z)) for dx,y,z in [(-.3,5.5,-20.3),(.3,5.5,-20.3),(0,5.83,-20.3),(-.3,5.5,-19.7),(.3,5.5,-19.7),(0,5.83,-19.7)]]
    me=bpy.data.meshes.new('Little gabled roof');me.from_pydata(vs,[],[(0,2,1),(3,4,5),(0,1,4,3),(1,2,5,4),(2,0,3,5)]);me.update();o=bpy.data.objects.new('Little gabled roof',me);bpy.context.collection.objects.link(o);finish(o,'Little gabled roof',gold)
    box('A light left on for you',(x,5.25,-19.752),(.17,.2,.03),glow,.015)
    box('Tiny front door',(x+.14,5.08,-19.75),(.1,.24,.03),wood,.01)
for z in [-20.67,-19.33]:uv('Whale flipper',(-.35,4.23,z),(.75,.12,.47),teal)
uv('Whale kind eye',(-1.45,4.72,-19.34),(.13,.13,.08),white);uv('Whale eye pupil',(-1.46,4.73,-19.265),(.055,.055,.025),ink)
for i in range(7):
    x=-1.82+i*.13;xx=x+.13
    line('A small whale smile',(x,4.34+.16*((x+1.35)/.5)**2,-19.32),(xx,4.34+.16*((xx+1.35)/.5)**2,-19.32),.018,gold)
for z in [-20.4,-19.6]:uv('Whale tail fluke',(2.28,4.7,z),(.65,.12,.4),gold)
for i in range(45):
    x=random.uniform(-4,4); z=random.uniform(-23,-15);uv('Suspended wishing star',(x,random.uniform(5.8,6.6),z),(.035,.035,.035),glow)
sofa(0,3.3,-16,coral);text('A PLACE FOR YOUR ALMOSTS',(0,5.7,-23.85),.32,gold,'wall');text('You do not have to become anything to belong here.',(0,5.12,-23.8),.17,white,'wall')
# Hull/wayfinding typography.
text('E L S E W H E R E',(0,3.34,35),.5,white)
for label,x,y,z in [('ART / SOUND',0,3.3,10),('SKY SPA',0,11.28,5),('THE LONG WAY HOME',0,7.29,14)]:text(label,(x,y,z),.35,gold)
# Helicopter lives in a separate movable root, with separate rotor node.
start=len(parts);uv('Helicopter pearl fuselage',(0,13.3,18),(1.3,1.15,2.8),pearl);uv('Helicopter cockpit canopy',(0,13.48,16.3),(1.19,.85,1.28),glass)
line('Helicopter tail boom',(0,13.3,20),(0,14,25),.23,teal);box('Helicopter tail fin',(0,14.6,24.5),(.12,1.8,1.2),pearl,.1)
for x in [-1.4,1.4]:
    line('Landing skid',(x,11.55,15.8),(x,11.55,20.3),.09,navy)
    for z in [17,19]:line('Landing gear',(x*.6,12.8,z),(x,11.55,z),.07,gold)
line('Rotor mast',(0,14,18),(0,15.1,18),.12,gold)
rotor=box('HelicopterRotor',(0,15.15,18),(11,.065,.28),navy,.04);r2=box('Rotor cross',(0,15.15,18),(.28,.065,11),navy,.04);mw=r2.matrix_world.copy();r2.parent=rotor;r2.matrix_world=mw
heli=bpy.data.objects.new('Helicopter',None);bpy.context.collection.objects.link(heli);heli.location=xyz((0,11.35,18));bpy.context.view_layer.update()
for o in parts[start:]:
    if o.parent is None:mw=o.matrix_world.copy();o.parent=heli;o.matrix_world=mw
# Batch static parts by material. Keep moving door / helicopter separate.
static=[o for o in parts if o.parent is None and o!=secret and o!=heli]
for m in bpy.data.materials:
    group=[o for o in list(bpy.context.scene.objects) if o.type=='MESH' and o.parent is None and o!=secret and o.data.materials and o.data.materials[0]==m]
    if not group:continue
    bpy.ops.object.select_all(action='DESELECT')
    for o in group:o.select_set(True)
    bpy.context.view_layer.objects.active=group[0];bpy.ops.object.join();bpy.context.object.name='Yacht_'+m.name.replace(' ','_')
# Helicopter static components also batch by material, preserving parent transforms.
for m in bpy.data.materials:
    group=[o for o in list(heli.children) if o.type=='MESH' and o!=rotor and o.data.materials[0]==m]
    if len(group)<2:continue
    bpy.ops.object.select_all(action='DESELECT')
    for o in group:o.select_set(True)
    bpy.context.view_layer.objects.active=group[0];bpy.ops.object.join()
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT,'elsewhere.blend'))
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT,'elsewhere-raw.glb'),export_format='GLB',export_yup=True,export_apply=True,export_cameras=False,export_lights=False)
print('YACHT_EXPORT',sum(len(o.data.polygons) for o in bpy.context.scene.objects if o.type=='MESH'))
