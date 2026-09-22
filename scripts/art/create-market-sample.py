"""LAST MILE: an editable, metre-scale storefront and intelligence stall.
Blender 5.2; world helpers accept the game's (x, height, z) coordinates.
Creates only neutral presentation assets. No narrative state, evidence or APIs.
Run via pnpm build:market-art. Render is optional (--render).
"""
import bpy, math, random, json, sys, time
from pathlib import Path
from mathutils import Vector
from collections import defaultdict

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'assets/authoring/market-sample-v1'
PUBLIC = ROOT / 'client/public/assets/market'
random.seed(220926)
START = time.time()
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for data in list(bpy.data.materials): bpy.data.materials.remove(data)

# (game X, up, game Z) -> Blender (X, -Z, up), preserving handedness.
def co(p): return (p[0], -p[2], p[1])
def srgb(v): return v/12.92 if v <= .04045 else ((v+.055)/1.055)**2.4
def rgb(h):
    h=h.lstrip('#'); return tuple(srgb(int(h[i:i+2],16)/255) for i in (0,2,4))+(1,)

def mat(name, color, rough=.8, metal=0, texture=None):
    m=bpy.data.materials.new(name);m.use_nodes=True
    bs=m.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=rgb(color)
    bs.inputs['Roughness'].default_value=rough;bs.inputs['Metallic'].default_value=metal
    if texture:
        for slot, socket in [('baseColor','Base Color'),('roughness','Roughness'),('normal',None)]:
            if texture=='fabric_pattern_07' and slot=='baseColor': continue
            image=bpy.data.images.load(str(OUT/'textures'/f'{texture}_{slot}.jpg'),check_existing=True)
            if slot!='baseColor': image.colorspace_settings.name='Non-Color'
            node=m.node_tree.nodes.new('ShaderNodeTexImage');node.image=image
            if slot=='normal':
                n=m.node_tree.nodes.new('ShaderNodeNormalMap');n.inputs['Strength'].default_value=.85
                m.node_tree.links.new(node.outputs['Color'],n.inputs['Color'])
                m.node_tree.links.new(n.outputs['Normal'],bs.inputs['Normal'])
            else:m.node_tree.links.new(node.outputs['Color'],bs.inputs[socket])
    return m

M={
 'plaster':mat('01 / scanned aged lime plaster','#d5c1a2',texture='beige_wall_001'),
 'paving':mat('02 / worn stone paving','#b3a68c',texture='cobblestone_floor_08'),
 'wood':mat('03 / timber grain','#806348',texture='wood_table_001'),
 'canvas':mat('04 / woven canopy','#aea186',texture='fabric_pattern_07'),
 'stone':mat('05 / dressed limestone','#cabb9f'),
 'teal':mat('06 / oxidised teal paint','#355e59',.78),
 'edge':mat('07 / exposed wood edges','#94816a'),
 'iron':mat('08 / dark iron','#34403d',.59,.65),
 'brass':mat('09 / worn brass','#aa9570',.46,.55),
 'glass':mat('10 / dark glass','#263c3d',.22,.15),
 'pot':mat('11 / unglazed terracotta','#ae795c'),
 'leaf':mat('12 / olive foliage','#617355'),
 'leaflight':mat('13 / leaf tips','#879367'),
 'flower':mat('14 / bougainvillea','#b45965'),
 'olive':mat('15 / field equipment','#596058',.65),
 'black':mat('16 / rubber and fabric','#252b2a',.88),
 'paper':mat('17 / neutral paper','#c8c2ae'),
 'cream':mat('18 / canvas trim','#a59474'),
 'soil':mat('19 / soil','#64594a'),
}
GROUP='shop'
objects=[]

