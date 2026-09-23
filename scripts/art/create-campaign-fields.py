"""Neutral, case-independent West Gate / Bridge / Reception environment assets.
Blender 5.2.1. No incident truth or report text enters exported geometry.
"""
import bpy, bmesh, math, random, json, sys
from pathlib import Path
from collections import defaultdict
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'assets/authoring/campaign-fields-v1'
PUBLIC=ROOT/'client/public/assets/fields'
TEX=ROOT/'assets/authoring/market-sample-v1/textures'
OUT.mkdir(parents=True,exist_ok=True);PUBLIC.mkdir(parents=True,exist_ok=True)

def co(p):return (p[0],-p[2],p[1])
def col(h):
 v=[int(h[i:i+2],16)/255 for i in (0,2,4)]
 return tuple(x/12.92 if x<.04045 else ((x+.055)/1.055)**2.4 for x in v)+(1,)
def material(name,color,rough=.8,metal=0,tex=None):
 m=bpy.data.materials.new(name);m.use_nodes=True;p=m.node_tree.nodes.get('Principled BSDF')
 p.inputs['Base Color'].default_value=col(color);p.inputs['Roughness'].default_value=rough;p.inputs['Metallic'].default_value=metal
 if tex:
  for slot,socket in [('baseColor','Base Color'),('normal','Normal')]:
   image=bpy.data.images.load(str(TEX/f'{tex}_{slot}.jpg'),check_existing=True)
   if slot=='normal':image.colorspace_settings.name='Non-Color'
   n=m.node_tree.nodes.new('ShaderNodeTexImage');n.image=image
   if slot=='normal':
    normal=m.node_tree.nodes.new('ShaderNodeNormalMap');normal.inputs['Strength'].default_value=.55;m.node_tree.links.new(n.outputs['Color'],normal.inputs['Color']);m.node_tree.links.new(normal.outputs['Normal'],p.inputs[socket])
   else:m.node_tree.links.new(n.outputs['Color'],p.inputs[socket])
 return m

def mesh(name,verts,faces,key,bevel=0,smooth=False):
 me=bpy.data.meshes.new(name);me.from_pydata([co(v) for v in verts],[],faces);me.update()
 ob=bpy.data.objects.new(name,me);bpy.context.collection.objects.link(ob);ob.data.materials.append(M[key]);objects.append(ob)
 uv=me.uv_layers.new(name='UVMap')
 for face in me.polygons:
  axis=max(range(3),key=lambda a:abs(face.normal[a]))
  for li in face.loop_indices:
   v=me.vertices[me.loops[li].vertex_index].co;pair=(v.y,v.z) if axis==0 else ((v.x,v.z) if axis==1 else (v.x,v.y));uv.data[li].uv=(pair[0]/2,pair[1]/2)
  face.use_smooth=smooth
 if bevel:
  mod=ob.modifiers.new('Edge radius','BEVEL');mod.width=bevel;mod.segments=2
  ob.modifiers.new('Corner normals','WEIGHTED_NORMAL')
 return ob

def box(n,x,y,z,w,h,d,k,b=.025):
 v=[(x+sx*w/2,y+sy*h/2,z+sz*d/2) for sx,sy,sz in [(-1,-1,-1),(-1,-1,1),(-1,1,-1),(-1,1,1),(1,-1,-1),(1,-1,1),(1,1,-1),(1,1,1)]]
 return mesh(n,v,[(0,4,5,1),(2,3,7,6),(0,2,6,4),(1,5,7,3),(0,1,3,2),(4,6,7,5)],k,b)
def tube(n,a,b,r,k,sides=12):
 tangent=(Vector(b)-Vector(a)).normalized();ref=Vector((1,0,0)) if abs(tangent.y)>.8 else Vector((0,1,0));u=tangent.cross(ref).normalized();v=tangent.cross(u).normalized()
 verts=[tuple(Vector(p)+r*(math.cos(j*math.tau/sides)*u+math.sin(j*math.tau/sides)*v)) for p in [a,b] for j in range(sides)]
 faces=[tuple(reversed(range(sides))),tuple(sides+j for j in range(sides))]+[(j,(j+1)%sides,(j+1)%sides+sides,j+sides) for j in range(sides)]
 return mesh(n,verts,faces,k,0,True)
def roof(n,x,y,z,w,d,k):
 return mesh(n,[(x-w/2,y,z-d/2),(x+w/2,y,z-d/2),(x,y+.7,z-d/2),(x-w/2,y,z+d/2),(x+w/2,y,z+d/2),(x,y+.7,z+d/2)],[(0,1,2),(3,5,4),(0,3,4,1),(0,2,5,3),(1,4,5,2)],k)
