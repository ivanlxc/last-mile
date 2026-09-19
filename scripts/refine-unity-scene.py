"""Create a repeatable, engine-friendly refinement of the existing Blender map.

Run with Blender, not system Python:
  blender --background --python scripts/refine-unity-scene.py -- [--skip-render]

The original authoring file and web GLB are never overwritten. This script only
reads public geography. No events, evidence, or server-only authoring data enter
the exported scene. Art units and all road/hotspot coordinates remain unchanged.
"""

import argparse
import hashlib
import json
import math
import pathlib
import random
import sys
from collections import defaultdict

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "assets/authoring/last-mile-unity"
EXPORTS = OUT / "exports"
TEXTURES = EXPORTS / "textures"
SOURCE = ROOT / "assets/authoring/last-mile-v2/LAST_MILE_Master.blend"
PUBLIC_MAP = ROOT / "client/src/lib/map-data.json"
ARGS = argparse.ArgumentParser()
ARGS.add_argument("--skip-render", action="store_true")
ARGS.add_argument("--glb", action="store_true")
args = ARGS.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
for directory in (OUT, EXPORTS, TEXTURES):
    directory.mkdir(parents=True, exist_ok=True)
random.seed(1881)
bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
scene = bpy.context.scene
scene.unit_settings.system = "NONE"
scene.unit_settings.scale_length = 1.0
public_map = json.loads(PUBLIC_MAP.read_text())


def log(message):
    print("[LAST MILE ART]", message, flush=True)


def collection(name):
    c = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if c.name not in scene.collection.children:
        scene.collection.children.link(c)
    c.hide_render = False
    c.hide_viewport = False
    return c


detail_collection = collection("12_UNITY_REFINEMENT")


def move_to(obj, target=detail_collection):
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    target.objects.link(obj)


def assign(obj, material):
    obj.data.materials.clear()
    obj.data.materials.append(material)


def box(name, location, dimensions, material, parent=None, bevel=0.015):
    # Data API avoids rebuilding the entire 1,500-object dependency graph for
    # each small piece of architecture.
    x, y, z = [v / 2 for v in dimensions]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([(-x,-y,-z),(-x,-y,z),(-x,y,-z),(-x,y,z),
                     (x,-y,-z),(x,-y,z),(x,y,-z),(x,y,z)], [],
                    [(0,4,6,2),(1,3,7,5),(0,1,5,4),(2,6,7,3),(0,2,3,1),(4,5,7,6)])
    mesh.update()
    o = bpy.data.objects.new(name, mesh)
    detail_collection.objects.link(o)
    o.location = location
    if bevel:
        mod = o.modifiers.new("Edge softness", "BEVEL")
        mod.width = bevel
        mod.segments = 2
    assign(o, material)
    if parent:
        o.parent = parent
        o.location = location
    return o


