import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Store } from "../../server/core/store.js";
export const uid = () => randomUUID();
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const ids = JSON.parse(
  readFileSync(
    new URL(
      "../../docs/engineering_v0.5/database/fixtures/ids.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  launchId: string;
  contentHash: string;
  contentVersionId: string;
  policyHash: string;
  sessions: Record<
    "s1" | "s2",
    {
      sessionId: string;
      runEpoch: string;
      actors: Record<string, string>;
      accounts: Record<string, string>;
    }
  >;
};
export const a = ids.sessions.s1,
  b = ids.sessions.s2;
export async function seed(store: Store) {
  // Each fixture statement occupies a complete line; JSON strings may contain
  // semicolons, so deliberately do not split this file at semicolons.
  const sql = readFileSync(
    new URL(
      "../../docs/engineering_v0.5/database/fixtures/reference_seed.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await store.transaction(async () => {
    for (const line of sql.split("\n"))
      if (/^(INSERT|UPDATE) /.test(line)) await store.run(line);
  });
}
export async function ledger(
  store: Store,
  account: string,
  kind = "spend",
  amount = 1,
  parent: string | null = null,
) {
  const row = await store.one(
    "SELECT * FROM quota_accounts WHERE session_id=? AND account_id=?",
    a.sessionId,
    account,
  );
  const [bucket, available, reserved, spent] =
    kind === "reserve"
      ? ["available", -amount, amount, 0]
      : kind === "release"
        ? ["reserved", amount, -amount, 0]
        : kind === "refund"
          ? ["spent", amount, 0, -amount]
          : parent
            ? ["reserved", 0, -amount, amount]
            : ["available", -amount, 0, amount];
  const entry = uid();
  await store.insert("quota_ledger", {
    session_id: a.sessionId,
    entry_id: entry,
    account_id: account,
    operation_id: uid(),
    entry_kind: kind,
    source_bucket: bucket,
    amount,
    delta_available: available,
    delta_reserved: reserved,
    delta_spent: spent,
    account_version_before: row.account_version,
    parent_entry_id: parent,
    reason_code: "STORAGE_TEST",
    mission_ms: 0,
    created_at_ms: 1000,
  });
  return entry;
}
export async function evidence(
  store: Store,
  which: "s1" | "s2" = "s1",
  revision = 1,
  instance = uid(),
) {
  const body = '{ "body": "synthetic", "number": 1 }';
  await store.insert("evidence_instances", {
    session_id: ids.sessions[which].sessionId,
    instance_id: instance,
    revision,
    scene_id: "E1",
    owner_role: "analyst",
    private_definition_id: "fixture",
    observation_type: "directObservation",
    acquired_mission_ms: 0,
    public_payload_json: body,
    payload_hash: hash(body),
  });
  return { instance, revision, body };
}
export async function reportAndUpload(store: Store) {
  const e = await evidence(store),
    reportId = uid(),
    uploadId = uid();
  await store.transaction(async () => {
    const charge = await ledger(store, a.accounts["E1:analyst:report"]!);
    await store.insert("reports", {
      session_id: a.sessionId,
      report_id: reportId,
      scene_id: "E1",
      sender_role: "analyst",
      source_instance_id: e.instance,
      source_revision: e.revision,
      actor_binding_id: a.actors.analyst,
      charge_entry_id: charge,
      reported_mission_ms: 0,
      immutable_payload_json: e.body,
      immutable_payload_hash: hash(e.body),
    });
    const uploadCharge = await ledger(
      store,
      a.accounts["E1:commander:upload"]!,
    );
    await store.insert("uploads", {
      session_id: a.sessionId,
      upload_id: uploadId,
      scene_id: "E1",
      report_id: reportId,
      report_revision: 1,
      charge_entry_id: uploadCharge,
      authorization_binding_id: a.actors.commander,
      uploaded_mission_ms: 0,
    });
  });
  return { ...e, reportId, uploadId };
}
export async function manifest(
  store: Store,
  uploads: string[] = [],
  scene = "E1",
) {
  const version = (
    await store.one(
      "SELECT COALESCE(MAX(context_version),0)+1 AS n FROM input_manifests WHERE session_id=?",
      a.sessionId,
    )
  ).n;
  const manifestId = uid(),
    input = JSON.stringify({ uploads, version }),
    inputHash = hash(input);
  await store.transaction(async () => {
    for (const uploadId of uploads)
      await store.insert("input_manifest_members", {
        session_id: a.sessionId,
        manifest_id: manifestId,
        upload_id: uploadId,
      });
    await store.insert("input_manifests", {
      session_id: a.sessionId,
      manifest_id: manifestId,
      scene_id: scene,
      inbox_version: uploads.length,
      context_version: version,
      context_epoch: uid(),
      background_hash: "b".repeat(64),
      input_hash: inputHash,
      permitted_input_json: input,
      created_at_ms: 1000,
    });
  });
  return { manifestId, inputHash, version, inboxVersion: uploads.length };
}
export async function advisor(store: Store) {
  const m = await manifest(store),
    jobId = uid();
  await store.insert("agent_jobs", {
    session_id: a.sessionId,
    job_id: jobId,
    agent_role: "advisor",
    scene_id: "E1",
    manifest_id: m.manifestId,
    status: "queued",
    mode: "live_model",
    input_hash: m.inputHash,
    config_hash: "c".repeat(64),
    input_version: m.version,
    inbox_version: m.inboxVersion,
    context_version: m.version,
    deadline_at_ms: 9000,
    created_at_ms: 1000,
    updated_at_ms: 1000,
  });
  return jobId;
}
export async function seal(store: Store, activate = true) {
  const sealId = uid(),
    sealedHash = hash(sealId);
  await store.transaction(async () => {
    const row = await store.one(
      "SELECT * FROM sessions WHERE session_id=?",
      a.sessionId,
    );
    const version = row.state_version + 1,
      sequence = row.last_event_seq + 1;
    await store.insert("events", {
      session_id: a.sessionId,
      seq: sequence,
      event_id: uid(),
      kind: "session.terminated",
      mission_ms: row.mission_ms,
      state_version: version,
      actor_kind: "rules",
      payload_json: "{}",
      recorded_at_ms: 1000,
    });
    await store.insert("terminal_seals", {
      session_id: a.sessionId,
      seal_id: sealId,
      sealed_hash: sealedHash,
      terminal_lifecycle: "abandoned",
      terminal_seq: sequence,
      terminal_state_version: version,
      terminal_mission_ms: row.mission_ms,
      outcome_json: '{"kind":"abandoned"}',
      immutable_behavior_json: '{"decisions":[]}',
      content_hash: row.content_hash,
      policy_hash: row.policy_hash,
      sealed_at_ms: 1000,
    });
    if (activate)
      await store.run(
        "UPDATE sessions SET lifecycle='abandoned',phase='terminal',terminal_seal_id=?,state_version=?,updated_at_ms=1000 WHERE session_id=?",
        sealId,
        version,
        a.sessionId,
      );
  });
  return sealedHash;
}
