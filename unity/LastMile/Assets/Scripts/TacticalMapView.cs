using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

namespace LastMile
{
    // Authored scenery is public geography, never live intelligence or hidden scenario truth.
    public sealed class TacticalMapView : MonoBehaviour
    {
        private readonly Dictionary<string, PublicNode> nodes = new Dictionary<string, PublicNode>();
        private readonly Dictionary<string, PublicRoute> routes = new Dictionary<string, PublicRoute>();
        private readonly Dictionary<string, Renderer> markers = new Dictionary<string, Renderer>();
        private readonly Dictionary<string, LineRenderer> routeLines = new Dictionary<string, LineRenderer>();
        private readonly List<Material> materials = new List<Material>();
        private readonly Dictionary<string, Vector3> labelPositions = new Dictionary<string, Vector3>();
        private readonly Transform[] vehicles = new Transform[3];
        private readonly List<Transform>[] wheels = new List<Transform>[3];
        private readonly Vector3[] targetPositions = new Vector3[3];
        private readonly Quaternion[] targetRotations = new Quaternion[3];
        private Camera mapCamera;
        private MapCamera cameraControls;
        private Material surface;
        private Material ink;
        private Material routeIdle;
        private Material routeActive;
        private Material nodeIdle;
        private Material nodeActive;
        private Material nodeSelected;
        private RenderState state;
        private bool positioned;
        private bool reverseTravel;
        private PublicRoute lastTravelRoute;
        private PublicRoute incomingRoute;
        private bool incomingReverse;
        private GUIStyle captionStyle;
        private GUIStyle detailStyle;
        private GUIStyle markerStyle;
        private const float VehicleSpacing = 1.8f;
        private const float WheelRadius = 0.13f;
        private static readonly Color Cyan = new Color(0.25f, 0.85f, 0.91f);
        private static readonly Color Gold = new Color(1f, 0.78f, 0.35f);

        public void ApplyCameraInput(CameraInput input)
        {
            if (cameraControls != null) cameraControls.ApplyGestureInput(input);
        }

        public void Initialize(PublicMap map, LastMileBridge bridge)
        {
            surface = Resources.Load<Material>("MapSurface");
            ink = Resources.Load<Material>("MapInk");
            if (surface == null || ink == null)
                throw new InvalidOperationException("Map overlay materials are missing. Rebuild the Unity project.");
            routeIdle = MaterialFor(new Color(0.50f, 0.47f, 0.35f), true);
            routeActive = MaterialFor(Cyan, true);
            nodeIdle = MaterialFor(new Color(0.88f, 0.80f, 0.58f), true);
            nodeActive = MaterialFor(Cyan, true);
            nodeSelected = MaterialFor(Gold, true);

            var cameraObject = new GameObject("Map Camera");
            cameraObject.transform.SetParent(transform, false);
            cameraObject.tag = "MainCamera";
            mapCamera = cameraObject.AddComponent<Camera>();
            cameraControls = cameraObject.AddComponent<MapCamera>();
            cameraControls.bridge = bridge;
            ConfigureLighting();
            foreach (var node in map.nodes) nodes[node.nodeId] = node;
            foreach (var route in map.routes)
            {
                routes[route.routeId] = route;
                if (!route.enabled || route.waypoints == null || route.waypoints.Length < 2) continue;
                var points = Array.ConvertAll(route.waypoints, point => MapPoint(point) + Vector3.up * 0.012f);
                routeLines[route.routeId] = Line(route.routeId, points, 0.035f, routeIdle);
            }
            BuildAuthoredMap();
            foreach (var node in map.nodes) BuildNode(node);
            cameraControls.SetConvoy(vehicles[0]);
            foreach (var vehicle in vehicles) vehicle.gameObject.SetActive(false);
        }

