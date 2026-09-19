"""Render a registered, north-up reference from public Blender geography.

Run from any directory:
  blender --background --python-exit-code 1 --python scripts/render-satellite-reference.py

Outputs are confined to .local-artifacts/satellite. The source .blend is opened
read-only in memory, never saved. No private event files or custom properties
are read. The camera covers Blender X[-24,24], Y[-16,16], with north at the top;
public glTF coordinates map as Blender(x,y,z) = glTF(x,-z,y).
"""

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
import os
from pathlib import Path
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector
from mathutils.bvhtree import BVHTree


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets/authoring/last-mile-unity/LAST_MILE_Unity_Refined.blend"
PUBLIC_MAP = ROOT / "client/src/lib/map-data.json"
OUTPUT = ROOT / ".local-artifacts/satellite"
WIDTH, HEIGHT = 1536, 1024
X_MIN, X_MAX, Y_MIN, Y_MAX = -24.0, 24.0, -16.0, 16.0
HIDDEN_COLLECTION_PREFIXES = ("00_", "06_", "08_", "09_", "10_", "11_")
HIDDEN_OBJECT_PREFIXES = (
    "CONVOY_", "LM_CONVOY_", "LM_WHEEL_", "LM_ANCHOR_", "HOTSPOT_",
    "TEXT_", "EVENT_", "E1_", "E2_", "E3_",
)


def log(message):
    print("[SATELLITE REFERENCE]", message, flush=True)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def world_bounds(obj):
    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    return {
        "min": [round(min(point[axis] for point in corners), 6) for axis in range(3)],
        "max": [round(max(point[axis] for point in corners), 6) for axis in range(3)],
    }


def extend_ground(terrain, target_collection):
    """Join a static apron to the existing boundary, without moving terrain.

    A plane under the diorama would leave a rectangular cliff/shadow. This
    follows every original boundary vertex and continues its elevation beyond
    the framing rectangle. UVs use the same world-space scale as the source.
    """
    edges = Counter()
    neighbors = defaultdict(list)
    for polygon in terrain.data.polygons:
        for a, b in polygon.edge_keys:
            edges[tuple(sorted((a, b)))] += 1
    for (a, b), count in edges.items():
        if count == 1:
            neighbors[a].append(b)
            neighbors[b].append(a)
    assert neighbors and all(len(values) == 2 for values in neighbors.values()), "Expected one closed terrain perimeter"
    start = min(neighbors)
    ring = [start]
    previous, current = None, start
    while True:
        following = next(index for index in neighbors[current] if index != previous)
        if following == start:
            break
        ring.append(following)
        previous, current = current, following
        assert len(ring) <= len(neighbors), "Invalid terrain perimeter"
    assert len(ring) == len(neighbors), "Unexpected terrain hole"
    inner = [terrain.matrix_world @ terrain.data.vertices[index].co for index in ring]
    signed_area = sum(a.x * b.y - b.x * a.y for a, b in zip(inner, inner[1:] + inner[:1]))
    if signed_area < 0:
        inner.reverse()
    outer = [Vector((point.x * 1.30, point.y * 1.30, point.z)) for point in inner]
    vertices = inner + outer
    count = len(inner)
    faces = [(index, index + count, (index + 1) % count + count, (index + 1) % count) for index in range(count)]
    mesh = bpy.data.meshes.new("Satellite ground continuation")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    apron = bpy.data.objects.new("Satellite static ground continuation", mesh)
    target_collection.objects.link(apron)
    for material in terrain.data.materials:
        mesh.materials.append(material)
    uv = mesh.uv_layers.new(name="UVMap")
    for polygon in mesh.polygons:
        polygon.use_smooth = True
        for loop_index in polygon.loop_indices:
            point = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            uv.data[loop_index].uv = (point.x * 0.65, point.y * 0.65)
    return apron, count