def mesh(name, verts, faces, material, uvscale=1, bevel=0, smooth=False):
    me=bpy.data.meshes.new(name);me.from_pydata([co(v) for v in verts],[],faces);me.update()
    obj=bpy.data.objects.new(name,me);bpy.context.collection.objects.link(obj)
    obj.data.materials.append(M[material]);obj['sector']=GROUP
    uv=me.uv_layers.new(name='UVMap')
    # World-size box projection; continuous stone courses on adjacent wall pieces.
    for p in me.polygons:
        normal=p.normal;axis=max(range(3),key=lambda a:abs(normal[a]))
        for li in p.loop_indices:
            v=me.vertices[me.loops[li].vertex_index].co
            coords=(v.y,v.z) if axis==0 else ((v.x,v.z) if axis==1 else (v.x,v.y))
            uv.data[li].uv=(coords[0]/uvscale,coords[1]/uvscale)
        p.use_smooth=smooth
    if bevel:
        mod=obj.modifiers.new('Manufactured edge radius','BEVEL');mod.width=bevel;mod.segments=2
        mod.affect='EDGES'
        normal=obj.modifiers.new('Weighted corner normals','WEIGHTED_NORMAL');normal.keep_sharp=True
    objects.append(obj);return obj

def box(name,x,y,z,w,h,d,material,bevel=.014,uvscale=1):
    v=[(x+sx*w/2,y+sy*h/2,z+sz*d/2) for sx,sy,sz in
       [(-1,-1,-1),(-1,-1,1),(-1,1,-1),(-1,1,1),(1,-1,-1),(1,-1,1),(1,1,-1),(1,1,1)]]
    # Winding is corrected below once for all authoring meshes.
    return mesh(name,v,[(0,4,5,1),(2,3,7,6),(0,2,6,4),(1,5,7,3),(0,1,3,2),(4,6,7,5)],material,uvscale,bevel)

def tube(name, points, radius, material, sides=8):
    # Each ring follows its local tangent; end caps support correct shadows.
    v=[]
    for i,p in enumerate(points):
        tangent=Vector(points[min(i+1,len(points)-1)])-Vector(points[max(0,i-1)])
        tangent.normalize();ref=Vector((0,1,0)) if abs(tangent.y)<.9 else Vector((1,0,0))
        a=tangent.cross(ref).normalized();b=tangent.cross(a).normalized()
        for j in range(sides):
            q=Vector(p)+radius*(math.cos(j*math.tau/sides)*a+math.sin(j*math.tau/sides)*b);v.append(tuple(q))
    faces=[tuple(reversed(range(sides))),tuple((len(points)-1)*sides+j for j in range(sides))]
    for i in range(len(points)-1):
        for j in range(sides):faces.append((i*sides+j,i*sides+(j+1)%sides,(i+1)*sides+(j+1)%sides,(i+1)*sides+j))
    return mesh(name,v,faces,material,1,0,True)

def lathe(name,x,y,z,profile,material,sides=24):
    v=[(x+r*math.cos(j*math.tau/sides),y+height,z+r*math.sin(j*math.tau/sides)) for height,r in profile for j in range(sides)]
    f=[]
    for k in range(len(profile)-1):
        for j in range(sides):f.append((k*sides+j,k*sides+(j+1)%sides,(k+1)*sides+(j+1)%sides,(k+1)*sides+j))
    return mesh(name,v,f,material,1,0,True)

def cable(name,a,b,sag,material='iron',radius=.012):
    pts=[]
    for i in range(25):
        t=i/24;pts.append((a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t-sag*4*t*(1-t),a[2]+(b[2]-a[2])*t))
    return tube(name,pts,radius,material,6)

def shutter(z,y,w=1.05,h=1.5,x=-6.36):
    box('Window recess',x-.18,y,z,.09,h+.14,w+.14,'black')
    for dy in [-h/2-.08,h/2+.08]:box('Limestone window frame',x,y+dy,z,.24,.14,w+.45,'stone')
    for dz in [-w/2-.08,w/2+.08]:box('Limestone window jamb',x,y,z+dz,.22,h,.14,'stone')
    box('Stone sill',x+.12,y-h/2-.14,z,.48,.14,w+.5,'stone',.025)
    for dz in [-w/4,w/4]:
        for side in [-1,1]:box('Teal shutter stile',x+.02,y,z+dz+side*w/4*.86,.10,h-.08,.06,'teal',.006)
        for j in range(12):
            leaf=box('Louver slat',x+.06,y-h/2+.12+j*(h-.24)/11,z+dz,.07,.079,w/2-.06,'teal',.004)
            # Actual diagonal slat depth, rather than a painted-on window.
            # Vertices are already in world space; tilt about the slat centre.
            pivot=Vector(co((x+.06,y-h/2+.12+j*(h-.24)/11,z+dz)))
            from mathutils import Matrix
            rot=Matrix.Rotation(.22,3,'Y')
            for vertex in leaf.data.vertices: vertex.co=pivot+rot@(vertex.co-pivot)
        for dy in [-h/2+.06,h/2-.06]:box('Shutter cross rail',x+.08,y+dy,z+dz,.08,.075,w/2,'edge',.004)
        for dy in [-.48,.48]:box('Hinge strap',x+.13,y+dy,z+dz,.045,.035,w/2-.1,'iron',.004)
    tube('Window latch',[(x+.16,y-.05,z-.12),(x+.16,y-.05,z+.12)],.018,'brass')