        private void ConfigureLighting()
        {
            RenderSettings.ambientMode = AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = new Color(0.61f, 0.66f, 0.70f);
            RenderSettings.ambientEquatorColor = new Color(0.50f, 0.48f, 0.39f);
            RenderSettings.ambientGroundColor = new Color(0.30f, 0.27f, 0.22f);
            RenderSettings.ambientIntensity = 1;
            RenderSettings.fog = true;
            RenderSettings.fogMode = FogMode.Linear;
            RenderSettings.fogColor = new Color(0.51f, 0.60f, 0.62f);
            RenderSettings.fogStartDistance = 62;
            RenderSettings.fogEndDistance = 135;
            var lightObject = new GameObject("Afternoon sun");
            lightObject.transform.SetParent(transform, false);
            lightObject.transform.rotation = Quaternion.Euler(42, -35, 0);
            var sun = lightObject.AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.color = new Color(1f, 0.89f, 0.72f);
            sun.intensity = 1.12f;
            sun.shadows = LightShadows.Soft;
            sun.shadowStrength = 0.70f;
            sun.shadowBias = 0.035f;
            sun.shadowNormalBias = 0.12f;
            RenderSettings.sun = sun;
            QualitySettings.shadows = ShadowQuality.All;
            QualitySettings.shadowResolution = ShadowResolution.High;
            QualitySettings.shadowDistance = 85;
            QualitySettings.shadowCascades = 2;
            QualitySettings.antiAliasing = 4;
        }

        private void BuildAuthoredMap()
        {
            var prefab = Resources.Load<GameObject>("Art/LastMileMap");
            if (prefab == null)
                throw new InvalidOperationException("The Blender map asset is missing. Run pnpm build:art then pnpm build:unity.");
            var art = Instantiate(prefab, transform, false);
            art.name = "Blender · Last Mile valley";
            foreach (var renderer in art.GetComponentsInChildren<Renderer>())
            {
                renderer.shadowCastingMode = ShadowCastingMode.On;
                renderer.receiveShadows = true;
            }
            // Named actor roots remain independent of the static scenery and retain authored details.
            for (int i = 0; i < vehicles.Length; i++)
            {
                string actorName = "LM_CONVOY_" + (i + 1).ToString("00");
                Transform model = FindNamed(art.transform, actorName);
                if (model == null) throw new InvalidOperationException("Blender map is missing actor " + actorName);
                var rig = new GameObject(actorName + "_Runtime").transform;
                rig.SetParent(transform, false);
                rig.position = model.position;
                model.SetParent(rig, true);
                model.localPosition = Vector3.zero;
                // Blender trucks face +X; the motion rig faces Unity +Z.
                model.localRotation = Quaternion.Euler(0, -90, 0) * model.localRotation;
                vehicles[i] = rig;
                wheels[i] = new List<Transform>();
                foreach (var part in model.GetComponentsInChildren<Transform>())
                    if (part.name.StartsWith("LM_WHEEL_", StringComparison.Ordinal)) wheels[i].Add(part);
                if (wheels[i].Count == 0)
                    Debug.LogWarning(actorName + " has no named wheel pivots; the vehicle can move but wheels cannot rotate.");
            }
        }

        private static Transform FindNamed(Transform root, string name)
        {
            foreach (var child in root.GetComponentsInChildren<Transform>())
                if (child.name == name) return child;
            return null;
        }

