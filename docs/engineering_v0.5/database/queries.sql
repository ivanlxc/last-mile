-- Named read statements. Bind :session_id from the authenticated resource context.
-- Public API projections MUST explicitly select allowed fields; SELECT * is for internal coordinator only.

-- name: command_receipt
SELECT payload_hash,response_status,response_json,accepted_state_version
FROM commands WHERE session_id=:session_id AND request_id=:request_id;
-- end

-- name: creation_receipt
SELECT payload_hash,session_id,response_json FROM session_creations
WHERE launch_id=:launch_id AND request_id=:request_id;
-- end

-- name: coordinator_state
SELECT s.*,p.policy_json FROM sessions s JOIN policy_profiles p USING(policy_hash)
WHERE s.session_id=:session_id;
-- end

-- name: due_investigations
SELECT investigation_id,task_id,scene_id,role,option_id,due_mission_ms
FROM investigations WHERE session_id=:session_id AND status IN ('queued','running')
AND due_mission_ms<=:mission_ms ORDER BY due_mission_ms,investigation_id;
-- end

-- name: commander_report_cards
SELECT r.report_id,r.source_instance_id AS evidence_instance_id,r.source_revision AS revision,
 r.sender_role AS source_role,r.scene_id,r.reported_mission_ms,r.immutable_payload_json AS card_json,
 EXISTS(SELECT 1 FROM uploads u WHERE u.session_id=r.session_id AND u.scene_id=r.scene_id
 AND u.report_id=r.report_id AND u.report_revision=r.source_revision) AS uploaded
FROM reports r WHERE r.session_id=:session_id AND r.scene_id=:scene_id
ORDER BY r.reported_mission_ms,r.report_id;
-- end

-- name: npc_private_inventory
-- Internal NpcRoleController only; never mount as commander HTTP endpoint or Advisor tool.
SELECT e.instance_id,e.revision,e.observation_type,e.public_payload_json,e.acquired_mission_ms
FROM evidence_instances e WHERE e.session_id=:session_id AND e.scene_id=:scene_id AND e.owner_role=:role
AND NOT EXISTS(SELECT 1 FROM reports r WHERE r.session_id=e.session_id AND r.scene_id=e.scene_id
 AND r.source_instance_id=e.instance_id AND r.source_revision=e.revision)
ORDER BY e.acquired_mission_ms,e.instance_id,e.revision;
-- end

-- name: advisor_manifest_cards
-- Prompt builder reads only this membership plus approved map/location/background and authorized statements.
SELECT u.upload_id,r.report_id,r.source_revision,r.immutable_payload_json
FROM input_manifest_members m JOIN uploads u ON u.session_id=m.session_id AND u.upload_id=m.upload_id
JOIN reports r ON r.session_id=u.session_id AND r.report_id=u.report_id AND r.source_revision=u.report_revision
WHERE m.session_id=:session_id AND m.manifest_id=:manifest_id ORDER BY u.upload_id;
-- end

-- name: current_advisor_job
SELECT j.job_id,j.status,j.mode,j.input_version,j.input_hash,j.result_json,j.error_code
FROM sessions s JOIN agent_jobs j ON j.session_id=s.session_id AND j.scene_id=s.scene_id
AND j.context_version=s.assistant_context_version
WHERE s.session_id=:session_id AND j.agent_role='advisor' AND j.status NOT IN ('cancelled','superseded')
ORDER BY j.created_at_ms DESC LIMIT 1;
-- end

-- name: view_event_page
SELECT cursor,event_type,public_payload_json FROM view_events
WHERE session_id=:session_id AND view_role=:view_role AND cursor>:after_cursor
ORDER BY cursor LIMIT :page_size;
-- end

-- name: unfulfilled_reservations
SELECT p.entry_id AS parent_entry_id,p.account_id,
 p.amount-COALESCE(SUM(c.amount),0) AS remaining_amount
FROM quota_ledger p LEFT JOIN quota_ledger c ON c.session_id=p.session_id AND c.parent_entry_id=p.entry_id
WHERE p.session_id=:session_id AND p.entry_kind='reserve'
GROUP BY p.entry_id,p.account_id,p.amount HAVING p.amount>COALESCE(SUM(c.amount),0);
-- end

-- name: quota_reconciliation
-- Expected zero rows. Initial state is (capacity,0,0); every mutation must be represented by ledger.
SELECT q.session_id,q.account_id,q.available,q.reserved,q.spent,q.account_version
FROM quota_accounts q LEFT JOIN quota_ledger l ON l.session_id=q.session_id AND l.account_id=q.account_id
WHERE q.session_id=:session_id GROUP BY q.session_id,q.account_id
HAVING q.available!=q.capacity+COALESCE(SUM(l.delta_available),0)
OR q.reserved!=COALESCE(SUM(l.delta_reserved),0)
OR q.spent!=COALESCE(SUM(l.delta_spent),0)
OR q.account_version!=COUNT(l.entry_id);
-- end

-- name: unsettled_sessions_after_restart
SELECT session_id,run_epoch,state_version,mission_ms,last_event_seq
FROM sessions WHERE lifecycle IN ('briefing','running') ORDER BY created_at_ms;
-- end

-- name: unresolved_provider_attempts
SELECT a.session_id,a.job_id,a.attempt_no,a.request_key,a.sent_at_ms,j.agent_role,j.status AS job_status
FROM agent_attempts a JOIN agent_jobs j ON j.session_id=a.session_id AND j.job_id=a.job_id
WHERE a.status IN ('sending','running') ORDER BY a.sent_at_ms;
-- end

-- name: evaluator_fact_rows
-- Outcome is deliberately absent. Application validates the final EvaluatorInput allowlist.
SELECT f.fact_id,f.context_id,f.rule_id,f.subject_binding_id,f.cutoff_seq,f.cutoff_state_version,
 f.fact_payload_json,f.visible_refs_json FROM behavior_facts f
WHERE f.session_id=:session_id AND f.seal_hash=:sealed_hash ORDER BY f.context_id,f.rule_id,f.fact_id;
-- end

-- name: session_content_version
-- Public contentVersionId is this opaque registered UUID; never serialize content_hash instead.
SELECT c.content_version_id FROM sessions s JOIN content_versions c ON c.content_hash=s.content_hash
WHERE s.session_id=:session_id;
-- end