def hut(x,z):
 box('Limewashed registration hut',x,1.65,z,2.2,3.3,3.5,'plaster')
 box('Roof coping',x,3.36,z,2.55,.15,3.85,'stone')
 inner=x+(1.12 if x<0 else -1.12)
 box('Inset booth window',inner,1.75,z,.07,.95,1.55,'glass',.008)
 for dz in [-.8,.8]:box('Window jamb',inner,1.75,z+dz,.2,1.13,.1,'teal')
 for y in [1.24,2.28]:box('Window rail',inner,y,z,.2,.1,1.73,'teal')
 for dz in [-.52,0,.52]:box('Steel window divider',inner,1.75,z+dz,.12,1.0,.035,'iron',.005)
 box('Counter sill',inner,1.20,z,.55,.1,1.82,'wood')
 for y in [.2,.5]:box('Stone plinth',x,y,z,2.28,.25,3.59,'stone')
def fence(x,z1,z2):
 for z in range(int(z1),int(z2)+1,2):
  box('Boundary foot',x,.14,z,.55,.3,.55,'stone')
  tube('Boundary upright',(x,.2,z),(x,1.12,z),.04,'iron')
 for y in [.56,1.1]:tube('Boundary rail',(x,y,z1),(x,y,z2),.028,'iron')
def station(x,z):
 for i in range(6):box('Workstation timber plank',x,.91,z-.99+i*.396,1.55,.07,.385,'wood',.01)
 for dx in [-.62,.62]:
  for dz in [-.94,.94]:tube('Desk leg',(x+dx,.02,z+dz),(x+dx,.88,z+dz),.026,'iron')
 box('Field radio',x,1.10,z-.45,.56,.3,.42,'olive',.04)
 box('Radio grille',x,1.12,z-.675,.4,.2,.02,'black',.008)
 for i in range(10):box('Speaker ribs',x-.19+i*.042,1.12,z-.69,.016,.18,.012,'iron',.002)
 tube('Antenna',(x+.22,1.25,z-.45),(x+.22,1.79,z-.45),.008,'iron')
 box('Paper folder',x+.05,.97,z+.45,.46,.035,.29,'cream',.004)
 for dx in [-.8,.8]:
  for dz in [-1.2,1.2]:tube('Shelter post',(x+dx,0,z+dz),(x+dx,2.8,z+dz),.033,'iron')
 for dz in [-1.2,1.2]:tube('Canopy crossbar',(x-.85,2.8,z+dz),(x+.85,2.8,z+dz),.025,'iron')
 roof('Weather canopy',x,2.8,z,2.0,2.7,'canvas')
def van(x,z):
 box('Convoy minibus',x,1.16,z,2.4,1.65,4.9,'cream',.16)
 box('Cabin roof',x,2.14,z+.1,2.31,.69,4.1,'cream',.15)
 box('Windshield',x,2.08,z-2.1,1.9,.68,.04,'glass',.07)
 for xx in [x-1.2,x+1.2]:
  for zz in [z-1.3,z+.15,z+1.45]:box('Passenger window',xx,2.04,zz,.035,.62,1.02,'glass',.045)
  box('Vehicle side stripe',xx,1.34,z,.04,.16,4.2,'teal',.015)
  for zz in [z-1.5,z+1.5]:tube('Wheel',(xx-.16,.51,zz),(xx+.16,.51,zz),.46,'black',24)
 for xx in [x-.78,x+.78]:box('Headlamp',xx,1.12,z-2.46,.40,.24,.04,'cream',.045)
 box('Bumper',x,.64,z-2.51,2.5,.25,.13,'iron',.04)
def rock(x,z,r):
 random.seed(int(x*19+z*13));n=7
 verts=[(x+math.cos(i*math.tau/n)*r*(.7+random.random()*.3),-3,z+math.sin(i*math.tau/n)*r) for i in range(n)]
 verts.append((x-.2*r,random.uniform(0,2)*r-2,z))
 mesh('Eroded river stone',verts,[tuple(reversed(range(n)))]+[(i,(i+1)%n,n) for i in range(n)],'stone')

