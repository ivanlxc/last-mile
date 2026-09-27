using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;

namespace LastMile.Art
{
    // Movement and neutral rendering only. FieldConsole owns the public API presentation.
    [RequireComponent(typeof(CharacterController))]
    public sealed class ArtWalkthrough : MonoBehaviour
    {
        public Camera eye;
        public Vector3 home;
        public Vector3 lookAt;
        public float speed = 2.6f;
        private CharacterController body;
        private LastMile.Field.FieldConsole console;
        private float pitch;
        private float gravity;
                private bool details = true;
        private float sampleStarted;
        private readonly List<float> frames = new List<float>(1800);
        private string performanceText = "";
        private Font hudFont;
        private GUIStyle smallStyle;

        private void Awake()
        {
            body = GetComponent<CharacterController>();
            console = gameObject.AddComponent<LastMile.Field.FieldConsole>();
            QualitySettings.vSyncCount = 1;
            Application.targetFrameRate = 60;
            Application.runInBackground = true;
            hudFont = Resources.Load<Font>("Fonts/NotoSansCJKsc-Regular");
            if (hudFont == null) throw new InvalidOperationException("Bundled HUD font is missing.");
            ResetView();
            sampleStarted = Time.realtimeSinceStartup;
        }

        private void ResetView()
        {
            body.enabled = false;
            transform.position = home;
            var direction = lookAt - (home + Vector3.up * 1.68f);
            transform.rotation = Quaternion.Euler(0, Mathf.Atan2(direction.x, direction.z) * Mathf.Rad2Deg, 0);
            pitch = -Mathf.Atan2(direction.y, new Vector2(direction.x, direction.z).magnitude) * Mathf.Rad2Deg;
            eye.transform.localRotation = Quaternion.Euler(pitch, 0, 0);
            gravity = 0;
            body.enabled = true;
        }

        private void ReleaseMouse()
        {
            Cursor.lockState = CursorLockMode.None;
            Cursor.visible = true;
        }

        private void CaptureMouse()
        {
            Cursor.lockState = CursorLockMode.Locked;
            Cursor.visible = false;
        }

        private void OnApplicationFocus(bool focus)
        {
            if (!focus) ReleaseMouse();
            QualitySettings.vSyncCount = focus ? 1 : 0;
            Application.targetFrameRate = focus ? 60 : 10;
            // A paused/background frame is not part of a continuous foreground sample.
            frames.Clear();
            performanceText = "";
            sampleStarted = Time.realtimeSinceStartup;
        }
        private void OnDisable() { ReleaseMouse(); }

        private void Update()
        {
            if (Input.GetKeyDown(KeyCode.Escape)) ReleaseMouse();
            if (Input.GetKeyDown(KeyCode.Return) && !console.IsOpen)
            {
                if (Cursor.lockState == CursorLockMode.Locked) ReleaseMouse();
                else CaptureMouse();
            }
            if (Input.GetKeyDown(KeyCode.F9)) details = !details;
            if (Input.GetKeyDown(KeyCode.Home) && !console.IsOpen) ResetView();
            if (Input.GetKeyDown(KeyCode.F12) || (Input.GetKeyDown(KeyCode.P) && !console.IsOpen))
            {
                string path = Path.Combine(Application.persistentDataPath, "Market-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff") + ".png");
                ScreenCapture.CaptureScreenshot(path);
                Debug.Log("LAST_MILE_ART_CAPTURE: " + path);
            }
            if (Input.GetMouseButtonDown(0) && !console.IsOpen && Input.mousePosition.y < Screen.height - 115)
            {
                CaptureMouse();
            }
            if (Cursor.lockState == CursorLockMode.Locked && !console.IsOpen)
            {
                float turn = (Input.GetKey(KeyCode.R) ? 1 : 0) - (Input.GetKey(KeyCode.Q) ? 1 : 0);
                transform.Rotate(0, Input.GetAxisRaw("Mouse X") * 1.7f + turn * 65 * Mathf.Min(Time.deltaTime, .05f), 0);
                pitch = Mathf.Clamp(pitch - Input.GetAxisRaw("Mouse Y") * 1.7f, -65, 65);
                eye.transform.localRotation = Quaternion.Euler(pitch, 0, 0);
                float horizontal = (Input.GetKey(KeyCode.D) || Input.GetKey(KeyCode.RightArrow) ? 1 : 0) -
                    (Input.GetKey(KeyCode.A) || Input.GetKey(KeyCode.LeftArrow) ? 1 : 0);
                float forward = (Input.GetKey(KeyCode.W) || Input.GetKey(KeyCode.UpArrow) ? 1 : 0) -
                    (Input.GetKey(KeyCode.S) || Input.GetKey(KeyCode.DownArrow) ? 1 : 0);
                var input = Vector2.ClampMagnitude(new Vector2(horizontal, forward), 1);
                gravity = body.isGrounded ? -2 : Mathf.Max(gravity - 20 * Time.deltaTime, -30);
                body.Move((transform.right * input.x * speed + transform.forward * input.y * speed + Vector3.up * gravity) * Mathf.Min(Time.deltaTime, .05f));
            }
            if (transform.position.y < -8) ResetView();
            if (Application.isFocused && Time.realtimeSinceStartup - sampleStarted > 5)
            {
                frames.Add(Time.unscaledDeltaTime * 1000);
                if (frames.Count >= 600)
                {
                    var ordered = frames.ToArray();
                    Array.Sort(ordered);
                    float total = 0; foreach (var value in ordered) total += value;
                    performanceText = $"{1000f / (total / ordered.Length):F0} FPS   P95 {ordered[(int)(ordered.Length * .95f)]:F1} ms   {Screen.width} × {Screen.height}";
                    frames.Clear();
                }
            }
        }

        private void OnGUI()
        {
            if (console == null || console.IsOpen) return;
            if (Cursor.lockState == CursorLockMode.Locked)
                GUI.Label(new Rect(Screen.width / 2 - 4, Screen.height / 2 - 10, 20, 20), "+");
            if (details && !string.IsNullOrEmpty(performanceText))
            {
                if (smallStyle == null) smallStyle = new GUIStyle(GUI.skin.label) { font = hudFont, fontSize = 11 };
                GUI.Label(new Rect(24, 115, 420, 24), performanceText, smallStyle);
            }
        }
    }
}