def verify_routes(public_map):
    """Compare only public route waypoints with the static road mesh footprint."""
    checks = []
    for route in public_map["routes"]:
        meshes = [obj for obj in bpy.data.objects if obj.type == "MESH" and obj.name.startswith(route["routeId"] + "_") and obj.name.endswith("road")]
        assert len(meshes) == 1, f"Missing public road geometry: {route['routeId']}"
        mesh = meshes[0]
        points = [mesh.matrix_world @ vertex.co for vertex in mesh.data.vertices]
        footprint = BVHTree.FromPolygons(
            [Vector((point.x, point.y, 0)) for point in points],
            [list(polygon.vertices) for polygon in mesh.data.polygons],
            all_triangles=False,
        )
        distances = []
        for x, _height, south in route["waypoints"]:
            _nearest, _normal, _index, distance = footprint.find_nearest(Vector((x, -south, 0)))
            assert distance is not None
            distances.append(distance)
        maximum = max(distances)
        assert maximum < 0.02, f"Public route {route['routeId']} deviates from its static road: {maximum}"
        checks.append({
            "routeId": route["routeId"],
            "mesh": mesh.name,
            "waypointCount": len(distances),
            "maxDistanceFromRoadFootprint": round(maximum, 8),
        })
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--skip-render", action="store_true", help="Only validate and write registration metadata")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    assert args.samples > 0
    OUTPUT.mkdir(parents=True, exist_ok=True)
    source_hash = sha256(SOURCE)
    public_map = json.loads(PUBLIC_MAP.read_text())
    assert public_map["coordinateSystem"] == "glb_x_right_y_up_z_south"
    bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
    scene = bpy.context.scene
    bpy.context.view_layer.update()
    route_checks = verify_routes(public_map)

    hidden = set()
    for collection in bpy.data.collections:
        if collection.name.startswith(HIDDEN_COLLECTION_PREFIXES):
            collection.hide_render = True
            hidden.update(collection.all_objects)
    for obj in bpy.data.objects:
        if (obj.type in ("FONT", "LIGHT", "CAMERA")
                or obj.name.startswith(HIDDEN_OBJECT_PREFIXES)
                or obj.name in ("Terrain exposed edge", "Contours of the dry ridges")):
            hidden.add(obj)
    for obj in tuple(hidden):
        hidden.update(obj.children_recursive)
    for obj in hidden:
        obj.hide_render = True

    reference = bpy.data.collections.new("SATELLITE_REFERENCE_ONLY")
    scene.collection.children.link(reference)
    terrain = bpy.data.objects["LANDSCAPE_desert"]
    terrain_bounds = world_bounds(terrain)
    apron, perimeter_vertices = extend_ground(terrain, reference)

    camera_data = bpy.data.cameras.new("Satellite orthographic north-up")
    camera_data.type = "ORTHO"
    camera_data.sensor_fit = "HORIZONTAL"
    camera_data.ortho_scale = X_MAX - X_MIN
    camera_data.clip_start = 0.1
    camera_data.clip_end = 200
    camera = bpy.data.objects.new("Satellite orthographic north-up", camera_data)
    reference.objects.link(camera)
    camera.location = (0, 0, 80)
    camera.rotation_euler = (0, 0, 0)  # Local -Z looks straight down; local +Y points north.
    scene.camera = camera
    scene.render.resolution_x = WIDTH
    scene.render.resolution_y = HEIGHT
    scene.render.resolution_percentage = 100
    scene.render.pixel_aspect_x = scene.render.pixel_aspect_y = 1
    scene.render.use_border = False
    scene.render.use_compositing = False
    scene.render.use_sequencer = False
    scene.render.film_transparent = False
    bpy.context.view_layer.update()
    frame = camera_data.view_frame(scene=scene)
    frame_bounds = {
        "x": [min(point.x for point in frame), max(point.x for point in frame)],
        "y": [min(point.y for point in frame), max(point.y for point in frame)],
    }
    assert max(abs(a-b) for a,b in zip(frame_bounds["x"] + frame_bounds["y"], [X_MIN, X_MAX, Y_MIN, Y_MAX])) < 1e-5, frame_bounds
    for point, expected in [((X_MIN, Y_MAX, 0), (0, 1)), ((X_MAX, Y_MIN, 0), (1, 0))]:
        ndc = world_to_camera_view(scene, camera, Vector(point))
        assert abs(ndc.x - expected[0]) < 1e-6 and abs(ndc.y - expected[1]) < 1e-6

    sun_data = bpy.data.lights.new("Reference noon sun", "SUN")
    sun_data.energy = 2.8
    sun_data.angle = math.radians(3)
    sun = bpy.data.objects.new("Reference noon sun", sun_data)
    reference.objects.link(sun)
    sun.rotation_euler = Vector((0.30, -0.38, -1)).to_track_quat("-Z", "Y").to_euler()
    scene.world = bpy.data.worlds.new("Reference daylight")
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.72, 0.81, 1.0, 1)
    background.inputs["Strength"].default_value = 0.55
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = args.samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 4
    scene.cycles.diffuse_bounces = 2
    scene.cycles.glossy_bounces = 2
    scene.cycles.transmission_bounces = 2
    scene.render.threads_mode = "FIXED"
    scene.render.threads = max(1, min(8, os.cpu_count() or 4))
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.render.filepath = str(OUTPUT / "reference-topdown.png")

    nodes = []
    for node in public_map["nodes"]:
        x, height, south = node["position"]
        world = Vector((x, -south, height))
        ndc = world_to_camera_view(scene, camera, world)
        anchor = bpy.data.objects.get("LM_ANCHOR_" + node["nodeId"])
        if anchor:
            assert (anchor.matrix_world.translation - world).length < 1e-5
        nodes.append({
            "nodeId": node["nodeId"],
            "glb": node["position"],
            "blender": list(world),
            "pixel": [round(ndc.x * WIDTH, 5), round((1 - ndc.y) * HEIGHT, 5)],
        })
    metadata = {
        "source": str(SOURCE.relative_to(ROOT)),
        "sourceSha256": source_hash,
        "publicMap": str(PUBLIC_MAP.relative_to(ROOT)),
        "publicMapSha256": sha256(PUBLIC_MAP),
        "blenderVersion": bpy.app.version_string,
        "image": "reference-topdown.png",
        "resolution": [WIDTH, HEIGHT],
        "projection": "orthographic; north-up; no camera tilt",
        "camera": {"location": list(camera.location), "rotationRadians": list(camera.rotation_euler), "orthoScale": camera_data.ortho_scale, "sensorFit": camera_data.sensor_fit, "verifiedFrame": frame_bounds},
        "blenderBounds": {"x": [X_MIN, X_MAX], "y": [Y_MIN, Y_MAX]},
        "glbBounds": {"x": [X_MIN, X_MAX], "z": [-Y_MAX, -Y_MIN]},
        "pixelMapping": {"x": "(glbX + 24) * 32", "y": "(glbZ + 16) * 32", "boundsReferTo": "image edges; width=1536, height=1024"},
        "originalTerrainBounds": terrain_bounds,
        "continuationBounds": world_bounds(apron),
        "continuationPerimeterVertices": perimeter_vertices,
        "removedObjectCount": len(hidden),
        "removedCollectionPrefixes": list(HIDDEN_COLLECTION_PREFIXES),
        "routeAlignmentChecks": route_checks,
        "publicNodes": nodes,
        "limitations": ["Fictional authored geography, not GIS or satellite photography.", "Ground outside the original terrain is a static render-only continuation.", "No labels, nodes, actors, event layers or authored tabletop appear in the reference."],
    }
    (OUTPUT / "reference-bounds.json").write_text(json.dumps(metadata, indent=2) + "\n")
    log(f"Registered {WIDTH}x{HEIGHT} frame; {len(route_checks)} road footprints verified; {len(hidden)} non-geographic objects hidden")
    if not args.skip_render:
        bpy.ops.render.render(write_still=True)
    assert sha256(SOURCE) == source_hash, "Source file was unexpectedly modified"
    log(f"Reference: {scene.render.filepath}; source unchanged")


if __name__ == "__main__":
    main()