# HERO SHOP: shallow facade pieces leave real door/window reveals.
box('Shop back',-9.7,3.6,7,5.6,7.2,7,'plaster',.04,3.4)
# The street face is at -6.5; lower openings are built around, never pasted on.
for za,zb,low,high in [(3.5,4.9,0,3.3),(6.5,8.05,0,3.3),(9.55,10.5,0,3.3),
                      (4.9,6.5,0,1.05),(4.9,6.5,2.5,3.3),(8.05,9.55,2.72,3.3)]:
    box('Facade masonry',-6.67,(low+high)/2,(za+zb)/2,.34,high-low,zb-za,'plaster',.014,3.4)
# Upper floor with inset shutters in the surface.
box('Upper wall',-6.58,5.27,7,.3,3.94,7,'plaster',.025,3.4)
for height,projection in [(0.2,.18),(3.32,.30),(7.15,.36)]:
    box('Continuous dressed cornice',-6.4-projection/2,height,7,projection,.22,7.24,'stone',.028)
for z in [3.55,10.42]:
    for y in [i*.38+.2 for i in range(18)]:box('Quoin block',-6.37,y,z,.28,.355,.42,'stone',.028)
# Window shopfront and door: timber sits behind masonry face.
shutter(5.7,1.79,1.42,1.26,x=-6.62)
for dz in [-.76,.76]:box('Door stone jamb',-6.38,1.38,8.8+dz,.28,2.7,.16,'stone')
box('Door lintel',-6.4,2.82,8.8,.34,.26,1.98,'stone',.035)
box('Threshold',-6.31,.08,8.8,.62,.16,1.64,'stone',.03)
box('Door shadow gap',-6.8,1.35,8.8,.05,2.65,1.5,'black')
for dz in [-.36,.36]:
    box('Door leaf',-6.72,1.34,8.8+dz,.12,2.58,.69,'teal')
    for yy,hh in [(.67,.86),(1.82,1.10)]:
        box('Raised wood panel',-6.63,yy,8.8+dz,.08,hh,.49,'teal',.012)
        for zz in [-.27,.27]:box('Panel moulding',-6.57,yy,8.8+dz+zz,.045,hh+.09,.033,'edge',.006)
        for dy in [-hh/2-.035,hh/2+.035]:box('Panel rail',-6.57,yy+dy,8.8+dz,.045,.032,.54,'edge',.004)
    tube('Door brass handle',[(-6.50,1.17,8.8+dz),(-6.48,1.17,8.8+dz+.15)],.017,'brass')
# Protected upper floor, balcony, brackets.
for z in [5.1,8.9]:shutter(z,5.10,1.15,1.65)
box('Balcony stone slab',-5.93,3.65,8.5,1.12,.22,2.25,'stone',.03)
for z in [7.45,9.55]:
    tube('Balcony diagonal support',[(-6.45,3.05,z),(-5.4,3.57,z)],.06,'iron')
    tube('Balcony side top rail',[(-6.4,4.64,z),(-5.4,4.64,z)],.03,'iron')
for i in range(12):tube('Forged baluster',[(-5.4,3.76,7.44+i*.192),(-5.4,4.64,7.44+i*.192)],.017,'iron')
for y in [3.86,4.64]:tube('Balcony front rail',[(-5.4,y,7.4),(-5.4,y,9.6)],.027,'iron')
for z in [3.8,4.5,5.2,5.9,6.6,7.3,8,8.7,9.4,10.1]:
    box('Roof beam end',-6.17,6.95,z,.8,.18,.18,'wood',.018)
