using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using UnityEngine;
using LastMile.Art;

namespace LastMile.Field
{
    // Presentation of public projections only. Geometry is atmosphere, never evidence.
    public sealed class FieldConsole : MonoBehaviour
    {
        public readonly FieldApi Api = new FieldApi();
        public bool IsOpen => page != "";
        public bool Chinese => Api.State?.locale == "zh-CN" || (Api.State == null && chinese);
        public bool Connected => Api.State != null;
        private ArtWalkthrough walk;
        private string page = "welcome", error = "", note = "", question = "", reason = "", source = "";
        private string origin = "http://127.0.0.1:3114", session = "";
        private string previousPage = "intel";
        private bool busy, chinese, adviceBasis;
        private float nextPoll, displayedAt;
        private string displayedKey;
        private readonly HashSet<string> seen = new HashSet<string>();
        private readonly HashSet<string> decisionRefs = new HashSet<string>();
        private Report selectedReport;
        private TaskOption selectedTask;
        private ActionOption selectedAction;
        private Vector2 scroll;
        private int keyboardIndex, buttonIndex, buttonCount;
        private bool keyboardActivate, keyboardNavigating, clearFocus, scrollToSelection;
        private Rect selectionRect;
        private float scrollViewportHeight;
        private Font font;
        private GUIStyle text, muted, heading, title, button, field, eyebrow;
        private readonly Color accent = new Color(.89f, .69f, .39f);
        private readonly Vector3[] stations = { new Vector3(-3.2f, 1.4f, -5), new Vector3(3.3f, 1.4f, 2), new Vector3(-3.6f, 1.4f, 9), new Vector3(4.6f, 1.4f, -10) };
        private readonly string[] stationPages = { "noah", "samira", "recon", "command" };
        private Projection S => Api.State;
        private bool CanAct => S != null && S.lifecycle == "active" && S.phase == "scene" && S.sceneId == "E2" && !busy && !Api.HasPending;
        private string T(string en, string zh) => Chinese ? zh : en;
        private string Name(string id) => id == "noah" ? T("NOAH / INTELLIGENCE", "NOAH / 情报联络") : id == "samira" ? T("SAMIRA / LIAISON", "SAMIRA / 民事联络") : id == "recon" ? T("RECONNAISSANCE", "侦察调度") : id == "command" ? T("ROUTE DECISION", "路线决策") : id == "advisor" ? T("AI ADVISOR", "AI 顾问") : id == "intel" ? T("EVIDENCE ARCHIVE", "情报档案") : T("FIELD TERMINAL", "现场终端");
        private static string Argument(string key)
        {
            var args = Environment.GetCommandLineArgs(); int i = Array.IndexOf(args, key);
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : "";
        }
        private void Start()
        {
            walk = GetComponent<ArtWalkthrough>(); font = Resources.Load<Font>("Fonts/NotoSansCJKsc-Regular");
            session = Argument("--last-mile-session"); var host = Argument("--last-mile-server"); if (host != "") origin = host;
            if (session != "") Run(async () => {
                await Api.Connect(origin, session); chinese = S.locale == "zh-CN";
                if (Environment.GetCommandLineArgs().Contains("--last-mile-smoke")) await NativeSmoke.Run(this);
            });
        }
        public void Open(string next)
        {
            page = next; scroll = Vector2.zero; error = ""; displayedKey = null;
            keyboardIndex = 0; keyboardNavigating = false; clearFocus = true;
            Cursor.lockState = CursorLockMode.None; Cursor.visible = true;
        }
        private void Close() { page = ""; selectedTask = null; selectedAction = null; displayedKey = null; }
        public async Task Refresh() { await Api.Refresh(); nextPoll = Time.unscaledTime + 5; }
        private async void Run(Func<Task> work)
        {
            if (busy) return; busy = true; error = "";
            try { await work(); }
            catch (Exception e) { error = e is FieldFailure f ? f.Code + " · " + f.Message : T("Connection interrupted. Refresh and try again.", "连接中断，请刷新后重试。"); }
            finally { busy = false; nextPoll = Time.unscaledTime + (error == "" ? 5 : 15); }
        }
        private int Nearby()
        {
            int closest = -1; float best = 2.5f;
            for (int i = 0; i < stations.Length; i++) {
                var d = stations[i] - transform.position; d.y = 0;
                if (d.magnitude < best) { closest = i; best = d.magnitude; }
            }
            return closest;
        }
        private void Update()
        {
            if (Connected && S.sceneId == "E2") {
                var keys = new[] { KeyCode.F1, KeyCode.F2, KeyCode.F3, KeyCode.F4, KeyCode.F5, KeyCode.F6 };
                var pages = new[] { "noah", "samira", "recon", "intel", "advisor", "command" };
                for (int i = 0; i < keys.Length; i++) if (Input.GetKeyDown(keys[i])) Open(pages[i]);
            }
            if (Input.GetKeyDown(KeyCode.Tab)) { if (IsOpen) Close(); else Open(Connected ? "intel" : "welcome"); }
            if (Input.GetKeyDown(KeyCode.Escape) && IsOpen) Close();
            if (Input.GetKeyDown(KeyCode.E) && !IsOpen && Nearby() >= 0) Open(stationPages[Nearby()]);
            if (Input.GetKeyDown(KeyCode.L) && !Connected) chinese = !chinese;
            if (!Application.isFocused || busy || !Connected) return;
            if (Api.HasPending) return;
            // Receipt only after the opened content has really been painted and remained visible.
            string key = page == "report" && selectedReport != null ? "r:" + selectedReport.reportId :
                page == "advisor" && S.latestAdviceJob?.result != null ? "a:" + S.latestAdviceJob.jobId : null;
            if (key != null && key == displayedKey && Time.unscaledTime - displayedAt > 1 && !seen.Contains(key))
            {
                Run(async () => { await Api.Receipt(key.StartsWith("r:") ? "report_opened" : "advice_displayed", key.StartsWith("r:") ? key.Substring(2) : null, key.StartsWith("a:") ? key.Substring(2) : null); seen.Add(key); });
                return;
            }
            if (Time.unscaledTime >= nextPoll)
                Run(Refresh);
        }
        private void OnApplicationFocus(bool focused) { displayedKey = null; }
        private void OnDestroy() { Api.Dispose(); }
        private void Styles()
        {
            if (text != null) return;
            text = new GUIStyle(GUI.skin.label) { font = font, fontSize = 14, wordWrap = true, richText = false, padding = new RectOffset(0, 0, 0, 0), margin = new RectOffset(0, 0, 4, 6) };
            text.normal.textColor = new Color(.90f, .91f, .86f);
            muted = new GUIStyle(text) { fontSize = 12 }; muted.normal.textColor = new Color(.61f, .70f, .68f);
            heading = new GUIStyle(text) { fontSize = 23, fontStyle = FontStyle.Bold };
            title = new GUIStyle(heading) { fontSize = 27 };
            eyebrow = new GUIStyle(muted) { fontSize = 11 }; eyebrow.normal.textColor = accent;
            button = new GUIStyle(GUI.skin.button) { font = font, fontSize = 13, wordWrap = true, richText = false, alignment = TextAnchor.MiddleLeft, padding = new RectOffset(14, 14, 10, 10), margin = new RectOffset(0, 0, 4, 4) };
            button.normal.background = Solid(new Color(.13f, .20f, .18f)); button.normal.textColor = text.normal.textColor;
            button.hover.background = Solid(new Color(.22f, .30f, .25f)); button.hover.textColor = Color.white;
            button.active.background = Solid(new Color(.34f, .31f, .22f)); button.active.textColor = Color.white;
            field = new GUIStyle(GUI.skin.textArea) { font = font, fontSize = 14, wordWrap = true, richText = false, padding = new RectOffset(10, 10, 8, 8) };
        }
        private static Texture2D Solid(Color color)
        {
            var texture = new Texture2D(1, 1); texture.SetPixel(0, 0, color.linear); texture.Apply(); return texture;
        }
        private void Label(string value, GUIStyle style = null) { if (!string.IsNullOrEmpty(value)) GUILayout.Label(value, style ?? text); }
        private bool Button(string label, bool enabled = true)
        {
            int index = buttonIndex++;
            bool before = GUI.enabled; GUI.enabled = before && enabled && !busy;
            bool selected = keyboardNavigating && index == keyboardIndex;
            var content = new GUIContent((selected ? ">  " : "") + label);
            bool clicked = GUILayout.Button(content, button, GUILayout.Height(Mathf.Max(42, button.CalcHeight(content, 580))));
            if (selected && Event.current.type == EventType.Repaint) selectionRect = GUILayoutUtility.GetLastRect();
            if (keyboardActivate && index == keyboardIndex && GUI.enabled) { clicked = true; keyboardActivate = false; }
            GUI.enabled = before; return clicked;
        }
        private void Rule()
        {
            var r = GUILayoutUtility.GetRect(1, 1, GUILayout.ExpandWidth(true)); Fill(r, new Color(.26f, .33f, .31f)); GUILayout.Space(12);
        }
        private static void Fill(Rect rect, Color color) { var old = GUI.color; GUI.color = color.linear; GUI.DrawTexture(rect, Texture2D.whiteTexture); GUI.color = old; }
        private string Duration(Cost cost) => cost?.knownDurationMs == null ? T("Duration uncertain", "耗时不确定") : T($"{cost.knownDurationMs / 1000} s simulated time", $"模拟时间 {cost.knownDurationMs / 1000} 秒");
        private string Channel(string value)
        {
            switch (value) { case "satellite": return T("Satellite", "卫星"); case "drone": return T("Drone", "无人机"); case "localAgency": return T("Local agency", "当地机构"); case "witness": return T("Witness", "目击者"); default: return value; }
        }
        private string StatusLabel(string code)
        {
            switch (code) {
                case "current": return T("Current", "当前信息");
                case "historical": return T("Historical", "历史信息");
                case "superseded": return T("Superseded", "已有更新版本");
                case "unknown": return T("Age unknown", "时效未知");
                case "unverified": return T("Unverified", "尚未核实");
                case "partially_verified": return T("Partially verified", "部分核实");
                case "verified": return T("Verified", "已核实");
                case "no_resource": return T("Channel allowance exhausted", "渠道额度已用尽");
                case "no_report_slot": return T("Report allowance exhausted", "上报额度已用尽");
                case "role_busy": return T("Contact is busy", "该岗位正在执行任务");
                case "phase_locked": return T("Unavailable in this phase", "当前阶段不可用");
                default: return code;
            }
        }
        private int Balance(string channel) => S?.resources.FirstOrDefault(r => r.channel == channel)?.remaining ?? 0;
        private void OnGUI()
        {
            if (clearFocus) { GUI.FocusControl(null); clearFocus = false; }
            buttonIndex = 0;
            var ev = Event.current;
            if (IsOpen && ev.type == EventType.KeyDown && string.IsNullOrEmpty(GUI.GetNameOfFocusedControl())) {
                if (ev.keyCode == KeyCode.DownArrow || ev.keyCode == KeyCode.UpArrow) {
                    keyboardIndex = Mathf.Clamp(keyboardIndex + (ev.keyCode == KeyCode.DownArrow ? 1 : -1), 0, Mathf.Max(0, buttonCount - 1));
                    keyboardNavigating = true; scrollToSelection = true; ev.Use();
                } else if (ev.keyCode == KeyCode.Return || ev.keyCode == KeyCode.KeypadEnter) {
                    keyboardActivate = true; ev.Use();
                }
            }
            Styles(); float scale = Mathf.Max(.75f, Mathf.Min(Screen.width / 1280f, Screen.height / 720f));
            GUI.matrix = Matrix4x4.Scale(Vector3.one * scale);
            float width = Screen.width / scale, height = Screen.height / scale;
            Fill(new Rect(20, 20, width - 40, 92), new Color(.045f, .085f, .075f, .94f));
            Fill(new Rect(20, 20, 3, 92), accent);
            GUI.Label(new Rect(40, 29, 430, 20), "LAST MILE   /   FIELD OPERATIONS", eyebrow);
            GUI.Label(new Rect(40, 49, 510, 44), T("02  /  THE MARKET", "02  /  市集"), title);
            GUI.Label(new Rect(42, 87, 660, 20), T("20 civilians · Investigate the conflicting accounts. Choose a route.", "护送 20 名平民 · 核查相互冲突的消息，再决定路线。"), muted);
            GUI.Label(new Rect(width - 378, 36, 330, 24), Connected ? (S.latestAdviceJob?.mode == "live_model" ? "LIVE MODEL" : S.latestAdviceJob?.mode == "offline_template" ? "OFFLINE TEMPLATE" : Api.ModelConfigured ? "MODEL CONFIGURED" : "OFFLINE TEMPLATE") : "ART / DISCONNECTED", eyebrow);
            GUI.Label(new Rect(width - 378, 65, 330, 38), Connected ? T($"Mission time {S.missionTimeMs / 1000}s · {S.sceneId} · v{S.stateVersion}", $"模拟时间 {S.missionTimeMs / 1000} 秒 · {S.sceneId} · v{S.stateVersion}") : T("Start the local playtest to connect.", "启动本机试玩服务以连接剧情。"), muted);
            if (!IsOpen)
            {
                for (int i = 0; i < stations.Length; i++)
                {
                    var p = walk.eye.WorldToScreenPoint(stations[i]); if (p.z < 0) continue;
                    float x = p.x / scale, y = height - p.y / scale;
                    if (x < 30 || x > width - 30 || y < 126 || y > height - 105) continue;
                    Fill(new Rect(x - 13, y - 13, 26, 26), new Color(.08f, .14f, .13f, .90f));
                    GUI.Label(new Rect(x - 8, y - 12, 34, 26), (i + 1).ToString("00"), eyebrow);
                    if (i == Nearby()) GUI.Label(new Rect(x - 140, y + 18, 330, 48), "[E]  " + Name(stationPages[i]), text);
                }
                Fill(new Rect(20, height - 83, width - 40, 63), new Color(.045f, .085f, .075f, .94f));
                GUI.Label(new Rect(40, height - 74, width - 80, 26), T("Enter / click to walk   ·   WASD move   ·   Q/R turn   ·   E interact   ·   Tab field tablet   ·   Esc release", "Enter / 点击进入 · WASD 移动 · Q/R 转向 · E 交互 · Tab 终端 · Esc 释放鼠标"), text);
                GUI.Label(new Rect(40, height - 46, width - 80, 20), T("Reading and walking do not advance mission time. Scenery alone is not evidence.", "阅读与步行不会推进模拟时间。场景外观本身不构成证据。"), muted);
                return;
            }
            float panelWidth = 680, xPanel = width - panelWidth - 20;
            var panel = new Rect(xPanel, 128, panelWidth, height - 148);
            Fill(panel, new Color(.045f, .075f, .069f, .98f));
            GUILayout.BeginArea(new Rect(panel.x + 22, panel.y + 15, panel.width - 44, panel.height - 28));
            GUILayout.BeginHorizontal(); Label(page == "welcome" ? T("FIELD BRIEFING", "现场简报") : Name(page), heading);
            if (GUILayout.Button("×", button, GUILayout.Width(44), GUILayout.Height(44))) Close(); GUILayout.EndHorizontal();
            if (Connected && S.sceneId == "E2")
            {
                GUILayout.BeginHorizontal();
                foreach (var id in new[] { "noah", "samira", "recon", "intel", "advisor", "command" })
                    if (GUILayout.Button(id == "noah" ? "F1 Noah" : id == "samira" ? "F2 Samira" : id == "recon" ? T("F3 Recon", "F3 调查") : id == "intel" ? T("F4 Intel", "F4 情报") : id == "advisor" ? "F5 AI" : T("F6 Route", "F6 路线"), button)) Open(id);
                GUILayout.EndHorizontal();
            }
            if (busy) Label(T("Synchronizing with mission control…", "正在与任务指挥系统同步…"), eyebrow);
            if (error != "") Label(error, text);
            if (Api.HasPending && Button(T("Retry original request — same transaction", "重试原请求（沿用同一事务）"))) Run(async () => { await Api.RetryPending(); });
            scroll = GUILayout.BeginScrollView(scroll);
            if (Connected && S.sceneId != "E2") Transition();
            else if (page == "welcome" || !Connected) Welcome();
            else if (page == "noah" || page == "samira") Briefing(page == "noah" ? "analyst" : "liaison");
            else if (page == "recon") Recon();
            else if (page == "investigate") Investigation();
            else if (page == "intel") Archive();
            else if (page == "report") ReportDetails();
            else if (page == "advisor") Advisor();
            else if (page == "command") Actions();
            else if (page == "confirm") Decision();
            GUILayout.EndScrollView();
            if (Event.current.type == EventType.Repaint) scrollViewportHeight = GUILayoutUtility.GetLastRect().height;
            if (scrollToSelection && Event.current.type == EventType.Repaint) {
                float viewHeight = GUILayoutUtility.GetLastRect().height;
                if (selectionRect.y < scroll.y) scroll.y = selectionRect.y;
                else if (selectionRect.yMax > scroll.y + viewHeight) scroll.y = selectionRect.yMax - viewHeight;
                scrollToSelection = false;
            }
            Label(T("↑ / ↓ select · Enter activate · F1–F6 stations · Tab close · F12 screenshot", "↑ / ↓ 选择 · Enter 确认 · F1–F6 页面 · Tab 关闭 · F12 截图"), muted);
            buttonCount = buttonIndex; keyboardActivate = false;
            GUILayout.EndArea();
        }
        private void Welcome()
        {
            Label(T("A loud report. Two accounts. One convoy.", "一声巨响，两种说法，一支车队。"), heading);
            Label(T("The convoy has reached the market. Noah is sorting imagery; Samira is contacting local sources. Their briefings can help you decide what deserves a closer look.", "车队已抵达市集。Noah 正在整理图像，Samira 正在联系当地消息来源。先听取简报，再决定哪些疑问值得进一步调查。"));
            Rule();
            Label(T("Satellite 2  ·  Drone 3  ·  Agency 3  ·  Witness 2", "卫星 2 次 · 无人机 3 次 · 当地机构 3 次 · 目击者 2 次"), eyebrow);
            Label(T("Allowances are shared across the entire mission. Each role may report 3 times in this chapter; the AI inbox accepts 5 uploads. Traces and corrections use new slots.", "调查额度整局共享。每个岗位本关最多上报 3 次，AI 最多接收 5 次上传。溯源与更正同样消耗新的额度。"));
            Label(T("Development slice: the west-gate prelude was completed by the launcher. This temporary run is not a player assessment. Closing the launcher discards it.", "开发试玩：启动器已完成西门序章。本次临时试玩不用于玩家能力评价，关闭启动器即清除。"), muted);
            if (Connected)
            {
                if (Button(T("Enter the market", "进入市集"))) Close();
                if (Button(T("Contact Noah", "联系 Noah"))) Open("noah");
            }
            else
            {
                Label(T("Launch from the repository: pnpm play:native", "在项目目录启动：pnpm play:native"), eyebrow);
                Label(T("Or connect to an existing local native playtest:", "或连接已有的本机试玩："), muted);
                GUI.SetNextControlName("origin"); origin = GUILayout.TextField(origin, 160, field); GUI.SetNextControlName("session"); session = GUILayout.TextField(session, 36, field);
                if (Button(T("Connect", "连接"), session.Length == 36)) Run(() => Api.Connect(origin, session));
                if (Button(T("Inspect the artwork", "先浏览美术场景"))) Close();
            }
        }
        private void Briefing(string role)
        {
            var q = S.reportQuotas.FirstOrDefault(v => v.role == role && v.sceneId == S.sceneId);
            Label(T(role == "analyst" ? "Noah / imagery and route analysis" : "Samira / local contacts", role == "analyst" ? "Noah / 图像与道路分析" : "Samira / 当地消息联络"), heading);
            Label(T("Choose a question for your radio contact. A new briefing uses one report slot; reopening it is free.", "通过电台向队员提出问题。领取一条简报占用一次上报额度；再次阅读不重复扣费。"));
            Label(T($"Reports remaining: {q?.remaining ?? 0} / 3", $"剩余上报：{q?.remaining ?? 0} / 3"), eyebrow);
            if (Button(T("Request route briefing · 1 report", "调取道路简报 · 1 次上报"), CanAct && q?.remaining > 0)) Run(() => RequestBrief(role, "roads"));
            if (Button(T("Ask about the loud report · 1 report", "询问巨响原因 · 1 次上报"), CanAct && q?.remaining > 0)) Run(() => RequestBrief(role, "cause"));
            Rule();
            foreach (var report in S.reports.Where(r => r.sceneId == "E2" && r.sourceRole == role))
                if (Button(report.card.title)) OpenReport(report, page);
        }
        public async Task RequestBrief(string role, string topic)
        {
            var result = await Api.Command("/tasks", new JObject { ["taskKind"] = "request_report", ["targetRole"] = role, ["topicId"] = topic });
            var id = (string)result["task"]?["reportId"];
            var report = S.reports.FirstOrDefault(r => r.reportId == id);
            if (report != null) OpenReport(report, role == "analyst" ? "noah" : "samira");
        }
        private void Recon()
        {
            Label(T("Spend a channel use to resolve a specific uncertainty.", "选择一条调查渠道，解决具体疑问。"));
            foreach (var resource in S.resources) Label($"{Channel(resource.channel)}   {resource.remaining} / {resource.initial}", eyebrow);
            Rule();
            foreach (var option in S.taskOptions)
            {
                bool trace = option.investigationKind == "provenance_trace";
                if (Button(option.label + "\n" + Channel(option.resourceChannel) + " · " + Duration(option.cost) + (option.available || trace ? "" : " · " + StatusLabel(option.disabledReason)), CanAct && (option.available || option.disabledReason == "needs_report_reference")))
                { selectedTask = option; source = ""; Open("investigate"); }
            }
        }
        private void Investigation()
        {
            if (selectedTask == null) return;
            Label(selectedTask.label, heading); Label(selectedTask.cost.description);
            Label(Duration(selectedTask.cost) + " · " + T($"1 {Channel(selectedTask.resourceChannel)} use + 1 report", $"1 次{Channel(selectedTask.resourceChannel)} + 1 次上报"), eyebrow);
            Label(T($"Channel remaining: {Balance(selectedTask.resourceChannel)}. This cannot be refunded by closing the window after confirmation.", $"本渠道剩余 {Balance(selectedTask.resourceChannel)} 次。确认后关闭窗口不会退回额度。"));
            bool trace = selectedTask.investigationKind == "provenance_trace";
            if (trace)
            {
                Label(T("Choose the report to trace:", "选择要溯源的报告："));
                foreach (var r in S.reports.Where(r => r.sceneId == S.sceneId && r.sourceRole == selectedTask.targetRole))
                    if (Button((source == r.reportId ? "✓  " : "") + r.card.title)) source = r.reportId;
            }
            Label(T("Imagery can show activity; it does not prove motive. Source checking can reveal shared origins; repetition alone is not independent confirmation.", "图像能反映活动，不能证明动机。溯源可揭示消息是否同源；重复转述不等于独立验证。"), muted);
            if (Button(T("Confirm investigation", "确认调查"), CanAct && (!trace || source != ""))) Run(() => Investigate(selectedTask, trace ? source : null));
            if (Button(T("Back · spend nothing", "返回 · 不消耗额度"))) Open("recon");
        }
        public async Task Investigate(TaskOption task, string sourceReport)
        {
            var result = await Api.Command("/tasks", new JObject {
                ["taskKind"] = "investigate_and_report", ["targetRole"] = task.targetRole, ["topicId"] = task.topicId,
                ["targetId"] = task.targetId, ["investigationKind"] = task.investigationKind, ["sourceReportId"] = sourceReport, ["reasonAnnotation"] = null
            });
            var r = S.reports.FirstOrDefault(v => v.reportId == (string)result["task"]?["reportId"]);
            if (r != null) OpenReport(r, "recon"); else Open("recon");
        }
        private void Archive()
        {
            Label(T("Received reports are separate from the AI inbox.", "已收到的报告与 AI 收件箱相互独立。"));
            foreach (var r in S.reports.Where(r => r.sceneId == "E2"))
                if (Button(r.card.title + "\n" + r.card.sourceLabel + (Uploaded(r) ? T(" · Uploaded", " · 已上传") : T(" · Not uploaded", " · 未上传")))) OpenReport(r, "intel");
        }
        public void OpenReport(Report r, string back = "intel") { selectedReport = r; previousPage = back; Open("report"); }
        private bool Uploaded(Report r) => S.sceneUploads.Any(u => u.reportId == r.reportId && u.revision == r.revision);
        private void MarkPainted(string key)
        {
            if (Event.current.type != EventType.Repaint) return;
            if (!Application.isFocused) { displayedKey = null; return; }
            if (!ReceiptVisible(GUILayoutUtility.GetLastRect(), scroll.y, scrollViewportHeight)) { displayedKey = null; return; }
            if (displayedKey != key) { displayedKey = key; displayedAt = Time.unscaledTime; }
        }
        internal static bool ReceiptVisible(Rect content, float scrollY, float viewportHeight)
        {
            if (viewportHeight <= 0 || content.height <= 0) return false;
            float visible = Mathf.Min(content.yMax, scrollY + viewportHeight) - Mathf.Max(content.y, scrollY);
            return visible >= Mathf.Min(content.height, viewportHeight) * .55f;
        }
        private void ReportDetails()
        {
            if (selectedReport == null) return;
            var r = selectedReport; Label(r.card.sourceLabel + " / " + StatusLabel(r.card.freshness), eyebrow);
            Label(r.card.title, heading); Label(r.card.body); MarkPainted("r:" + r.reportId);
            Rule(); Label(T("OBSERVATION SCOPE", "观察范围"), eyebrow); Label(r.card.observationScope);
            Label(T("Source verification: ", "来源核验：") + StatusLabel(r.card.provenanceStatus), muted);
            Label(T("Reading does not upload this report. Uploads preserve this revision and consume a slot.", "阅读不会自动上传。上传会固定当前版本，并占用一次上传额度。"), muted);
            if (Button(Uploaded(r) ? T("Already in AI inbox", "已在 AI 收件箱") : T($"Upload to AI · {S.uploadQuota?.remaining ?? 0} slots left", $"上传给 AI · 剩余 {S.uploadQuota?.remaining ?? 0} 次"), CanAct && !Uploaded(r) && S.uploadQuota?.remaining > 0)) Run(() => Upload(r));
            if (Button(T("Back to reports", "返回报告列表"))) Open(previousPage);
        }
        public async Task Upload(Report r)
        {
            await Api.Command("/uploads", new JObject { ["items"] = new JArray(new JObject { ["reportId"] = r.reportId, ["expectedRevision"] = r.revision }) });
            note = T("Report uploaded. The advisor can now use this revision.", "报告已上传，顾问现在可以读取此版本。"); Open("advisor");
        }
        private void Advisor()
        {
            Label(T($"AI inbox: {S.sceneUploads.Length} / 5 reports", $"AI 收件箱：{S.sceneUploads.Length} / 5 条报告"), eyebrow);
            Label(T("Only uploaded reports, permitted background and your statements enter the advisor context. Statements are treated as unverified.", "顾问只能读取已上传报告、允许的背景资料和你提供的陈述。你的陈述会标记为未经核实。"), muted);
            foreach (var u in S.sceneUploads)
            {
                var r = S.reports.FirstOrDefault(v => v.reportId == u.reportId);
                if (r != null && Button("↗ " + r.card.title)) OpenReport(r, "advisor");
            }
            if (note != "") Label(note, eyebrow);
            var job = S.latestAdviceJob;
            bool running = job?.status == "queued" || job?.status == "running";
            if (running) Label(T("Analysis in progress. You may keep investigating.", "正在分析，你仍可以继续调查。"));
            if (job?.error != null && job.error.code != "MODEL_NOT_CONFIGURED") Label(T("Model status: ", "模型状态：") + job.error.code, muted);
            if (job?.mode == "offline_template") Label(T("OFFLINE TEMPLATE — structured fallback, no live model response.", "离线模板 — 结构化降级结果，本次没有真实模型回复。"), eyebrow);
            if (job?.result != null)
            {
                if (job.inputVersion != S.assistantContextVersion || job.status == "superseded" || job.status == "cancelled")
                    Label(T("Earlier context — this analysis may be outdated.", "旧上下文结果 — 这份分析可能已过时。"), eyebrow);
                Label(job.result.summary, heading); MarkPainted("a:" + job.jobId);
                Label(job.result.recommendation?.rationale);
                foreach (var c in job.result.recommendation?.conditions ?? Array.Empty<string>()) Label("• " + c);
                foreach (var claim in job.result.claims)
                {
                    Label(claim.text);
                    foreach (var citation in claim.citations)
                    {
                        var r = S.reports.FirstOrDefault(v => v.evidenceInstanceId == citation.refId && v.revision == citation.revision);
                        if (citation.kind == "evidence" && r != null && S.sceneUploads.Any(u => u.evidenceInstanceId == citation.refId && u.revision == citation.revision))
                        { if (Button("↗ " + r.card.title)) OpenReport(r, "advisor"); }
                        else Label(T("Reference: ", "引用：") + citation.kind + " / " + citation.refId, muted);
                    }
                }
                Label(T("UNCERTAINTIES", "仍未确认"), eyebrow);
                foreach (var u in job.result.uncertainties) Label("• " + u);
            }
            Rule();
            if (Button(T("Compare the available routes", "比较可选路线"), CanAct && !running)) Run(() => Ask("compare_routes", null));
            if (Button(T("What information would change your assessment?", "什么信息会改变你的判断？"), CanAct && !running)) Run(() => Ask("next_information", null));
            GUI.SetNextControlName("question"); question = GUILayout.TextArea(question, field, GUILayout.Height(75)); if (question.Length > 1600) question = question.Substring(0, 1600);
            if (Button(T("Send question", "发送问题"), CanAct && !running && question.Trim().Length > 0)) Run(async () => { await Ask("free_text", question.Trim()); question = ""; });
        }
        public async Task Ask(string kind, string value)
        {
            await Api.Command("/questions", new JObject { ["questionKind"] = kind, ["text"] = value, ["expectedInboxVersion"] = S.inboxVersion, ["uploadBatch"] = new JArray() });
        }
        private void Actions()
        {
            Label(T("The decision is yours. Review the known costs and leave a reason before committing.", "最后的决定由你作出。请先查看已知代价，并记录决策理由。"));
            foreach (var a in S.actionOptions)
            {
                if (a.kind != "route") continue;
                if (Button(a.label + "\n" + Duration(a.cost), CanAct && a.available)) { selectedAction = a; reason = ""; adviceBasis = false; decisionRefs.Clear(); Open("confirm"); }
            }
        }
        private void Decision()
        {
            if (selectedAction == null) return;
            Label(selectedAction.label, heading); Label(Duration(selectedAction.cost), eyebrow);
            Label(selectedAction.cost.description); Label(selectedAction.knownRisk); Label(selectedAction.irreversibleNotice);
            Rule(); Label(T("Your reason (required)", "你的决策理由（必填）"), eyebrow);
            GUI.SetNextControlName("reason"); reason = GUILayout.TextArea(reason, field, GUILayout.Height(84)); if (reason.Length > 1200) reason = reason.Substring(0, 1200);
            Label(T("Which reports did you rely on? (Optional)", "你依据了哪些报告？（可选）"), muted);
            foreach (var r in S.reports.Where(r => r.sceneId == "E2"))
                if (Button((decisionRefs.Contains(r.reportId) ? "✓  " : "○  ") + r.card.title)) { if (!decisionRefs.Remove(r.reportId)) decisionRefs.Add(r.reportId); }
            var job = S.latestAdviceJob;
            if (job?.result != null && seen.Contains("a:" + job.jobId))
                if (Button((adviceBasis ? "✓  " : "○  ") + T("I used the displayed AI analysis", "我参考了已阅读的 AI 分析"))) adviceBasis = !adviceBasis;
            if (Button(T("Commit route decision", "确认路线决策"), CanAct && reason.Trim().Length > 0)) Run(async () => {
                await Commit(selectedAction, reason.Trim(), decisionRefs.ToArray(), adviceBasis ? job?.jobId : null); Open("transition");
            });
            if (Button(T("Return without committing", "返回，不提交"))) Open("command");
        }
        public async Task Commit(ActionOption action, string why, string[] refs, string advice)
        {
            await Api.Command("/actions", new JObject { ["actionId"] = action.actionId, ["waitDurationMs"] = null,
                ["reason"] = why, ["reasonAnnotation"] = null, ["basedOnAdviceJobId"] = advice,
                ["referencedReportIds"] = new JArray(refs), ["cancelPendingInvestigations"] = false });
        }
        private void Transition()
        {
            Label(T("Convoy moving onward", "车队继续前进"), heading);
            Label(T("Your route decision was recorded by the game engine. The next chapter is available in the browser; its native environment is the next production step.", "路线决策已由游戏引擎记录。下一关可在浏览器中继续，其原生场景将接着制作。"));
            foreach (var r in S.resources) Label($"{Channel(r.channel)}   {r.remaining} / {r.initial}", eyebrow);
            Label(T("This is the same temporary mission, with the same evidence and remaining resources. Keep the launcher running.", "这是同一局临时任务，证据与剩余额度会继续保留。请保持启动器运行。"), muted);
            if (Button(T("Continue the same mission in browser", "在浏览器继续同一局"))) Application.OpenURL(Api.Origin + "/?session=" + Uri.EscapeDataString(S.sessionId) + "&field=1");
        }
    }
}