def make(level):
 global M,objects
 bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
 for m in list(bpy.data.materials):bpy.data.materials.remove(m)
 objects=[]
 M={
  'plaster':material('Lime plaster','d6c7ad',tex='beige_wall_001'),
  'wood':material('Timber','92755d',tex='wood_table_001'),
  'stone':material('Warm limestone','bcb09a'), 'teal':material('Weathered teal','476561'),
  'iron':material('Iron','424b49',.5,.55), 'glass':material('Window glass','304747',.23,.2),
  'black':material('Rubber','262d2c'), 'cream':material('Light field paint','c7c5b1'),
  'canvas':material('Shelter canvas','b5ab90'), 'olive':material('Field radio paint','5d695f'),
  'sand':material('Riverbank soil','a3947b'), 'road':material('Packed gravel','837d70'),
  'water':material('River water','476e75',.22,.25), 'line':material('Road markings','d5cfb7'),
 }
 box('Surrounding ground',0,-2 if level=='bridge' else -.4,25 if level=='bridge' else 5,95,3.8 if level=='bridge' else .7,74 if level=='bridge' else 65,'sand',0)
 if level!='reception':
  box('Staging surface',0,-.025,1,16,.05,24,'road',0)
  for x in [-7.9,7.9]:fence(x,-10,13)
  for z in range(-9,13,2):box('Centre road dash',0,.012,z,.09,.01,.7,'line',0)
  for x,z in [(-4.65,2),(4.65,-3),(-4.8,-7)]:station(x,z)
  van(6.1,9)
  # Identical stopping point in both cases. This marks the staging boundary,
  # never a case-specific bridge/gate permission or visible evidence claim.
  for x in [-5,-1.8,1.8,5]:box('Convoy staging marker',x,.36,-10,.75,.72,.35,'stone',.08)
  tube('Staging rail',(-7.8,.98,-10),(7.8,.98,-10),.027,'iron')
 if level=='gate':
  hut(-6.9,-3);hut(6.9,-6)
  for x in [-9.8,9.8]:
   box('West gate pier',x,3.5,-13,2.3,7,2.5,'plaster',.08)
   for y in [.3,3.7,6.85]:box('Gate pier coping',x,y,-13,2.55,.27,2.74,'stone')
  box('West gate lintel',0,6.15,-13,20,.8,2.5,'plaster',.07)
  for side in [-1,1]:
   box('Old city wall',side*19,2.8,-13,15,5.6,1.5,'plaster',.06)
   for i in range(10):box('Wall coping block',side*(12+i*1.5),5.78,-13,1.42,.25,1.75,'stone')
  for x in [-5,5]:
   for i in range(4):box('Stacked supply case',x,.23+i*.42,12,.9,.4,.65,'olive',.03)
  for x,z,h in [(-15,-25,6),(12,-25,7),(3,-30,5),(-5,-28,8)]:
   box('Distant roofline',x,h/2,z,6,h,6,'plaster',.08)
 elif level=='bridge':
  # River and bridge lie beyond the walkable approach. The bridge is intact
  # in both authored cases; visible structure reveals no vehicle permission.
  box('River basin',0,-3.75,-32,100,.2,35,'water',0)
  box('Far bank',0,-2.0,-55,100,4,22,'sand',.12)
  box('Bridge deck',0,-.20,-31,6.9,.4,40,'stone',.035)
  box('Bridge wearing course',0,.018,-31,6.1,.045,40,'road',0)
  for x in [-3.32,3.32]:
   box('Bridge parapet base',x,.29,-31,.4,.5,40,'stone')
   for z in range(-50,-10,2):
    box('Parapet upright',x,.72,z,.25,.8,.25,'stone')
   for y in [.83,1.09]:tube('Bridge handrail',(x,y,-51),(x,y,-11),.035,'iron')
  for z in [-16,-25,-34,-43]:
   for x in [-2.5,2.5]:box('Bridge pier',x,-1.6,z,1.0,3.0,2.1,'stone',.06)
   # Curved arch underside, thick stone extruded across road width.
   steps=20;v=[]
   for x in [-3.2,3.2]:
    for i in range(steps+1):
     t=i/steps;v.extend([(x,-.39,z+t*7.0),(x,-2.0+1.40*math.sin(math.pi*t),z+t*7.0)])
   offset=2*(steps+1);f=[]
   for i in range(steps):
    a=i*2;b=(i+1)*2
    f.extend([(a,b,b+1,a+1),(a+offset,a+1+offset,b+1+offset,b+offset),(a+1,b+1,b+1+offset,a+1+offset)])
   mesh('Stone bridge arch',v,f,'stone')
  hut(-6.9,-5);hut(6.9,-5)
  for x,z,r in [(-12,-21,2),(-8,-34,1.8),(11,-22,2.3),(16,-39,3),(-18,-45,2.5)]:rock(x,z,r)
  for x in [-12,12]:
   tube('Approach light pole',(x,0,-9),(x,6.0,-9),.06,'iron')
   box('Light head',x,6.0,-9,.55,.15,.3,'cream')
 elif level=='reception':
  box('Reception forecourt',0,-.035,0,28,.06,27,'road',0)
  for x,z in [(-7,-3),(7,-6),(0,-12)]:
   roof('Reception tent roof',x,3.3,z,5.8,6.1,'canvas')
   for side in [-1,1]:box('Tent side panel',x+side*2.8,1.7,z,.055,3.3,6,'canvas',0)
   box('Tent rear panel',x,1.7,z-3,5.6,3.3,.055,'canvas',0)
   for xx in [x-2.82,x+2.82]:
    for zz in [z-3,z+3]:tube('Tent frame',(xx,0,zz),(xx,3.35,zz),.028,'iron')
   box('Reception table',x,.90,z+1,3,.12,.8,'wood')
   for xx in [x-1.2,x+1.2]:tube('Desk support',(xx,0,z+1),(xx,.85,z+1),.04,'iron')
  van(6.1,8)
  for x in [-10,10]:
   tube('Reception lamp',(x,0,2),(x,5.8,2),.06,'iron')
   box('Floodlight housing',x,5.75,2,.9,.4,.25,'iron')
   box('Floodlight lens',x,5.75,2.14,.77,.3,.015,'cream',0)
  for x in range(-9,10,2):
   box('Bench seat',x,.45,3,1.5,.1,.42,'wood')
   for xx in [x-.6,x+.6]:box('Bench leg',xx,.2,3,.08,.4,.35,'iron')
  for x in [-18,18]:box('Sheltering compound wall',x,1.9,-3,1,3.8,35,'plaster')
 # Export neutral camera-independent geometry; source scene retains all pieces.
 for ob in objects:
  bm=bmesh.new();bm.from_mesh(ob.data);bmesh.ops.recalc_face_normals(bm,faces=bm.faces);bm.to_mesh(ob.data);bm.free()
 scene=bpy.context.scene
 world=bpy.data.worlds.new(level+' sky');world.use_nodes=True;world.node_tree.nodes['Background'].inputs[0].default_value=(.42,.58,.76,1);world.node_tree.nodes['Background'].inputs[1].default_value=.5;scene.world=world
 light=bpy.data.lights.new('Sun','SUN');light.energy=2.5;light.angle=.10;light.color=(1,.84,.65)
 sun=bpy.data.objects.new('Sun',light);bpy.context.collection.objects.link(sun);sun.location=co((9,18,5));sun.rotation_euler=(-sun.location).to_track_quat('-Z','Y').to_euler()
 camera=bpy.data.cameras.new('Player eye');cam=bpy.data.objects.new('Player eye',camera);bpy.context.collection.objects.link(cam);cam.location=co((0,1.68,10));cam.rotation_euler=(Vector(co((0,1.7,-12)))-cam.location).to_track_quat('-Z','Y').to_euler();camera.lens=24;scene.camera=cam
 scene.render.engine='CYCLES';scene.cycles.samples=24;scene.cycles.use_denoising=True;scene.render.resolution_x=1280;scene.render.resolution_y=800;scene.render.resolution_percentage=100
 # Save with relative image references to the existing licensed source directory.
 for image in bpy.data.images:
  if image.source=='FILE':image.filepath=str(TEX/Path(image.filepath).name)
 bpy.ops.wm.save_as_mainfile(filepath=str(OUT/(level+'.blend')),relative_remap=False)
 for image in bpy.data.images:
  if image.source=='FILE':image.filepath=bpy.path.relpath(image.filepath)
 bpy.ops.wm.save_as_mainfile(filepath=str(OUT/(level+'.blend')))
 batches=defaultdict(list)
 for ob in objects:batches[ob.data.materials[0].name].append(ob)
 bpy.ops.object.select_all(action='DESELECT')
 for ob in objects:ob.select_set(True)
 bpy.context.view_layer.objects.active=objects[0];bpy.ops.object.convert(target='MESH')
 exports=[]
 for name,items in batches.items():
  bpy.ops.object.select_all(action='DESELECT')
  for ob in items:ob.select_set(True)
  bpy.context.view_layer.objects.active=items[0];bpy.ops.object.join();ob=items[0];ob.name=level+' / '+name
  mod=ob.modifiers.new('Triangulate','TRIANGULATE');bpy.ops.object.modifier_apply(modifier=mod.name);exports.append(ob)
 bpy.ops.object.select_all(action='DESELECT')
 for ob in exports:ob.select_set(True)
 bpy.ops.export_scene.gltf(filepath=str(PUBLIC/(level+'-v1.glb')),export_format='GLB',use_selection=True,export_yup=True,export_normals=True,export_tangents=True,export_extras=False,export_lights=False,export_cameras=False)
 stats={'level':level,'authoringObjects':len(objects),'meshes':len(exports),'triangles':sum(len(o.data.polygons) for o in exports),'bytes':(PUBLIC/(level+'-v1.glb')).stat().st_size}
 if '--render' in sys.argv:
  scene.render.filepath=str(OUT/(level+'-eye.png'));bpy.ops.render.render(write_still=True)
 return stats
manifest=[make(level) for level in ['gate','bridge','reception']]
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('CAMPAIGN_FIELDS '+json.dumps(manifest),flush=True)