# Roof parapet readable from other angles.
box('Parapet',-6.55,7.46,7,.35,.55,7.3,'plaster',.025,3.4)
box('Parapet cap',-6.54,7.77,7,.52,.13,7.43,'stone',.025)
# Utility conduits / lamp: restrained environmental storytelling, no evidence.
for y in [3.0,3.06]:cable('Facade cable',(-6.30,y,3.5),(-6.30,y+.16,10.6),.1)
tube('Downpipe',[(-6.26,6.9,10.19),(-6.22,3.4,10.19),(-6.21,.1,10.19)],.046,'iron',12)
for y in [.7,2.1,3.4,5.1,6.6]:box('Pipe bracket',-6.26,y,10.19,.16,.055,.16,'brass',.005)
tube('Wall lamp crook',[(-6.36,2.75,8),(-5.98,2.75,8),(-5.91,2.61,8)],.028,'iron')
lathe('Lamp shade',-5.91,2.46,8,[(0,.20),(.025,.20),(.15,.06),(.18,.04)],'iron')
lathe('Lamp lens',-5.91,2.435,8,[(0,.08),(.03,.11)],'cream')

GROUP='stall'
# Canopy is a genuinely curved double-sided cloth mesh with irregular hem.
x0,x1,z0,z1=-6.35,-3.80,3.55,6.45
verts=[];nx,nz=20,26
for iz in range(nz+1):
    v=iz/nz
    for ix in range(nx+1):
        u=ix/nx
        y=3.28-.39*u-.19*math.sin(math.pi*u)*math.sin(math.pi*v)+.026*math.sin(v*math.pi*18)*u
        verts.append((x0+(x1-x0)*u,y,z0+(z1-z0)*v))
faces=[(j*(nx+1)+i,j*(nx+1)+i+1,(j+1)*(nx+1)+i+1,(j+1)*(nx+1)+i) for j in range(nz) for i in range(nx)]
cloth=mesh('Sagging woven awning',verts,faces,'canvas',1,0,True)
cloth.data.materials[0].use_backface_culling=False
solid=cloth.modifiers.new('Sewn cloth thickness','SOLIDIFY');solid.thickness=.006
for z in [z0,z1]:
    tube('Awning upright',[(-3.83,.05,z),(-3.83,2.92,z)],.031,'iron',12)
    tube('Canopy supporting spar',[(-6.36,3.29,z),(-3.78,2.89,z)],.028,'iron')
    for y in [.08,2.7]:lathe('Pole collar',-3.83,y,z,[(0,.047),(.07,.047)],'brass',12)
    cable('Canopy seam',(-6.35,3.29,z),(-3.8,2.9,z),.065,'cream',.012)
# Hem follows waves and casts a soft broken shadow.
for i in range(26):
    z=z0+(z1-z0)*(i+.5)/26
    h=.13+.035*math.sin(i*1.1)
    box('Cloth hem',-3.79,2.85-h/2,z,.014,h,(z1-z0)/26+.003,'canvas',0,.7)
cable('Canopy leading seam',(-3.78,2.90,z0),(-3.78,2.90,z1),.035,'cream',.018)
# Separate planks, folded trestles, braces, and fastening plates.
for i in range(8):box('Table plank',-4.52,.92,3.90+i*.314,1.65,.055,.302,'wood',.012,1.6)
for z in [4.05,5.96]:
    for xx in [-.61,.61]:
        tube('Folding trestle',[(-4.52+xx,.08,z-.14),(-4.52-xx,.88,z+.14)],.027,'iron')
    tube('Trestle cross brace',[(-5.1,.15,z),(-3.95,.15,z)],.027,'iron')
box('Table underside beam',-4.52,.84,5,1.40,.085,2.37,'wood',.01)
# Rug under the station, wholly within the table collider.
box('Woven ground mat',-4.58,.015,5,1.75,.02,2.85,'canvas',0,.65)