def cylinder(name, location, radius, depth, material, parent=None, rotation=None, vertices=16):
    points = [(math.cos(i * math.tau / vertices) * radius,
               math.sin(i * math.tau / vertices) * radius, z)
              for z in (-depth / 2, depth / 2) for i in range(vertices)]
    faces = [tuple(reversed(range(vertices))), tuple(range(vertices, vertices * 2))]
    faces += [(i, (i+1) % vertices, (i+1) % vertices + vertices, i + vertices)
              for i in range(vertices)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(points, [], faces)
    mesh.update()
    o = bpy.data.objects.new(name, mesh)
    detail_collection.objects.link(o)
    o.location = location
    if rotation:
        o.rotation_euler = rotation
    assign(o, material)
    if parent:
        o.parent = parent
        o.location = location
    return o


def make_image(name, rgba, non_color=False):
    h, w = rgba.shape[:2]
    image = bpy.data.images.new(name, width=w, height=h, alpha=False)
    if non_color:
        image.colorspace_settings.name = "Non-Color"
    # Changing colorspace resets a generated image's buffer in Blender 5.2.
    # Choose it before writing pixels or exported normal maps become black.
    image.pixels.foreach_set(np.asarray(rgba, dtype=np.float32).ravel())
    image.filepath_raw = str(TEXTURES / (name + ".png"))
    image.file_format = "PNG"
    image.save()
    image.pack()
    return image


def textured_material(name, base, roughness=0.9, metal=0.0, kind="stone"):
    """Tileable original textures; ordinary image nodes survive FBX export."""
    size = 512
    yy, xx = np.meshgrid(np.arange(size) / size, np.arange(size) / size, indexing="ij")
    rng = np.random.default_rng(sum(map(ord, name)))
    field = np.zeros((size, size))
    for frequency, amp in [(2, .06), (5, .06), (13, .07), (31, .07), (83, .05)]:
        for _ in range(3):
            a, b = rng.integers(-frequency, frequency + 1, 2)
            phase = rng.random() * math.tau
            field += amp * np.sin(math.tau * (xx * a + yy * b) + phase)
    field += rng.normal(0, .03, (size, size))
    field = np.clip(field, -1, 1)
    if kind == "sand":
        field += rng.normal(0, .065, (size, size))
    elif kind == "wood":
        field += .23 * np.sin(math.tau * (xx * 63 + .35 * np.sin(yy * math.tau * 3)))
    elif kind == "canvas":
        field += .08 * (np.sin(xx * math.tau * 128) + np.sin(yy * math.tau * 128))
    elif kind == "asphalt":
        field += rng.normal(0, .13, (size, size))
    strength = .12 if kind in ("sand", "stone") else .14
    rgba = np.ones((size, size, 4))
    rgba[:, :, :3] = np.clip(np.array(base)[None, None, :] * (1 + field[:, :, None] * strength), 0, 1)
    color = make_image(name + "_Albedo", rgba)
    dx = np.roll(field, -1, axis=1) - np.roll(field, 1, axis=1)
    dy = np.roll(field, -1, axis=0) - np.roll(field, 1, axis=0)
    n = np.stack((-dx * .8, -dy * .8, np.ones_like(field)), axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    rgba[:, :, :3] = n * .5 + .5
    normal = make_image(name + "_Normal", rgba, non_color=True)
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = (*base, 1)
    mat.roughness = roughness
    mat.metallic = metal
    nodes = mat.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metal
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = color
    normal_tex = nodes.new("ShaderNodeTexImage")
    normal_tex.image = normal
    normal_node = nodes.new("ShaderNodeNormalMap")
    normal_node.inputs["Strength"].default_value = .22
    mat.node_tree.links.new(tex.outputs["Color"], shader.inputs["Base Color"])
    mat.node_tree.links.new(normal_tex.outputs["Color"], normal_node.inputs["Color"])
    mat.node_tree.links.new(normal_node.outputs["Normal"], shader.inputs["Normal"])
    mat.node_tree.links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    return mat


def plain_material(name, color, roughness=.65, metal=0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = (*color, 1)
    mat.roughness = roughness
    mat.metallic = metal
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metal
    return mat


log("Creating original PBR image textures")
mats = {
    "sand": textured_material("LM_Sand", (.73, .61, .43), kind="sand"),
    "plaster": textured_material("LM_Plaster", (.76, .69, .55)),
    "warm": textured_material("LM_WarmPlaster", (.67, .53, .40)),
    "asphalt": textured_material("LM_Asphalt", (.19, .20, .19), kind="asphalt"),
    "concrete": textured_material("LM_Concrete", (.55, .53, .45)),
    "clay": textured_material("LM_Clay", (.51, .37, .24), kind="sand"),
    "canvas": textured_material("LM_Canvas", (.70, .60, .42), kind="canvas"),
    "wood": textured_material("LM_Timber", (.36, .22, .11), kind="wood"),
    "ivory": plain_material("LM_AidIvory", (.79, .80, .73), .35, .18),
    "teal": plain_material("LM_TealPaint", (.07, .28, .29), .45, .12),
    "glass": plain_material("LM_Glass", (.045, .09, .115), .18, .50),
    "rubber": plain_material("LM_Rubber", (.027, .029, .028), .95),
    "metal": plain_material("LM_GalvanizedMetal", (.40, .43, .43), .32, .75),
    "dark": plain_material("LM_DarkMetal", (.06, .073, .073), .5, .6),
    "lamp": plain_material("LM_Headlamp", (.86, .83, .65), .17, .25),
    "red": plain_material("LM_Taillamp", (.48, .055, .027), .28, .15),
    "olive": plain_material("LM_Foliage", (.20, .27, .105), .9),
    "water": plain_material("LM_Water", (.10, .30, .30), .23, .15),
    "paint": plain_material("LM_RoadPaint", (.77, .73, .60), .8),
}
material_contract = {"schemaVersion": 1, "materials": []}
for mat in mats.values():
    albedo = TEXTURES / (mat.name + "_Albedo.png")
    normal = TEXTURES / (mat.name + "_Normal.png")
    material_contract["materials"].append({
        "name": mat.name,
        "color": list(mat.diffuse_color),
        "roughness": mat.roughness,
        "metallic": mat.metallic,
        "albedoTexture": "textures/" + albedo.name if albedo.exists() else "",
        "normalTexture": "textures/" + normal.name if normal.exists() else "",
        "normalScale": .22,
    })
(EXPORTS / "materials.json").write_text(json.dumps(material_contract, indent=2) + "\n")

mapping = {
    "Sand · fine warm limestone": "sand", "Cliff sandstone": "clay",
    "Architecture · pale sandstone": "plaster", "Architecture · warm plaster": "warm",
    "Roof recess": "concrete", "Dusty asphalt": "asphalt", "Clay road": "clay",
    "Warm canvas": "canvas", "Palm trunk": "wood", "Fired clay": "clay",
    "Aid vehicle ivory": "ivory", "Muted turquoise paint": "teal",
    "Smoky blue glass": "glass", "Dark teal openings": "glass",
    "Charcoal anodized frame": "dark", "Road paint": "paint",
    "Oasis water": "water", "Wadi shallow water": "water",
    "Palm fronds": "olive", "Garden sage": "olive",
    "Indigo market canvas": "teal", "Ivory typography": "paint",
    "Brass trim": "metal", "Contour engraving": "clay",
}
original_objects = list(bpy.data.objects)
for o in original_objects:
    if o.type in ("MESH", "CURVE", "FONT"):
        for slot in o.material_slots:
            if slot.material and slot.material.name in mapping:
                slot.material = mats[mapping[slot.material.name]]

# Retain the art as an editable master. Presentation grid/labels and event layers
# do not belong to an in-game scene and are excluded from the export below.
excluded_collections = ("00_", "08_", "10_", "11_")
for c in bpy.data.collections:
    if c.name.startswith(excluded_collections):
        c.hide_render = True
        c.hide_viewport = True
for o in bpy.data.objects:
    if o.name == "Contours of the dry ridges":
        o.hide_render = True
        o.hide_viewport = True

# The original still-image composition parked the convoy ahead of N00. In the
# playable scene its trailing vehicles queue behind N00 on the R00 tangent,
# crossing these two tent footprints. Clear only their cloth and ridge poles;
# keep the yard, walls, cabin, containers and all route coordinates untouched.
cleared_n00_props = ["N00_relief_tent", "N00_relief_tent.001",
                     "N00_relief_tent_ridge", "N00_relief_tent_ridge.001"]
for name in cleared_n00_props:
    prop = bpy.data.objects.get(name)
    if prop:
        prop.hide_render = True
        prop.hide_viewport = True

# The authored closed boom passes directly through the public N01 stop marker.
# Park it visibly raised, using its existing hinge and exact five children.
# This is a static art pose: it does not communicate permission or reveal an
# event state, and leaves checkpoint gameplay entirely server controlled.
gate_hinge = bpy.data.objects.get("E1_GATE_HINGE")
gate_arm = bpy.data.objects.get("E1_GATE_ARM")
raised_gate_children = []
if gate_hinge and gate_arm:
    direction = gate_arm.location.copy()
    direction.z = 0
    direction.normalize()
    lift_axis = Vector((direction.y, -direction.x, 0))
    gate_hinge.rotation_mode = "QUATERNION"
    gate_hinge.rotation_quaternion = Quaternion(lift_axis, math.radians(80))
    raised_gate_children = sorted(o.name for o in gate_hinge.children)
    bpy.context.view_layer.update()


def descendants(root):
    return [root] + list(root.children_recursive)


log("Refining convoy geometry and constructing wheel pivots")
convoy_roots = sorted([o for o in original_objects if o.parent is None and
                       o.name.startswith("CONVOY_")], key=lambda x: x.name)
convoy_report = []
for index, vehicle in enumerate(convoy_roots, 1):
    old_name = vehicle.name
    vehicle.name = f"LM_CONVOY_{index:02}"
    vehicle["original_asset"] = old_name
    vehicle["forward_axis_blender"] = "+X"
    # Place root at authored parked position, zero orientation for a stable prefab
    # contract. Runtime takes over the root position and heading immediately.
    vehicle.rotation_euler = (0, 0, 0)
    wheels = [o for o in vehicle.children_recursive if "_wheel" in o.name]
    body = next(o for o in vehicle.children_recursive if o.name.endswith("_body"))
    half_length = body.dimensions.x / 2
    half_width = body.dimensions.y / 2
    for wi, wheel in enumerate(wheels):
        bpy.context.view_layer.update()
        world = wheel.matrix_world.copy()
        local_position = vehicle.matrix_world.inverted() @ world.translation
        pivot = bpy.data.objects.new(f"LM_WHEEL_{index:02}_{wi:02}", None)
        detail_collection.objects.link(pivot)
        pivot.parent = vehicle
        pivot.location = local_position
        pivot.rotation_euler = (0, 0, math.pi / 2)
        bpy.context.view_layer.update()
        wheel.parent = pivot
        wheel.matrix_world = world
        wheel.name = f"Tire_{index:02}_{wi:02}"
        assign(wheel, mats["rubber"])
        sign = 1 if local_position.y > 0 else -1
        cylinder(f"Wheel_rim_{index}_{wi}", (sign * .057, 0, 0), .076, .014,
                 mats["metal"], pivot, rotation=(0, math.pi / 2, 0), vertices=16)
        cylinder(f"Wheel_hub_{index}_{wi}", (sign * .068, 0, 0), .025, .018,
                 mats["dark"], pivot, rotation=(0, math.pi / 2, 0), vertices=12)
        for spoke in range(4):
            s = box(f"Rim_spoke_{index}_{wi}_{spoke}", (sign * .067, 0, 0),
                    (.012, .013, .127), mats["dark"], pivot, bevel=0)
            s.rotation_euler.x = spoke * math.pi / 4
    box(f"Front_bumper_{index}", (half_length + .025, 0, .14),
        (.075, half_width * 2.12, .065), mats["dark"], vehicle)
    box(f"Rear_bumper_{index}", (-half_length - .035, 0, .14),
        (.08, half_width * 2.12, .065), mats["dark"], vehicle)
    for side in (-1, 1):
        box(f"Side_mirror_arm_{index}_{side}", (half_length * .61, side * (half_width + .04), .39),
            (.022, .105, .022), mats["dark"], vehicle, bevel=.005)
        box(f"Side_mirror_{index}_{side}", (half_length * .61, side * (half_width + .085), .42),
            (.06, .023, .083), mats["glass"], vehicle, bevel=.009)
        box(f"Rear_lamp_{index}_{side}", (-half_length - .012, side * half_width * .68, .26),
            (.027, .056, .057), mats["red"], vehicle, bevel=.007)
        box(f"Side_step_{index}_{side}", (half_length * .55, side * (half_width + .017), .115),
            (.23, .08, .037), mats["metal"], vehicle, bevel=.008)
        box(f"Door_seam_{index}_{side}", (half_length * .43, side * (half_width + .009), .27),
            (.011, .014, .27), mats["dark"], vehicle, bevel=0)
        box(f"Door_handle_{index}_{side}", (half_length * .28, side * (half_width + .02), .345),
            (.07, .015, .017), mats["metal"], vehicle, bevel=.004)
    for slat in range(4):
        box(f"Radiator_grille_{index}_{slat}", (half_length + .013, 0, .22 + slat * .023),
            (.026, .22, .009), mats["dark"], vehicle, bevel=0)
    cylinder(f"Roof_antenna_{index}", (-half_length * .35, 0, .725), .007, .26,
             mats["dark"], vehicle, vertices=8)
    if index == 2:
        # Passenger bus: roof ventilation and luggage rack visibly distinguish it.
        for x in (-.25, .20):
            box(f"Bus_roof_vent_{x}", (x, 0, .61), (.24, .24, .048), mats["metal"], vehicle)
    if index == 3:
        box("Medical_roof_marker", (0, 0, .586), (.31, .18, .018), mats["teal"], vehicle)
    convoy_report.append({"name": vehicle.name, "source": old_name,
                          "forwardBlender": "+X", "wheelAxisLocal": "+X",
                          "wheelRadius": .13, "routeYOffset": 0,
                          "wheelCount": len(wheels)})

# Architectural details are attached to the original building roots: no roads,
# landmark origins, or gameplay hotspot positions are changed.
log("Adding architectural detail, rooftop services, stonework and road furniture")
building_roots = [o for o in original_objects if o.type == "EMPTY" and
                  (o.name.startswith("BLD_") or o.name.startswith("N02_arcade_shop"))]
for bi, building in enumerate(building_roots):
    walls = next((o for o in building.children if "_walls" in o.name), None)
    if walls is None:
        continue
    sx, sy, sz = walls.dimensions
    # Existing local roofs/window transforms already follow the building root.
    local_center = walls.location.copy()
    x, y, z = local_center
    roof_z = z + sz * .5 + .035
    cylinder(f"Roof_vent_{bi}", (x - sx * .25, y + sy * .21, roof_z + .11),
             .036, .22, mats["metal"], building, vertices=12)
    cylinder(f"Roof_vent_cap_{bi}", (x - sx * .25, y + sy * .21, roof_z + .23),
             .065, .035, mats["metal"], building, vertices=12)
    for strip in range(3):
        box(f"AC_grille_{bi}_{strip}", (x + sx * .26, y - sy * .5 - .02, z + sz * .13 + strip * .045),
            (.26, .035, .018), mats["dark"], building, bevel=.004)
    cylinder(f"Drain_pipe_{bi}", (x + sx * .42, y - sy * .5 - .035, z),
             .022, sz * .92, mats["clay"], building, vertices=8)
    # Fine masonry courses, restrained so the map remains legible at wide zoom.
    if bi % 3 == 0:
        for course in range(3):
            box(f"Stone_course_{bi}_{course}", (x, y - sy * .5 - .006, z - sz * .4 + course * .19),
                (sx * .93, .012, .013), mats["concrete"], building, bevel=0)

# Public route verge furniture: sampled waypoints, no new drivable paths.
for route in public_map["routes"]:
    if route["routeId"] not in ("R00", "R01", "R04", "R07", "R10"):
        continue
    points = route["waypoints"]
    for wi, p in enumerate(points[1:-1]):
        q = points[min(wi + 2, len(points) - 1)]
        direction = Vector((q[0] - p[0], -q[2] + p[2], 0))
        if direction.length < .001:
            continue
        side = Vector((-direction.y, direction.x, 0)).normalized()
        for sign in (-1, 1):
            at = Vector((p[0], -p[2], p[1] - .126)) + side * sign * .67
            cylinder(f"Verge_post_{route['routeId']}_{wi}_{sign}", at + Vector((0, 0, .13)),
                     .026, .26, mats["concrete"], vertices=8)
            box(f"Verge_reflector_{route['routeId']}_{wi}_{sign}", at + Vector((0, 0, .235)),
                (.055, .055, .04), mats["paint"], bevel=.003)

# The original authoring model is a largely dry seasonal wadi. Add a restrained
# shallow channel, following that existing mesh, so the river valley reads from
# an oblique game camera. The southern ford stays dry and publicly unchanged.
wadi = bpy.data.objects.get("WADI_bed")
if wadi and wadi.type == "MESH":
    verts = [wadi.matrix_world @ v.co for v in wadi.data.vertices]
    rows = defaultdict(list)
    for p in verts:
        rows[round(p.y, 4)].append(p)
    water_points = []
    for y, points in sorted(rows.items()):
        left, right = min(p.x for p in points), max(p.x for p in points)
        center = (left + right) / 2
        # A gravel crossing around Blender Y=-7 leaves the detour visibly dry.
        width = (right - left) * .28 * min(1, max(0, (abs(y + 7) - .65) / .8))
        z = max(p.z for p in points) + .028
        water_points.extend([(center - width, y, z), (center + width, y, z)])
    water_faces = [(i, i+1, i+3, i+2) for i in range(0, len(water_points) - 2, 2)]
    mesh = bpy.data.meshes.new("Shallow wadi channel")
    mesh.from_pydata(water_points, [], water_faces)
    mesh.update()
    water = bpy.data.objects.new("LM_ShallowRiver", mesh)
    detail_collection.objects.link(water)
    assign(water, mats["water"])

for node in public_map["nodes"]:
    if node["nodeId"] in ("N00", "N01", "N07"):
        p = node["position"]
        anchor = bpy.data.objects.new("LM_ANCHOR_" + node["nodeId"], None)
        detail_collection.objects.link(anchor)
        anchor.location = (p[0], -p[2], p[1])


def exportable(o):
    if o.hide_render or o.name == "Contours of the dry ridges":
        return False
    if any(c.name.startswith(excluded_collections) for c in o.users_collection):
        return False
    return o.type in ("MESH", "CURVE", "EMPTY")


runtime = [o for o in bpy.data.objects if exportable(o)]
for o in runtime:
    o.hide_set(False)
    o.hide_viewport = False
    # Explicit mapping avoids Blender Generated coordinates, unsupported by FBX.
    if o.type == "MESH":
        uv = o.data.uv_layers.get("UVMap") or o.data.uv_layers.new(name="UVMap")
        matrix = o.matrix_world
        for poly in o.data.polygons:
            normal = poly.normal
            axis = max(range(3), key=lambda i: abs(normal[i]))
            plane = ((1, 2), (0, 2), (0, 1))[axis]
            for li in poly.loop_indices:
                p = matrix @ o.data.vertices[o.data.loops[li].vertex_index].co
                uv.data[li].uv = (p[plane[0]] * .65, p[plane[1]] * .65)

scene["unity_refinement"] = "Original model retained; exported image PBR materials; independent convoy/wheel roots."
scene["geography_contract"] = "Blender(x,y,z) -> Unity(x,z,y). Art units only. Public map coordinates unchanged."
scene["source_sha256"] = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
blend_path = OUT / "LAST_MILE_Unity_Refined.blend"
for image in bpy.data.images:
    if image.name.startswith("LM_") and image.filepath:
        image.filepath = "//exports/textures/" + pathlib.Path(image.filepath).name
bpy.ops.wm.save_as_mainfile(filepath=str(blend_path), relative_remap=False)

# A separate export scene is compacted; the saved authoring master remains fully
# editable with individual buildings and details. Geometry modifiers are applied
# once, then static pieces are merged by material (rather than 1,400 draw calls).
log("Preparing compact engine export")
bpy.ops.object.select_all(action="DESELECT")
for o in runtime:
    if o.type in ("MESH", "CURVE"):
        o.select_set(True)
bpy.context.view_layer.objects.active = next(o for o in runtime if o.type == "MESH")
bpy.ops.object.convert(target="MESH")
runtime = [o for o in bpy.data.objects if exportable(o)]
moving = {o for r in convoy_roots for o in descendants(r)}
static_meshes = [o for o in runtime if o.type == "MESH" and o not in moving]
groups = defaultdict(list)
for o in static_meshes:
    key = tuple(m.name if m else "None" for m in o.data.materials)
    # Terrain separate improves collider construction and culling diagnostics.
    if "LANDSCAPE" in o.name or o.name == "Terrain exposed edge":
        key = ("Terrain",) + key
    groups[key].append(o)
joined = []
for gi, (key, objects) in enumerate(groups.items()):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        world = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = world
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    if len(objects) > 1:
        bpy.ops.object.join()
    result = bpy.context.object
    result.name = "LM_STATIC_" + "_".join(key)[:80]
    # FBX export applies transforms. Set a stable world origin on merged geometry.
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    joined.append(result)

# Vehicle bodies merge by material independently; wheel pivot hierarchies remain.
for vehicle in convoy_roots:
    groups = defaultdict(list)
    for o in vehicle.children_recursive:
        if o.type != "MESH":
            continue
        parent = o.parent
        under_wheel = False
        while parent and parent != vehicle:
            under_wheel |= parent.name.startswith("LM_WHEEL_")
            parent = parent.parent
        if not under_wheel:
            groups[tuple(m.name for m in o.data.materials if m)].append(o)
    for key, objects in groups.items():
        bpy.ops.object.select_all(action="DESELECT")
        for o in objects:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        if len(objects) > 1:
            bpy.ops.object.join()
        bpy.context.object.name = vehicle.name + "_" + "_".join(key)

for vehicle in convoy_roots:
    for pivot in [o for o in vehicle.children_recursive if o.name.startswith("LM_WHEEL_")]:
        by_material = defaultdict(list)
        for o in pivot.children_recursive:
            if o.type == "MESH":
                by_material[tuple(m.name for m in o.data.materials if m)].append(o)
        for key, objects in by_material.items():
            bpy.ops.object.select_all(action="DESELECT")
            for o in objects:
                o.select_set(True)
            bpy.context.view_layer.objects.active = objects[0]
            if len(objects) > 1:
                bpy.ops.object.join()
            bpy.context.object.name = "WheelGeometry_" + "_".join(key)

runtime = [o for o in bpy.data.objects if exportable(o)]
bpy.ops.object.select_all(action="DESELECT")
for o in runtime:
    o.select_set(True)
bpy.context.view_layer.objects.active = joined[0]
fbx_path = EXPORTS / "LastMileMap.fbx"
bpy.ops.export_scene.fbx(filepath=str(fbx_path), use_selection=True,
                         object_types={"EMPTY", "MESH"}, use_mesh_modifiers=True,
                         axis_forward="-Z", axis_up="Y", global_scale=1,
                         apply_unit_scale=True, apply_scale_options="FBX_SCALE_ALL",
                         use_space_transform=True, bake_space_transform=False,
                         path_mode="RELATIVE", embed_textures=False,
                         add_leaf_bones=False, bake_anim=False, use_custom_props=False)
if args.glb:
    bpy.ops.export_scene.gltf(filepath=str(EXPORTS / "LastMileMap.glb"), export_format="GLB",
                             use_selection=True, export_extras=False, export_cameras=False,
                             export_lights=False, export_yup=True)

triangles = 0
for o in runtime:
    if o.type == "MESH":
        o.data.calc_loop_triangles()
        triangles += len(o.data.loop_triangles)
report = {"blenderVersion": bpy.app.version_string,
          "source": str(SOURCE.relative_to(ROOT)),
          "sourceSha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
          "authoring": str(blend_path.relative_to(ROOT)),
          "fbx": str(fbx_path.relative_to(ROOT)), "fbxBytes": fbx_path.stat().st_size,
          "triangles": triangles, "staticMeshGroups": len(joined),
          "textureFiles": len(list(TEXTURES.glob("*.png"))), "convoy": convoy_report,
          "clearedN00Props": cleared_n00_props,
          "staticGatePose": {"angleDegrees": 80, "children": raised_gate_children},
          "coordinates": {"blenderToUnity": "(x, y, z) -> (x, z, y)",
                          "anchors": ["LM_ANCHOR_N00", "LM_ANCHOR_N01", "LM_ANCHOR_N07"],
                          "fbxForward": "-Z", "fbxUp": "Y", "unitScale": 1},
          "limitations": ["Schematic authored geography, not GIS or real terrain.",
                          "Refined game art, not photogrammetry or a photorealistic environment.",
                          "Preview uses Blender lighting; Unity runtime is verified separately."]}
(OUT / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")
log(json.dumps(report))

if not args.skip_render:
    # Restore the editable scene (not the compact export) for art QA.
    bpy.ops.wm.open_mainfile(filepath=str(blend_path))
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1440
    scene.render.resolution_y = 1000
    scene.render.resolution_percentage = 100
    # Existing studio lights are useful for this review image, never exported.
    for c in bpy.data.collections:
        if c.name.startswith("11_"):
            c.hide_render = False
            c.hide_viewport = False
    cameras = [o for o in bpy.data.objects if o.type == "CAMERA"]
    if cameras:
        scene.camera = cameras[0]
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(OUT / "refined-scene-preview.png")
    bpy.ops.render.render(write_still=True)
log("Refinement complete; original Blender and GLB assets untouched.")
