using System;
using System.Runtime.InteropServices;
using UnityEngine;

namespace LastMile
{
    // Browser sends complete public projections; Unity never opens a network session.
    [UnityEngine.Scripting.Preserve]
    public sealed class LastMileBridge : MonoBehaviour
    {
        private string instanceId;
        private RenderState current;
        private TacticalMapView map;
        private string startupError;
        private long cameraSequence = -1;

#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] private static extern void LastMileDispatch(string json);
#endif

        private void Awake()
        {
            Application.targetFrameRate = 45;
#if UNITY_WEBGL && !UNITY_EDITOR
            // Keep chat, form inputs and browser shortcuts usable outside the canvas.
            WebGLInput.captureAllKeyboardInput = false;
#endif
            try
            {
                var source = Resources.Load<TextAsset>("PublicMap");
                if (source == null) throw new InvalidOperationException("PublicMap resource is missing. Run the Last Mile project setup.");
                var publicMap = JsonUtility.FromJson<PublicMap>(source.text);
                if (publicMap == null || publicMap.nodes == null || publicMap.routes == null)
                    throw new InvalidOperationException("Public map is invalid.");
                map = gameObject.AddComponent<TacticalMapView>();
                map.Initialize(publicMap, this);
            }
            catch (Exception error)
            {
                startupError = error.Message;
                Debug.LogException(error);
            }
        }

        // Must be public: called by unityInstance.SendMessage("LastMileBridge", ...).
        [UnityEngine.Scripting.Preserve]
        public void Configure(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return;
            instanceId = value;
            current = null;
            cameraSequence = -1;
            Emit(startupError == null ? "ready" : "error", null, startupError);
        }

        [UnityEngine.Scripting.Preserve]
        public void ApplyCameraInput(string json)
        {
            if (string.IsNullOrEmpty(instanceId) || map == null || string.IsNullOrEmpty(json)) return;
            try
            {
                var input = JsonUtility.FromJson<CameraInput>(json);
                if (input == null || input.schemaVersion != 1 || input.instanceId != instanceId ||
                    input.sequence < 0 || input.sequence <= cameraSequence ||
                    (input.mode != "pan" && input.mode != "zoom" && input.mode != "orbit" && input.mode != "stop") ||
                    !Bounded(input.dx, 0.15f) || !Bounded(input.dy, 0.15f) || !Bounded(input.zoomLog, 0.35f)) return;
                // Consume even suppressed input so it cannot be replayed after mouse control.
                cameraSequence = input.sequence;
                map.ApplyCameraInput(input);
            }
            catch (Exception)
            {
                // Bad optional input must never disable the map or affect the mission.
            }
        }

        private static bool Bounded(float value, float limit)
        {
            return !float.IsNaN(value) && !float.IsInfinity(value) && Mathf.Abs(value) <= limit;
        }

        [UnityEngine.Scripting.Preserve]
        public void ApplyRenderState(string json)
        {
            if (string.IsNullOrEmpty(instanceId) || map == null) return;
            try
            {
                var next = JsonUtility.FromJson<RenderState>(json);
                if (next == null || next.schemaVersion != 1 || next.instanceId != instanceId)
                    throw new ArgumentException("Unsupported render-state schema or instance.");
                if (next.location == null || next.viewSequence < 0 || next.stateVersion < 0 ||
                    double.IsNaN(next.missionTimeMs) || double.IsInfinity(next.missionTimeMs))
                    throw new ArgumentException("Incomplete render state.");
                // Sequence belongs to this mounted Web instance, even across a session/reset.
                if (current != null && next.viewSequence <= current.viewSequence) return;
                bool newRun = current == null || next.sessionId != current.sessionId || next.runEpoch != current.runEpoch;
                if (!newRun && next.stateVersion < current.stateVersion) return;
                map.ApplyState(next, newRun);
                current = next;
            }
            catch (Exception error)
            {
                Debug.LogWarning("Rejected map projection: " + error.Message);
                Emit("error", null, error.Message);
            }
        }

        public void SelectNode(string nodeId)
        {
            // A map selection is only an intent. No task, resource or mission state changes here.
            if (!string.IsNullOrEmpty(instanceId)) Emit("select-location", nodeId, null);
        }

        private void Emit(string type, string nodeId, string message)
        {
            var json = JsonUtility.ToJson(new BridgeEvent
            {
                instanceId = instanceId, type = type, nodeId = nodeId, message = message
            });
#if UNITY_WEBGL && !UNITY_EDITOR
            LastMileDispatch(json);
#else
            Debug.Log("[Last Mile bridge] " + json);
#endif
        }
    }
}