def crate(x,y,z,w=.7,h=.52,d=.62):
    for sx in [-1,1]:
        for sz in [-1,1]:box('Crate corner',x+sx*(w/2-.045),y+h/2,z+sz*(d/2-.04),.065,h,.065,'wood',.007)
    for i in range(4):
        yy=y+.065+i*(h-.10)/4
        for sx in [-1,1]:box('Crate side slat',x+sx*w/2,yy,z,.055,.09,d,'wood',.008)
        for sz in [-1,1]:box('Crate end slat',x,yy,z+sz*d/2,w,.09,.055,'wood',.008)
    box('Crate bottom',x,y+.025,z,w,.05,d,'wood',.009)
    for sx in [-1,1]:
        for sz in [-1,1]:
            for yy in [y+.08,y+h-.08]:box('Crate nail',x+sx*(w/2+.027),yy,z+sz*(d/2-.04),.007,.015,.015,'iron',.003)
crate(-4.7,.035,4.35,.74,.48,.67)
crate(-4.7,.52,4.35,.64,.36,.56)
crate(-4.7,.035,5.67,.82,.58,.69)
# Hard transport case at one end, no invented narrative documents.
box('Transport case',-4.37,1.09,5.93,.67,.30,.53,'olive',.042)
box('Case lid seal',-4.37,1.19,5.93,.68,.025,.54,'black',.011)
for z in [5.74,6.10]:
    box('Case latch',-4.01,1.13,z,.032,.11,.055,'brass',.007)
    for x in [-4.68,-4.05]:box('Case corner reinforcement',x,1.09,z,.06,.30,.07,'iron',.014)
tube('Case handle',[(-4.005,1.10,5.87),(-3.955,1.10,5.87),(-3.955,1.10,6.00),(-4.005,1.10,6.00)],.014,'black')
# Radio front faces +X (the player approaches from street).
box('Field radio body',-4.45,1.12,4.72,.48,.35,.68,'olive',.033)
box('Radio faceplate',-4.196,1.12,4.72,.031,.29,.60,'black',.015)
for i in range(11):box('Radio speaker grille',-4.173,1.13,4.48+i*.023,.014,.20,.010,'iron',.003)
box('Radio display glass',-4.175,1.17,4.85,.012,.09,.18,'glass',.003)
for z in [4.83,4.95]:
    tube('Radio knob',[(-4.18,1.05,z),(-4.135,1.05,z)],.028,'black',16)
    box('Knob witness mark',-4.128,1.068,z,.008,.007,.012,'cream',0)
tube('Radio antenna',[(-4.48,1.31,4.96),(-4.5,1.83,4.96)],.009,'black')
# Handset with coiled cable.
box('Radio handset',-4.06,1.00,4.98,.14,.08,.30,'black',.025)
coil=[]
for i in range(160):
    t=i/159;coil.append((-4.22+.12*math.cos(t*math.pi*28),.987+.016*math.sin(t*math.pi*28),4.98+t*.34))
tube('Handset coiled cord',coil,.006,'black',5)
# Folded neutral notepad: explicitly no textual route truth.
box('Closed field notebook',-4.37,.979,5.45,.31,.034,.22,'cream',.005)
box('Notebook cover',-4.37,1.001,5.45,.33,.011,.235,'olive',.005)
tube('Pencil',[(-4.12,.968,5.31),(-4.16,.968,5.49)],.004,'brass',6)
lathe('Steel flask',-4.8,.96,5.4,[(0,.056),(.24,.056),(.27,.045),(.29,.035)],'iron')
lathe('Flask cap',-4.8,1.25,5.4,[(0,.038),(.035,.038)],'brass')
# Folding chair tucked behind table, entirely in occupied area.
for z in [4.76,5.2]:
    for x0,x1 in [(-5.98,-5.50),(-5.50,-5.98)]:tube('Chair folding frame',[(x0,.03,z),(x1,.54,z)],.022,'iron')
box('Chair seat',-5.75,.50,4.98,.54,.035,.49,'canvas',.014)
box('Chair back',-6.00,.79,4.98,.036,.36,.5,'canvas',.014)

