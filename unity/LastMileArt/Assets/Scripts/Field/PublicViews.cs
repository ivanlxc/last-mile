using System;

namespace LastMile.Field
{
    // A consumer of the existing public v0.5 contract. Never import server world/case data.
    [Serializable] public sealed class Projection
    {
        public string sessionId, runEpoch, lifecycle, phase, sceneId, locale;
        public long stateVersion, missionTimeMs, assistantContextVersion, inboxVersion;
        public Report[] reports = Array.Empty<Report>();
        public Resource[] resources = Array.Empty<Resource>();
        public Quota[] reportQuotas = Array.Empty<Quota>();
        public Quota uploadQuota;
        public Upload[] sceneUploads = Array.Empty<Upload>();
        public TaskOption[] taskOptions = Array.Empty<TaskOption>();
        public ActionOption[] actionOptions = Array.Empty<ActionOption>();
        public AgentJob latestAdviceJob;
    }
    [Serializable] public sealed class Resource { public string channel; public int remaining, initial; }
    [Serializable] public sealed class Quota { public string role, sceneId; public int remaining, used, limit; }
    [Serializable] public sealed class Cost { public long? knownDurationMs; public string description, uncertainty; }
    [Serializable] public sealed class TaskOption
    {
        public string targetId, topicId, targetRole, label, investigationKind, resourceChannel, disabledReason;
        public bool available; public Cost cost;
    }
    [Serializable] public sealed class ActionOption
    {
        public string actionId, label, kind, knownRisk, irreversibleNotice;
        public bool available; public Cost cost;
    }
    [Serializable] public sealed class Card
    {
        public string title, body, sourceLabel, channel, observationScope, freshness, provenanceStatus;
        public string evidenceInstanceId; public int revision;
    }
    [Serializable] public sealed class Report
    {
        public string reportId, evidenceInstanceId, sourceRole, sceneId;
        public int revision; public Card card;
    }
    [Serializable] public sealed class Upload { public string reportId, evidenceInstanceId; public int revision; }
    [Serializable] public sealed class AgentJob
    {
        public string jobId, status, mode; public long inputVersion;
        public Advice result; public AgentError error;
    }
    [Serializable] public sealed class AgentError { public string code; }
    [Serializable] public sealed class Advice
    {
        public string summary, changeSummary;
        public Claim[] claims = Array.Empty<Claim>();
        public Recommendation recommendation;
        public string[] uncertainties = Array.Empty<string>();
        public Suggestion[] investigationSuggestions = Array.Empty<Suggestion>();
    }
    [Serializable] public sealed class Claim { public string kind, text; public Citation[] citations = Array.Empty<Citation>(); }
    [Serializable] public sealed class Citation { public string kind, refId; public int revision; }
    [Serializable] public sealed class Recommendation { public string actionId, rationale; public string[] conditions = Array.Empty<string>(); }
    [Serializable] public sealed class Suggestion { public string channel, publicTargetId, questionToResolve; }
}
