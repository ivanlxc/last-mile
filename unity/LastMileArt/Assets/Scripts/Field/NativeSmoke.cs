using System;
using System.Linq;
using System.Threading.Tasks;
using UnityEngine;

namespace LastMile.Field
{
    // Opt-in development test, against a fresh disposable Node session. No live-model spend.
    public static class NativeSmoke
    {
        private static void Require(bool value, string message) { if (!value) throw new Exception("Native smoke: " + message); }
        public static async Task Run(FieldConsole field)
        {
            try
            {
                var api = field.Api;
                Require(!FieldConsole.ReceiptVisible(new Rect(0, 500, 400, 100), 0, 400), "offscreen content must not count as displayed");
                Require(!FieldConsole.ReceiptVisible(new Rect(0, 370, 400, 100), 0, 400), "only a clipped edge is not enough");
                Require(FieldConsole.ReceiptVisible(new Rect(0, 500, 400, 100), 350, 400), "scrolled into view can count");
                Require(!api.ModelConfigured, "smoke must use offline provider");
                Require(!FieldApi.ValidOrigin("https://example.com") && !FieldApi.ValidOrigin("http://127.0.0.1:3114/path") && !FieldApi.ValidOrigin("http://user@127.0.0.1:3114"), "connection scope");
                Require(api.State.sceneId == "E2", "start at market");
                int before = api.State.reportQuotas.Single(q => q.role == "analyst" && q.sceneId == "E2").remaining;
                try { await field.RequestBrief("analyst", "roads"); }
                catch (FieldFailure) {
                    Require(api.HasPending, "uncertain mutation must remain pending");
                    await api.RetryPending();
                    Require(!api.HasPending, "manual retry resolves pending command");
                    Debug.Log("LAST_MILE_NATIVE_PENDING_RECOVERED");
                }
                Require(api.State.reportQuotas.Single(q => q.role == "analyst" && q.sceneId == "E2").remaining == before - 1, "brief quota charged exactly once");
                var report = api.State.reports.Last(r => r.sceneId == "E2" && r.sourceRole == "analyst");
                Require(api.State.sceneUploads.Length == 0, "reading cannot upload");
                await api.Receipt("report_opened", report.reportId);
                int liaisonBefore = api.State.reportQuotas.Single(q => q.role == "liaison" && q.sceneId == "E2").remaining;
                api.State.stateVersion--; // Deliberately stale local view must fail without charging.
                bool conflict = false;
                try { await field.RequestBrief("liaison", "cause"); }
                catch (FieldFailure e) { conflict = e.Code == "STATE_VERSION_CONFLICT"; }
                Require(conflict && !api.HasPending, "conflict clears rejected command and refreshes");
                Require(api.State.reportQuotas.Single(q => q.role == "liaison" && q.sceneId == "E2").remaining == liaisonBefore, "conflict cannot deduct quota");
                await field.RequestBrief("liaison", "cause");
                var drone = api.State.taskOptions.First(t => t.resourceChannel == "drone" && t.available);
                int uses = api.State.resources.Single(r => r.channel == "drone").remaining;
                await field.Investigate(drone, null);
                Require(api.State.resources.Single(r => r.channel == "drone").remaining == uses - 1, "drone deduction");
                await field.Upload(report);
                Require(api.State.sceneUploads.Length == 1 && api.State.sceneUploads[0].reportId == report.reportId, "selected upload only");
                Require(api.State.uploadQuota.remaining == 4, "upload quota");
                await WaitForAdvisor(api);
                await field.Ask("compare_routes", null);
                await WaitForAdvisor(api);
                Require(api.State.latestAdviceJob?.result != null, "advisor output");
                Require(api.State.latestAdviceJob.mode == "offline_template", "honest model mode");
                await api.Receipt("advice_displayed", null, api.State.latestAdviceJob.jobId);
                var action = api.State.actionOptions.First(a => a.available && a.kind == "route");
                await field.Commit(action, "Native integration smoke: compare known costs and source limitations.", new[] { report.reportId }, api.State.latestAdviceJob.jobId);
                Require(api.State.sceneId == "E3", "route advances to bridge");
                Require(api.State.resources.Single(r => r.channel == "drone").remaining == uses - 1, "resource persists across chapters");
                Debug.Log("LAST_MILE_NATIVE_SMOKE_OK: bootstrap cookie, brief, receipt, investigation, upload, advisor, decision, shared budgets; locale=" + api.State.locale);
                Application.Quit(0);
            }
            catch (Exception e) { Debug.LogError("LAST_MILE_NATIVE_SMOKE_FAILED: " + e.Message); Application.Quit(2); }
        }
        private static async Task WaitForAdvisor(FieldApi api)
        {
            for (int i = 0; i < 40; i++)
            {
                if (api.State.latestAdviceJob?.status != "queued" && api.State.latestAdviceJob?.status != "running") return;
                await Task.Delay(250); await api.Refresh();
            }
            throw new Exception("Advisor did not settle within 10 seconds.");
        }
    }
}
