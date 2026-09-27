using System;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine.Networking;

namespace LastMile.Field
{
    public sealed class FieldFailure : Exception
    {
        public readonly string Code;
        public FieldFailure(string code, string detail) : base(detail) { Code = code; }
    }

    // This milestone intentionally accepts loopback only. It does not extend cloud auth.
    public sealed class FieldApi : IDisposable
    {
        public string Origin { get; private set; }
        public string SessionId { get; private set; }
        public Projection State { get; private set; }
        public bool ModelConfigured { get; private set; }
        public bool HasPending => pending != null;
        private Pending pending;
        private UnityWebRequest active;
        private bool disposed;
        private sealed class Pending { public string path, body, epoch, key; }
        public static bool ValidOrigin(string value)
        {
            return Uri.TryCreate(value, UriKind.Absolute, out var u) && u.Scheme == "http" &&
                u.Host == "127.0.0.1" && u.Port >= 1024 && u.AbsolutePath == "/" &&
                string.IsNullOrEmpty(u.UserInfo + u.Query + u.Fragment);
        }
        public async Task Connect(string origin, string session)
        {
            if (!ValidOrigin(origin) || !Guid.TryParse(session, out _))
                throw new FieldFailure("INVALID_CONNECTION", "Use a loopback preview address and the session provided by the launcher.");
            if (pending != null) throw new FieldFailure("PENDING_COMMAND", "Retry the unresolved command before changing sessions.");
            Origin = origin.TrimEnd('/'); SessionId = session;
            var bootstrap = await Request("/bootstrap");
            if ((string)bootstrap["contractVersion"] != "0.5")
                throw new FieldFailure("CONTRACT_MISMATCH", "This client requires public contract v0.5.");
            var health = await Request("/health"); ModelConfigured = (bool?)health["modelConfigured"] == true;
            await Refresh();
        }
        private string SessionPath(string tail = "") => "/sessions/" + Uri.EscapeDataString(SessionId) + tail;
        public async Task Refresh()
        {
            var next = (await Request(SessionPath())).ToObject<Projection>();
            if (next == null || next.sessionId != SessionId || string.IsNullOrEmpty(next.runEpoch))
                throw new FieldFailure("INVALID_PROJECTION", "The server returned an incompatible session.");
            if (State == null || next.runEpoch != State.runEpoch || next.stateVersion >= State.stateVersion) State = next;
        }
        public async Task<JObject> Command(string tail, JObject payload)
        {
            if (pending != null) throw new FieldFailure("PENDING_COMMAND", "Retry the unresolved command first.");
            if (State == null || State.lifecycle != "active" || State.sceneId != "E2" || State.phase != "scene")
                throw new FieldFailure("SCENE_CONFLICT", "This native slice accepts market actions only.");
            pending = new Pending { path = SessionPath(tail), epoch = State.runEpoch,
                key = Guid.NewGuid().ToString(), body = new JObject {
                    ["expectedStateVersion"] = State.stateVersion, ["expectedSceneId"] = State.sceneId, ["payload"] = payload
                }.ToString(Formatting.None) };
            return await RetryPending();
        }
        public async Task<JObject> RetryPending()
        {
            if (pending == null) return null;
            JObject result;
            try
            {
                result = await Request(pending.path, pending);
                pending = null;
            }
            catch (FieldFailure e)
            {
                // Transport and server failures can hide a successful commit. Preserve exact bytes/key.
                if (e.Code != "TRANSPORT" && e.Code != "SERVER_UNAVAILABLE") pending = null;
                if (e.Code.EndsWith("CONFLICT", StringComparison.Ordinal)) await Refresh();
                throw;
            }
            await Refresh();
            return result;
        }
        public async Task Receipt(string kind, string reportId = null, string jobId = null)
        {
            if (State == null || State.lifecycle != "active" || pending != null) return;
            var receipt = new Pending { path = SessionPath("/display-receipts"), epoch = State.runEpoch,
                key = Guid.NewGuid().ToString(), body = new JObject {
                    ["observedStateVersion"] = State.stateVersion, ["observedSceneId"] = State.sceneId,
                    ["payload"] = new JObject { ["displayKind"] = kind, ["reportId"] = reportId, ["jobId"] = jobId, ["operationId"] = null }
                }.ToString(Formatting.None) };
            await Request(receipt.path, receipt);
        }
        private async Task<JObject> Request(string path, Pending post = null)
        {
            if (disposed) throw new ObjectDisposedException(nameof(FieldApi));
            if (active != null) throw new InvalidOperationException("Serialize native HTTP requests.");
            // No credentials on redirects, no raw response/header logging, bounded network timeout.
            for (int attempt = 0; attempt < 2; attempt++)
            {
                using (var request = new UnityWebRequest(Origin + "/api/v1" + path, post == null ? "GET" : "POST"))
                {
                    active = request;
                    try
                    {
                        request.downloadHandler = new DownloadHandlerBuffer(); request.timeout = 20; request.redirectLimit = 0;
                        request.SetRequestHeader("Accept", "application/json");
                        request.SetRequestHeader("Accept-Language", State?.locale ?? "en-US");
                        if (post != null)
                        {
                            request.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(post.body));
                            request.SetRequestHeader("Content-Type", "application/json");
                            request.SetRequestHeader("Idempotency-Key", post.key);
                            request.SetRequestHeader("X-Run-Epoch", post.epoch);
                        }
                        var operation = request.SendWebRequest();
                        while (!operation.isDone) await Task.Yield();
                        if (disposed) throw new ObjectDisposedException(nameof(FieldApi));
                        bool uncertain = request.responseCode == 0 || request.responseCode >= 500;
                        if (uncertain && attempt == 0) { await Task.Delay(350); continue; }
                        if (uncertain) throw new FieldFailure(request.responseCode == 0 ? "TRANSPORT" : "SERVER_UNAVAILABLE", "Connection unavailable. Retry to reconcile the original request.");
                        JObject json;
                        try { json = JObject.Parse(request.downloadHandler.text); }
                        catch { throw new FieldFailure("SERVER_UNAVAILABLE", "The server returned an unreadable response."); }
                        if (request.responseCode < 200 || request.responseCode >= 300)
                            throw new FieldFailure((string)json["code"] ?? "HTTP_ERROR", (string)json["detail"] ?? "The request was rejected.");
                        return json;
                    }
                    finally { active = null; }
                }
            }
            throw new FieldFailure("TRANSPORT", "Request did not complete.");
        }
        public void Dispose() { disposed = true; active?.Abort(); }
    }
}