        public void ApplyState(RenderState next, bool newRun)
        {
            bool hasRoute = !string.IsNullOrEmpty(next.location.routeId) && routes.ContainsKey(next.location.routeId);
            bool hasNode = !string.IsNullOrEmpty(next.location.nodeId) && nodes.ContainsKey(next.location.nodeId);
            if (!hasRoute && !hasNode) throw new ArgumentException("The public location is not in the map.");
            if (newRun) { lastTravelRoute = null; incomingRoute = null; reverseTravel = false; }
            if (hasRoute)
            {
                var route = routes[next.location.routeId];
                bool continuingRoute = !newRun && state != null && state.location.routeId == next.location.routeId;
                if (!continuingRoute && lastTravelRoute != null && lastTravelRoute.routeId != route.routeId)
                {
                    incomingRoute = lastTravelRoute;
                    incomingReverse = reverseTravel;
                }
                if (!continuingRoute)
                    reverseTravel = !newRun && state != null && state.location.nodeId == route.toNode;
                else if (next.location.progressPermille != state.location.progressPermille)
                    reverseTravel = next.location.progressPermille < state.location.progressPermille;
                lastTravelRoute = route;
            }
            foreach (var entry in routeLines)
            {
                bool active = entry.Key == next.location.routeId;
                entry.Value.sharedMaterial = active ? routeActive : routeIdle;
                entry.Value.startWidth = entry.Value.endWidth = active ? 0.085f : 0.035f;
            }
            foreach (var entry in markers)
                entry.Value.sharedMaterial = entry.Key == next.selectedNodeId ? nodeSelected :
                    entry.Key == next.location.nodeId ? nodeActive : nodeIdle;

            PublicRoute formationRoute = hasRoute ? routes[next.location.routeId] : lastTravelRoute;
            if (formationRoute != null && !hasRoute && formationRoute.fromNode != next.location.nodeId && formationRoute.toNode != next.location.nodeId)
                formationRoute = null;
            // The briefing starts at a real route origin, with vehicles queued behind it.
            if (formationRoute == null && hasNode)
                foreach (var route in routes.Values)
                    if (route.enabled && route.fromNode == next.location.nodeId) { formationRoute = route; reverseTravel = false; break; }

            for (int i = 0; i < vehicles.Length; i++)
            {
                Vector3 target;
                Quaternion rotation;
                if (formationRoute != null)
                {
                    float progress = hasRoute ? Mathf.Clamp01(next.location.progressPermille / 1000f) :
                        (formationRoute.toNode == next.location.nodeId ? 1 : 0);
                    float trail = i * VehicleSpacing / Mathf.Max(RouteLength(formationRoute), 1);
                    float local = progress + (reverseTravel ? trail : -trail);
                    target = PlaceOnAuthoredSurface(SampleFormation(formationRoute, local));
                    Vector3 tangent = (SampleFormation(formationRoute, local + 0.003f) -
                        SampleFormation(formationRoute, local - 0.003f)).normalized * (reverseTravel ? -1 : 1);
                    rotation = tangent.sqrMagnitude > 0.0001f ? Quaternion.LookRotation(tangent) : vehicles[i].rotation;
                }
                else
                {
                    target = PlaceOnAuthoredSurface(MapPoint(nodes[next.location.nodeId].position) + Vector3.left * (i * VehicleSpacing));
                    rotation = Quaternion.Euler(0, 90, 0);
                }
                targetPositions[i] = target;
                targetRotations[i] = rotation;
                if (newRun || !positioned || Vector3.Distance(vehicles[i].position, target) > 6)
                { vehicles[i].position = target; vehicles[i].rotation = rotation; }
                vehicles[i].gameObject.SetActive(true);
            }
            state = next;
            positioned = true;
        }

        private void Update()
        {
            if (!positioned) return;
            for (int i = 0; i < vehicles.Length; i++)
            {
                // Smooth toward received positions only. No client-side simulation advances the convoy.
                float blend = 1 - Mathf.Exp(-Time.unscaledDeltaTime * 6);
                Vector3 before = vehicles[i].position;
                vehicles[i].position = Vector3.Lerp(before, targetPositions[i], blend);
                vehicles[i].rotation = Quaternion.Slerp(vehicles[i].rotation, targetRotations[i], blend);
                float distance = Vector3.Distance(before, vehicles[i].position);
                if (distance > 0.00001f)
                    foreach (var wheel in wheels[i])
                    {
                        // FBX wheel pivots may point left or right; derive the rolling sign
                        // from the authored axle instead of making one side spin backwards.
                        Vector3 rollingDirection = Vector3.Cross(wheel.right, vehicles[i].up).normalized;
                        float travel = Vector3.Dot(vehicles[i].position - before, rollingDirection);
                        wheel.Rotate(Vector3.right, travel / WheelRadius * Mathf.Rad2Deg, Space.Self);
                    }
            }
        }