# Compact potted greenery; opaque polygon leaves avoid alpha sorting and overdraw.
GROUP='greenery'
def plant(x,z,size=1):
    lathe('Clay planter',x,0,z,[(0,.20*size),(.06*size,.22*size),(.48*size,.32*size),(.53*size,.34*size),(.55*size,.30*size),(.48*size,.28*size)],'pot')
    lathe('Planter soil',x,.48*size,z,[(0,0),(0,.28*size)],'soil')
    for k in range(6):
        angle=random.random()*math.tau
        tip=(x+math.cos(angle)*.38*size,random.uniform(1,1.8)*size,z+math.sin(angle)*.38*size)
        tube('Plant branch',[(x,.4*size,z),((x+tip[0])/2,.8*size,(z+tip[2])/2),tip],.013*size,'wood',6)
        for j in range(12):
            t=.3+j*.056;cx=x+(tip[0]-x)*t;cy=.4*size+(tip[1]-.4*size)*t;cz=z+(tip[2]-z)*t
            aa=angle+j*2.4;dx=.17*size*math.cos(aa);dz=.17*size*math.sin(aa)
            mesh('Olive leaf',[(cx,cy,cz),(cx+dx*.5-dz*.18,cy+.027*size,cz+dz*.5+dx*.18),(cx+dx,cy+.02*size,cz+dz),(cx+dx*.5+dz*.18,cy-.003,cz+dz*.5-dx*.18)],[(0,1,2,3)],'leaf' if j%3 else 'leaflight',1)
plant(-6.03,7.0,.82)
plant(-6.0,9.92,.7)
# Flowers in a box safely above head height.
box('Balcony planter box',-5.51,3.98,9.22,.34,.32,.58,'pot',.025)
for i in range(42):
    x=random.uniform(-5.78,-5.25);z=random.uniform(8.9,9.56);y=random.uniform(4.1,4.65)
    tube('Climbing stems',[(-5.65,4.05,9.20),(x,y,z)],.007,'wood',5)
    r=.06
    mesh('Flower bracts',[(x-r,y,z),(x,y+r,z-.025),(x+r,y,z),(x,y-r,z+.03)],[(0,1,2,3)],'flower')

# Ground and boundary curb, shared art surface; gameplay movement remains flat.
GROUP='ground'
box('Sand outside market',0,-.19,0,90,.3,90,'soil',0,1)
box('Stone street',0,-.049,0,13,.09,33,'paving',.006,3.1)
for x in [-6.15,6.15]:
    for i in range(49):
        z=-16+i*.67
        box('Dressed curb',x,.032,z,.35,.15,.64,'stone',.012)
# Ground detail under storefront only; no movable obstruction of the walking route.
for i in range(21):
    z=3.5+i*.33
    box('Shopfront paving inset',-6.05,.037,z,.60,.06,.31,'paving',.012,3.1)
# Local drain slats at the wall, safe inside collision buffer.
for i in range(13):box('Drain grille',-6.18,.09,8.2+i*.042,.36,.023,.02,'iron',.004)

# Reusable metadata used by runtime review; no hidden scene content.
OUT.mkdir(parents=True,exist_ok=True);PUBLIC.mkdir(parents=True,exist_ok=True)
# Recalculate closed surface normals. Cloth/leaf faces are double-sided.
import bmesh
for obj in objects:
    bm=bmesh.new();bm.from_mesh(obj.data);bmesh.ops.recalc_face_normals(bm,faces=bm.faces);bm.to_mesh(obj.data);bm.free()

