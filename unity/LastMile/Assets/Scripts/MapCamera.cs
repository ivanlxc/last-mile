using UnityEngine;

namespace LastMile
{
    // Perspective controls only change presentation, never authoritative game state.
    public sealed class MapCamera : MonoBehaviour
    {
        public LastMileBridge bridge;
        private Camera view;
        private Transform convoy;
        private Vector3 center = new Vector3(0, 1, 0);
        private float yaw = -17;
        private float pitch = 49;
        private float distance = 43;
        private bool following;
        private Vector3 pointerStart;
        private Vector3 previousPointer;
        private bool dragging;
        private bool pointerCaptured;
        private float previousAspect;
        private float gesturesSuppressedUntil;
        private const float ManualInputPrioritySeconds = 0.5f;

        public bool Following => following;
        public void SetConvoy(Transform target) { convoy = target; }

        private void Awake()
        {
            view = GetComponent<Camera>();
            view.orthographic = false;
            view.fieldOfView = 43;
            view.nearClipPlane = 0.08f;
            view.farClipPlane = 160;
            view.clearFlags = CameraClearFlags.SolidColor;
            view.backgroundColor = new Color(0.51f, 0.60f, 0.62f);
            view.allowHDR = false;
            view.allowMSAA = true;
            previousAspect = view.aspect;
            ResetView();
        }

        public void ResetView()
        {
            SuppressGestures();
            following = false;
            center = new Vector3(0, 1, 0);
            yaw = -17; pitch = 49;
            distance = OverviewDistance();
            PositionCamera();
        }

        public void FollowConvoy()
        {
            SuppressGestures();
            if (convoy == null) return;
            following = true;
            center = convoy.position + Vector3.up * 0.2f;
            pitch = 38;
            distance = 7.5f;
            PositionCamera();
        }

        public void ApplyGestureInput(CameraInput input)
        {
            // No velocity or backlog: stop/release/loss needs no extra animation to settle.
            if (input.mode == "stop") return;
            Vector3 mouse = Input.mousePosition;
            bool inside = PointerInside(mouse);
            // SendMessage can arrive before Update consumes the current input frame.
            bool manualInputNow = inside && (Input.GetMouseButton(0) || Input.GetMouseButton(1) ||
                Input.GetMouseButtonDown(0) || Input.GetMouseButtonDown(1) ||
                Input.mouseScrollDelta.y != 0 || Input.GetKeyDown(KeyCode.Home) || Input.GetKeyDown(KeyCode.F));
            if (manualInputNow) SuppressGestures();
            if (pointerCaptured || Time.unscaledTime < gesturesSuppressedUntil) return;
            if (input.mode == "pan") Pan(input.dx, input.dy);
            else if (input.mode == "zoom") Zoom(input.zoomLog);
            else if (input.mode == "orbit") OrbitDegrees(input.dx * 180, input.dy * 120);
            PositionCamera();
        }

        private void SuppressGestures()
        {
            gesturesSuppressedUntil = Time.unscaledTime + ManualInputPrioritySeconds;
        }

        private static bool PointerInside(Vector3 point)
        {
            return point.x >= 0 && point.x <= Screen.width && point.y >= 0 && point.y <= Screen.height;
        }

        private void Pan(float dx, float dy)
        {
            if (dx == 0 && dy == 0) return;
            following = false;
            Vector3 right = transform.right; right.y = 0; right.Normalize();
            Vector3 forward = Vector3.Cross(right, Vector3.up);
            float visibleHeight = 2 * distance * Mathf.Tan(view.fieldOfView * Mathf.Deg2Rad * 0.5f);
            center -= right * dx * visibleHeight * view.aspect;
            center -= forward * dy * visibleHeight;
            center.x = Mathf.Clamp(center.x, -23, 23); center.z = Mathf.Clamp(center.z, -17, 17);
        }

        private void Zoom(float zoomLog)
        {
            // Changing distance preserves an existing convoy-follow target.
            distance = Mathf.Clamp(distance * Mathf.Exp(-zoomLog), 2.8f, 90);
        }

        private void OrbitDegrees(float yawDelta, float pitchDelta)
        {
            if (yawDelta == 0 && pitchDelta == 0) return;
            following = false;
            yaw += yawDelta;
            // Positive input is an upward drag, moving the view toward the horizon.
            pitch = Mathf.Clamp(pitch - pitchDelta, 16, 78);
        }

        private float OverviewDistance()
        {
            float aspect = Mathf.Max(view.aspect, 0.6f);
            return Mathf.Clamp(43f * Mathf.Max(1, 1.45f / aspect), 43, 79);
        }

        private void Update()
        {
            Vector3 mouse = Input.mousePosition;
            Vector3 delta = mouse - previousPointer;
            previousPointer = mouse;
            bool inside = PointerInside(mouse);
            if (inside && (Input.GetMouseButtonDown(0) || Input.GetMouseButtonDown(1) || Input.mouseScrollDelta.y != 0))
                SuppressGestures();
            // Leave camera buttons to IMGUI instead of also selecting the map beneath.
            bool overControls = mouse.y < 44 && mouse.x > Screen.width - 278;
            if (inside && !overControls && (Input.GetMouseButtonDown(0) || Input.GetMouseButtonDown(1)))
            { pointerStart = mouse; dragging = false; pointerCaptured = true; delta = Vector3.zero; }
            if (pointerCaptured && (Input.GetMouseButton(0) || Input.GetMouseButton(1)) && (mouse - pointerStart).sqrMagnitude > 36)
                dragging = true;
            if (pointerCaptured) SuppressGestures();
            if (inside && pointerCaptured && Input.GetMouseButton(0) && dragging)
            {
                Pan(delta.x / Mathf.Max(Screen.width, 1), delta.y / Mathf.Max(Screen.height, 1));
            }
            if (inside && pointerCaptured && Input.GetMouseButton(1))
            {
                OrbitDegrees(delta.x * 0.27f, delta.y * 0.23f);
            }
            if (inside)
                Zoom(Input.mouseScrollDelta.y * 0.065f);
            if (inside && pointerCaptured && Input.GetMouseButtonUp(0) && !dragging && !overControls)
            {
                if (Physics.Raycast(view.ScreenPointToRay(mouse), out RaycastHit hit, 160))
                {
                    var target = hit.collider.GetComponent<MapHotspot>();
                    if (target != null) bridge.SelectNode(target.nodeId);
                }
            }
            if (!Input.GetMouseButton(0) && !Input.GetMouseButton(1)) pointerCaptured = false;
            if (inside && Input.GetKeyDown(KeyCode.Home)) ResetView();
            if (inside && Input.GetKeyDown(KeyCode.F)) { if (following) ResetView(); else FollowConvoy(); }
            if (!following && Mathf.Abs(view.aspect - previousAspect) > 0.02f && distance > 30)
                distance = OverviewDistance();
            previousAspect = view.aspect;
            if (following && convoy != null)
                center = Vector3.Lerp(center, convoy.position + Vector3.up * 0.2f, 1 - Mathf.Exp(-Time.unscaledDeltaTime * 7));
            PositionCamera();
        }

        private void PositionCamera()
        {
            var rotation = Quaternion.Euler(pitch, yaw, 0);
            transform.position = center - rotation * Vector3.forward * distance;
            transform.rotation = rotation;
        }
    }
}