        private void BuildNode(PublicNode node)
        {
            var position = MapPoint(node.position) + Vector3.up * 0.03f;
            var marker = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            marker.name = node.nodeId;
            marker.transform.SetParent(transform, false);
            marker.transform.position = position;
            marker.transform.localScale = new Vector3(0.38f, 0.012f, 0.38f);
            markers[node.nodeId] = marker.GetComponent<Renderer>();
            markers[node.nodeId].sharedMaterial = nodeIdle;
            markers[node.nodeId].shadowCastingMode = ShadowCastingMode.Off;
            Destroy(marker.GetComponent<Collider>());
            var target = new GameObject("Select " + node.nodeId);
            target.transform.SetParent(transform, false);
            target.transform.position = MapPoint(node.position) + Vector3.up * 0.35f;
            target.AddComponent<SphereCollider>().radius = 0.55f;
            target.AddComponent<MapHotspot>().nodeId = node.nodeId;
            labelPositions[node.nodeId] = MapPoint(node.position) + Vector3.up * 0.9f;
        }

        private LineRenderer Line(string name, Vector3[] points, float width, Material material)
        {
            var item = new GameObject(name); item.transform.SetParent(transform, false);
            var line = item.AddComponent<LineRenderer>(); line.useWorldSpace = true;
            line.positionCount = points.Length; line.SetPositions(points);
            line.startWidth = width; line.endWidth = width; line.numCornerVertices = 3; line.numCapVertices = 3;
            line.alignment = LineAlignment.TransformZ;
            item.transform.rotation = Quaternion.Euler(90, 0, 0);
            line.sharedMaterial = material;
            line.shadowCastingMode = ShadowCastingMode.Off;
            line.receiveShadows = false;
            return line;
        }

        private Material MaterialFor(Color color, bool unlit = false)
        {
            var material = new Material(unlit ? ink : surface) { color = color };
            materials.Add(material); return material;
        }

        private static Vector3 MapPoint(Vector3 publicPoint) => new Vector3(publicPoint.x, publicPoint.y, -publicPoint.z);

        private static Vector3 PlaceOnAuthoredSurface(Vector3 point)
        {
            // The N00 concrete apron is 0.13 above the terrain used by the public
            // route coordinates. This is a render-only tire contact adjustment.
            // Bounds come from the Blender pad, including vehicles queued behind N00.
            float inside = Mathf.Min(point.x + 19.2f, -14.2f - point.x,
                point.z + 12.5f, -7.5f - point.z);
            float edgeBlend = Mathf.SmoothStep(0, 1, Mathf.InverseLerp(-0.20f, 0.15f, inside));
            point.y += 0.13f * edgeBlend;
            return point;
        }

        private static float RouteLength(PublicRoute route)
        {
            float result = 0;
            for (int i = 1; i < route.waypoints.Length; i++)
                result += Vector3.Distance(route.waypoints[i - 1], route.waypoints[i]);
            return result;
        }

        private Vector3 SampleFormation(PublicRoute route, float progress)
        {
            bool behindJunction = reverseTravel ? progress > 1 : progress < 0;
            if (behindJunction && incomingRoute != null)
            {
                string junction = reverseTravel ? route.toNode : route.fromNode;
                string incomingEnd = incomingReverse ? incomingRoute.fromNode : incomingRoute.toNode;
                if (junction == incomingEnd)
                {
                    float behind = (reverseTravel ? progress - 1 : -progress) * RouteLength(route);
                    float previousProgress = (incomingReverse ? 0 : 1) +
                        (incomingReverse ? behind : -behind) / Mathf.Max(RouteLength(incomingRoute), 0.001f);
                    return SampleRoute(incomingRoute, previousProgress);
                }
            }
            return SampleRoute(route, progress);
        }

        private static Vector3 SampleRoute(PublicRoute route, float progress)
        {
            float remaining = RouteLength(route) * progress;
            // Extend the first/last segment for queued vehicles instead of collapsing them at an endpoint.
            if (remaining < 0)
                return MapPoint(route.waypoints[0]) +
                    (MapPoint(route.waypoints[1]) - MapPoint(route.waypoints[0])).normalized * remaining;
            for (int i = 1; i < route.waypoints.Length; i++)
            {
                var a = MapPoint(route.waypoints[i - 1]); var b = MapPoint(route.waypoints[i]);
                float length = Vector3.Distance(a, b);
                if (remaining <= length) return Vector3.Lerp(a, b, length > 0 ? remaining / length : 0);
                remaining -= length;
            }
            int last = route.waypoints.Length - 1;
            return MapPoint(route.waypoints[last]) +
                (MapPoint(route.waypoints[last]) - MapPoint(route.waypoints[last - 1])).normalized * remaining;
        }

