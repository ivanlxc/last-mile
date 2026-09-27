using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;

namespace LastMile.Art
{
    // Local art inspection only. No scenario, player save, model key or network access.
    [RequireComponent(typeof(CharacterController))]
    public sealed class ArtWalkthrough : MonoBehaviour
    {
        public Camera eye;
        public Vector3 home;
        public Vector3 lookAt;
        public float speed = 2.6f;
        private CharacterController body;
        private float pitch;
        private float gravity;
        private bool chinese;
        private bool details = true;
        private float sampleStarted;
        private readonly List<float> frames = new List<float>(1800);
        private string performanceText = "Warming up…";
        private Font hudFont;
        private GUIStyle titleStyle, smallStyle;

        private void Awake()
        {
            body = GetComponent<CharacterController>();
            QualitySettings.vSyncCount = 1;
            Application.targetFrameRate = 60;
            hudFont = Font.CreateDynamicFontFromOSFont(new[] { "PingFang SC", "Heiti SC", "Arial Unicode MS" }, 18);
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

        private void OnApplicationFocus(bool focus) { if (!focus) ReleaseMouse(); }
        private void OnDisable() { ReleaseMouse(); }
        private void OnDestroy() { if (hudFont != null) Destroy(hudFont); }

        private void Update()
        {
            if (Input.GetKeyDown(KeyCode.Escape)) ReleaseMouse();
            if (Input.GetKeyDown(KeyCode.L)) chinese = !chinese;
            if (Input.GetKeyDown(KeyCode.Tab)) details = !details;
            if (Input.GetKeyDown(KeyCode.Home)) ResetView();
            if (Input.GetKeyDown(KeyCode.P))
            {
                string path = Path.Combine(Application.persistentDataPath, "Market-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + ".png");
                ScreenCapture.CaptureScreenshot(path);
                Debug.Log("LAST_MILE_ART_CAPTURE: " + path);
            }
            if (Input.GetMouseButtonDown(0) && Input.mousePosition.y < Screen.height - 115)
            {
                Cursor.lockState = CursorLockMode.Locked;
                Cursor.visible = false;
            }
            if (Cursor.lockState == CursorLockMode.Locked)
            {
                transform.Rotate(0, Input.GetAxisRaw("Mouse X") * 1.7f, 0);
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
            if (Time.realtimeSinceStartup - sampleStarted > 5)
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
            float scale = Mathf.Max(1, Screen.height / 900f);
            GUI.matrix = Matrix4x4.Scale(new Vector3(scale, scale, 1));
            float width = Screen.width / scale;
            if (titleStyle == null)
            {
                titleStyle = new GUIStyle(GUI.skin.label) { font = hudFont, fontSize = 22, fontStyle = FontStyle.Bold };
                smallStyle = new GUIStyle(GUI.skin.label) { font = hudFont, fontSize = 13, wordWrap = true };
            }
            GUI.Box(new Rect(20, 20, width - 40, details ? 125 : 65), GUIContent.none);
            GUI.Label(new Rect(38, 29, width - 90, 32), chinese ? "LAST MILE / 市集美术样板" : "LAST MILE / MARKET ART STUDY", titleStyle);
            GUI.Label(new Rect(38, 66, width - 90, 25), performanceText, smallStyle);
            if (details)
            {
                GUI.Label(new Rect(38, 91, width - 90, 45), chinese
                    ? "点击画面进入 · WASD / 方向键移动 · Esc 释放鼠标 · Home 复位 · Tab 隐藏说明 · L 切换语言 · P 截图\n这是独立美术与移动样板，尚未连接剧情、调查或 AI。"
                    : "Click scene to enter · WASD / arrows to walk · Esc release · Home reset · Tab details · L language · P screenshot\nStandalone art and movement study. Story, investigations and AI are not connected yet.", smallStyle);
            }
            if (Cursor.lockState == CursorLockMode.Locked)
                GUI.Label(new Rect(width / 2 - 4, Screen.height / scale / 2 - 10, 20, 20), "+");
        }
    }
}