# Lighting/cameras are preview-only. Export contains only selected artwork.
world=bpy.data.worlds.new('Warm afternoon sky');world.use_nodes=True
world.node_tree.nodes['Background'].inputs[0].default_value=(.50,.66,.85,1)
world.node_tree.nodes['Background'].inputs[1].default_value=.5
bpy.context.scene.world=world
light=bpy.data.lights.new('Afternoon key','SUN');light.energy=2.4;light.angle=.08
sun=bpy.data.objects.new('Afternoon key',light);bpy.context.collection.objects.link(sun)
sun.location=co((8,11,1))
sun.rotation_euler=(-sun.location).to_track_quat('-Z','Y').to_euler()
light.color=(1.0,.87,.71)
# Large soft sky fill, portable offline reference rather than baked game lighting.
light=bpy.data.lights.new('Courtyard sky bounce','AREA');light.energy=800;light.shape='DISK';light.size=10
ob=bpy.data.objects.new('Courtyard sky bounce',light);bpy.context.collection.objects.link(ob);ob.location=co((1,7,7))
ob.rotation_euler=(Vector(co((-5,1.5,6)))-ob.location).to_track_quat('-Z','Y').to_euler()
camdata=bpy.data.cameras.new('Eye-level sample');cam=bpy.data.objects.new('Eye-level sample',camdata);bpy.context.collection.objects.link(cam)
bpy.context.scene.camera=cam;camdata.lens=25
cam.location=co((.1,1.68,10.8));cam.rotation_euler=(Vector(co((-5.25,2.5,6.3)))-cam.location).to_track_quat('-Z','Y').to_euler()
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=32;scene.cycles.use_denoising=True
scene.render.resolution_x=1440;scene.render.resolution_y=1000;scene.render.resolution_percentage=100
scene.view_settings.view_transform='AgX'
# Relative references keep the authoring file portable without embedding duplicate maps.
for im in bpy.data.images:
    if im.source=='FILE':im.filepath='//textures/'+Path(im.filepath).name
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'MarketSample.blend'))
# Optimize only the exported copy: evaluate bevels, batch by sector + material.
batches=defaultdict(list)
for obj in objects:batches[(obj['sector'],obj.data.materials[0].name)].append(obj)
bpy.ops.object.select_all(action='DESELECT')
for obj in objects:obj.select_set(True)
bpy.context.view_layer.objects.active=objects[0]
bpy.ops.object.convert(target='MESH')
exported=[]
for (sector,material), items in batches.items():
    bpy.ops.object.select_all(action='DESELECT')
    for obj in items:obj.select_set(True)
    bpy.context.view_layer.objects.active=items[0]
    bpy.ops.object.join();obj=items[0];obj.name=sector+' / '+material
    tri=obj.modifiers.new('Export triangulation','TRIANGULATE')
    bpy.ops.object.modifier_apply(modifier=tri.name)
    exported.append(obj)
bpy.ops.object.select_all(action='DESELECT')
for obj in exported:obj.select_set(True)
bpy.context.view_layer.objects.active=exported[0]
bpy.ops.export_scene.gltf(filepath=str(PUBLIC/'market-sample-v1.glb'),export_format='GLB',use_selection=True,
                          export_yup=True,export_apply=True,export_extras=False,export_cameras=False,export_lights=False,
                          export_image_format='AUTO',export_texcoords=True,export_normals=True,export_tangents=True)
# A portable FBX uses the same selected mesh and UVs; Unity material conversion remains separate.
if '--fbx' in sys.argv:
    bpy.ops.export_scene.fbx(filepath=str(OUT/'MarketSample.fbx'),use_selection=True,object_types={'MESH'},
                            axis_forward='-Z',axis_up='Y',add_leaf_bones=False,path_mode='RELATIVE')
triangles=sum(len(p.vertices)-2 for o in exported for p in o.data.polygons)
metrics={'version':1,'units':'metres','coordinateSystem':'glTF Y-up; matches marketField coordinates',
         'heroBounds':{'min':[-6.9,0,3.5],'max':[-3.7,7.84,10.6]},
         'authoringObjectCount':len(objects),'exportMeshCount':len(exported),'triangles':triangles,
         'glbBytes':(PUBLIC/'market-sample-v1.glb').stat().st_size,
         'textures':'Poly Haven CC0; see texture-sources.json',
         'collision':'Existing market colliders plus storefront floor props; cosmetic geometry is not server authority',
         'characters':'Existing placeholder crew retained in web runtime; no rigged character asset in this export'}
(OUT/'build-manifest.json').write_text(json.dumps(metrics,indent=2)+'\n')
print('MARKET_ART '+json.dumps(metrics),flush=True)
if '--render' in sys.argv:
    # Exported meshes have identical geometry; preview depicts real 3D asset, not generated concept.
    for name,position,target,lens in [
        ('storefront-eye',(.1,1.68,10.8),(-5.25,2.5,6.3),25),
        ('radio-close',(-2.95,1.50,6.3),(-4.55,1.05,4.9),35),
        ('reverse-eye',(-1.0,1.68,1.5),(-5.9,2.75,6.7),26)]:
        cam.location=co(position);cam.rotation_euler=(Vector(co(target))-cam.location).to_track_quat('-Z','Y').to_euler();camdata.lens=lens
        scene.render.filepath=str(OUT/(name+'.png'));bpy.ops.render.render(write_still=True)
print(f'Completed in {time.time()-START:.1f}s',flush=True)