        private void OnGUI()
        {
            if (captionStyle == null)
            {
                captionStyle = new GUIStyle(GUI.skin.label) { fontSize = 13, fontStyle = FontStyle.Bold };
                captionStyle.normal.textColor = new Color(0.80f, 0.91f, 0.89f);
                detailStyle = new GUIStyle(GUI.skin.label) { fontSize = 10 };
                detailStyle.normal.textColor = new Color(0.76f, 0.80f, 0.75f);
                markerStyle = new GUIStyle(GUI.skin.label) { fontSize = 11, fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleCenter };
            }
            // React supplies the title and controls around compact canvases. Leave the
            // available map area for geography instead of repeating the full engine HUD.
            bool compact = Screen.width < 640 || Screen.height < 360 || (float)Screen.width / Mathf.Max(Screen.height, 1) > 2.5f;
            markerStyle.fontSize = compact ? 10 : 11;
            var occupiedLabels = new List<Rect>();
            if (mapCamera != null)
                // Reserve space for the selected/current location before other public nodes.
                for (int priority = 0; priority < (compact ? 2 : 3); priority++)
                foreach (var entry in labelPositions)
                {
                    var node = nodes[entry.Key];
                    bool selected = state != null && state.selectedNodeId == entry.Key;
                    bool current = state != null && (!string.IsNullOrEmpty(state.location.nodeId)
                        ? state.location.nodeId == entry.Key
                        : !string.IsNullOrEmpty(state.sceneId) && state.sceneId == node.sceneId);
                    if ((selected ? 0 : current ? 1 : 2) != priority) continue;
                    var point = mapCamera.WorldToScreenPoint(entry.Value);
                    float top = compact ? 4 : 56;
                    float bottom = Screen.height - (compact ? 4 : 35);
                    float screenY = Screen.height - point.y;
                    if (point.z <= 0 || point.x < 0 || point.x > Screen.width || screenY < top || screenY > bottom) continue;
                    string label = string.IsNullOrEmpty(node.sceneId) ? node.nodeId : node.nodeId + " / " + node.sceneId;
                    float width = markerStyle.CalcSize(new GUIContent(label)).x + 12;
                    float height = compact ? 18 : 20;
                    var bounds = new Rect(Mathf.Clamp(point.x - width / 2, 4, Screen.width - width - 4),
                        Mathf.Clamp(screenY - height / 2, top, bottom - height), width, height);
                    var clearance = new Rect(bounds.x - 4, bounds.y - 3, bounds.width + 8, bounds.height + 6);
                    if (occupiedLabels.Exists(other => other.Overlaps(clearance))) continue;
                    occupiedLabels.Add(clearance);
                    markerStyle.normal.textColor = selected ? Gold : current ? Cyan : new Color(0.95f, 0.94f, 0.87f);
                    GUI.Box(bounds, GUIContent.none);
                    GUI.Label(bounds, label, markerStyle);
                }
            if (!compact)
            {
                GUI.Label(new Rect(18, 12, 350, 22), "LAST MILE  /  OPERATIONS MAP", captionStyle);
                GUI.Label(new Rect(18, 33, 400, 20), "AUTHORED 3D TERRAIN · LIVE CONVOY POSITION", detailStyle);
                GUI.Label(new Rect(18, Screen.height - 26, Mathf.Max(0, Screen.width - 310), 20), "DRAG  Pan    RIGHT DRAG  Orbit    SCROLL  Zoom    F  Follow", detailStyle);
            }

            // These camera controls do not move the convoy or consume mission resources.
            GUI.enabled = positioned;
            if (GUI.Button(new Rect(Screen.width - 270, Screen.height - 38, 126, 29),
                cameraControls.Following ? "Following convoy" : "Follow convoy [F]"))
                cameraControls.FollowConvoy();
            GUI.enabled = true;
            if (GUI.Button(new Rect(Screen.width - 138, Screen.height - 38, 126, 29), "Overview [Home]"))
                cameraControls.ResetView();
        }

        private void OnDestroy()
        {
            foreach (var material in materials) Destroy(material);
        }
    }
}
