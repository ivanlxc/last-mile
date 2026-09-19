using System;
using UnityEngine;

namespace LastMile
{
    // Display-only DTOs. Never add scenario truth, report bodies or AI context here.
    [Serializable] public sealed class RenderState
    {
        public int schemaVersion;
        public string instanceId;
        public string sessionId;
        public string runEpoch;
        public long stateVersion;
        public long viewSequence;
        public string sceneId;
        public string phase;
        public string locale;
        public double missionTimeMs;
        public KnownLocation location;
        public string selectedNodeId;
    }

    [Serializable] public sealed class KnownLocation
    {
        public string nodeId;
        public string routeId;
        public int progressPermille;
    }

    // Independent camera input; it cannot carry or advance mission state.
    [Serializable] public sealed class CameraInput
    {
        public int schemaVersion;
        public string instanceId;
        public long sequence;
        public string mode;
        public float dx;
        public float dy;
        public float zoomLog;
    }

    [Serializable] public sealed class BridgeEvent
    {
        public int schemaVersion = 1;
        public string instanceId;
        public string type;
        public string nodeId;
        public string message;
    }

    [Serializable] public sealed class PublicMap
    {
        public string mapId;
        public PublicNode[] nodes;
        public PublicRoute[] routes;
    }

    [Serializable] public sealed class PublicNode
    {
        public string nodeId;
        public string label;
        public string sceneId;
        public bool playable;
        public Vector3 position;
    }

    [Serializable] public sealed class PublicRoute
    {
        public string routeId;
        public string fromNode;
        public string toNode;
        public bool enabled;
        public bool bidirectional;
        public Vector3[] waypoints;
    }

    public sealed class MapHotspot : MonoBehaviour
    {
        public string nodeId;
    }
}
