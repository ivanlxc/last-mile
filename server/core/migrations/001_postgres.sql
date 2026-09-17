-- LAST MILE PostgreSQL baseline, translated from the frozen SQLite v0.5 DDL.
-- Source SHA-256: 51b5235a93b3b8c8ee3ac29c68f059d1ee94dafc717188f25179434bd3e3333d
-- Reproduce: python3 tests/storage/generate-postgres.py
-- 35 baseline tables, 117 original triggers. Runtime/cloud tables are migration 002.
-- Applied in one transaction by createStore while holding the engine lease.
-- All foreign keys are added after table creation to support circular references;
-- the original DEFERRABLE INITIALLY DEFERRED clauses remain unchanged.

-- JSON remains TEXT: canonical bytes, hashes and immutable comparisons are preserved.
CREATE FUNCTION lm_json_valid(value TEXT) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF value IS NULL THEN RETURN FALSE; END IF;
  PERFORM value::json;
  RETURN TRUE;
EXCEPTION WHEN invalid_text_representation THEN RETURN FALSE;
END;
$$;
CREATE FUNCTION lm_json_type(value TEXT) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE kind TEXT;
BEGIN
  kind := json_typeof(value::json);
  IF kind='string' THEN RETURN 'text'; END IF;
  IF kind='number' THEN
    IF value ~ '^\s*-?[0-9]+\s*$' THEN RETURN 'integer'; END IF;
    RETURN 'real';
  END IF;
  RETURN kind;
END;
$$;


CREATE TABLE schema_migrations (
  version BIGINT PRIMARY KEY CHECK(version > 0),
  name TEXT NOT NULL UNIQUE,
  applied_at_ms BIGINT NOT NULL CHECK(applied_at_ms >= 0)
);

CREATE TABLE content_versions (
  content_version_id TEXT NOT NULL UNIQUE CHECK(length(content_version_id)=36),
  content_hash TEXT PRIMARY KEY CHECK(length(content_hash)=64 AND content_hash !~ '[^0-9a-f]'),
  schema_version TEXT NOT NULL,
  registry_json TEXT NOT NULL CHECK(lm_json_valid(registry_json) AND lm_json_type(registry_json)='object'),
  created_at_ms BIGINT NOT NULL CHECK(created_at_ms>=0)
);

CREATE TABLE policy_profiles (
  policy_hash TEXT PRIMARY KEY CHECK(length(policy_hash)=64 AND policy_hash !~ '[^0-9a-f]'),
  profile_id TEXT NOT NULL,
  profile_version BIGINT NOT NULL CHECK(profile_version>0),
  approval_status TEXT NOT NULL CHECK(approval_status IN ('review','approved','retired')),
  policy_json TEXT NOT NULL CHECK(lm_json_valid(policy_json) AND lm_json_type(policy_json)='object'),
  created_at_ms BIGINT NOT NULL CHECK(created_at_ms>=0),
  UNIQUE(profile_id,profile_version)
);

CREATE TABLE launches (
  launch_id TEXT PRIMARY KEY CHECK(length(launch_id)=36),
  token_hash TEXT NOT NULL CHECK(length(token_hash)=64),
  started_at_ms BIGINT NOT NULL CHECK(started_at_ms>=0),
  ended_at_ms BIGINT CHECK(ended_at_ms>=started_at_ms)
);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY CHECK(length(session_id)=36),
  run_epoch TEXT NOT NULL CHECK(length(run_epoch)=36),
  launch_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('normal','demo','test')),
  lifecycle TEXT NOT NULL DEFAULT 'briefing' CHECK(lifecycle IN ('briefing','running','completed','abandoned','interrupted')),
  phase TEXT NOT NULL DEFAULT 'briefing' CHECK(phase IN ('briefing','decision','coordinating','travelling','resolving','terminal')),
  scene_id TEXT,
  content_hash TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  private_case_id TEXT NOT NULL,
  state_version BIGINT NOT NULL DEFAULT 0 CHECK(state_version>=0),
  inbox_version BIGINT NOT NULL DEFAULT 0 CHECK(inbox_version>=0),
  assistant_context_version BIGINT NOT NULL DEFAULT 0 CHECK(assistant_context_version>=0),
  last_event_seq BIGINT NOT NULL DEFAULT 0 CHECK(last_event_seq>=0),
  mission_ms BIGINT NOT NULL DEFAULT 0 CHECK(mission_ms>=0),
  anchor_monotonic_ms BIGINT,
  world_state_json TEXT NOT NULL DEFAULT '{}' CHECK(lm_json_valid(world_state_json) AND lm_json_type(world_state_json)='object'),
  terminal_seal_id TEXT,
  created_at_ms BIGINT NOT NULL CHECK(created_at_ms>=0),
  updated_at_ms BIGINT NOT NULL CHECK(updated_at_ms>=created_at_ms),
  UNIQUE(session_id,run_epoch),
  UNIQUE(session_id,terminal_seal_id),
  CHECK((lifecycle IN ('completed','abandoned','interrupted')) = (terminal_seal_id IS NOT NULL)),
  CHECK((lifecycle IN ('completed','abandoned','interrupted')) = (phase='terminal'))
);

CREATE TABLE session_scenes (
  session_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  ordinal BIGINT NOT NULL CHECK(ordinal>0),
  entered_mission_ms BIGINT CHECK(entered_mission_ms>=0),
  closed_mission_ms BIGINT CHECK(closed_mission_ms>=entered_mission_ms),
  PRIMARY KEY(session_id,scene_id),
  UNIQUE(session_id,ordinal)
);

CREATE TABLE actor_bindings (
  session_id TEXT NOT NULL,
  binding_id TEXT NOT NULL CHECK(length(binding_id)=36),
  role TEXT NOT NULL CHECK(role IN ('commander','analyst','liaison')),
  controller_kind TEXT NOT NULL CHECK(controller_kind IN ('human','npc')),
  created_at_ms BIGINT NOT NULL CHECK(created_at_ms>=0),
  PRIMARY KEY(session_id,binding_id),
  UNIQUE(session_id,role)
);

CREATE TABLE launch_session_access (
  launch_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK(capability IN ('commander.read','commander.command','evaluation.request','export.request')),
  granted_at_ms BIGINT NOT NULL CHECK(granted_at_ms>=0),
  PRIMARY KEY(launch_id,session_id,capability)
);

CREATE TABLE session_creations (
  launch_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK(length(request_id)=36),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
  session_id TEXT NOT NULL UNIQUE,
  response_json TEXT NOT NULL CHECK(lm_json_valid(response_json) AND lm_json_type(response_json)='object'),
  created_at_ms BIGINT NOT NULL CHECK(created_at_ms>=0),
  PRIMARY KEY(launch_id,request_id)
);

CREATE TABLE commands (
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK(length(request_id)=36),
  run_epoch TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  command_kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
  accepted_state_version BIGINT NOT NULL CHECK(accepted_state_version>=0),
  response_status BIGINT NOT NULL CHECK(response_status IN (200,201,202,204)),
  response_json TEXT NOT NULL CHECK(lm_json_valid(response_json)),
  accepted_at_ms BIGINT NOT NULL CHECK(accepted_at_ms>=0),
  PRIMARY KEY(session_id,request_id)
);

CREATE TABLE events (
  session_id TEXT NOT NULL,
  seq BIGINT NOT NULL CHECK(seq>0),
  event_id TEXT NOT NULL CHECK(length(event_id)=36),
  kind TEXT NOT NULL,
  mission_ms BIGINT NOT NULL CHECK(mission_ms>=0),
  state_version BIGINT NOT NULL CHECK(state_version>=0),
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','npc','rules','system')),
  binding_id TEXT,
  request_id TEXT CHECK(request_id IS NULL OR length(request_id)=36),
  causation_id TEXT,
  payload_json TEXT NOT NULL CHECK(lm_json_valid(payload_json) AND lm_json_type(payload_json)='object'),
  recorded_at_ms BIGINT NOT NULL CHECK(recorded_at_ms>=0),
  PRIMARY KEY(session_id,seq),
  UNIQUE(session_id,event_id)
);

CREATE TABLE view_events (
  session_id TEXT NOT NULL,
  view_role TEXT NOT NULL CHECK(view_role IN ('commander','analyst','liaison')),
  cursor BIGINT NOT NULL CHECK(cursor>0),
  source_seq BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  public_payload_json TEXT NOT NULL CHECK(lm_json_valid(public_payload_json) AND lm_json_type(public_payload_json)='object'),
  PRIMARY KEY(session_id,view_role,cursor)
);

CREATE TABLE quota_accounts (
  session_id TEXT NOT NULL,
  account_id TEXT NOT NULL CHECK(length(account_id)=36),
  quota_scope TEXT NOT NULL CHECK(quota_scope IN ('session','scene')),
  scene_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('analyst','liaison','commander')),
  resource TEXT NOT NULL CHECK(resource IN ('satellite','drone','localAgency','witness','report','upload')),
  capacity BIGINT NOT NULL CHECK(capacity>=0),
  available BIGINT NOT NULL CHECK(available>=0),
  reserved BIGINT NOT NULL DEFAULT 0 CHECK(reserved>=0),
  spent BIGINT NOT NULL DEFAULT 0 CHECK(spent>=0),
  account_version BIGINT NOT NULL DEFAULT 0 CHECK(account_version>=0),
  last_entry_id TEXT,
  PRIMARY KEY(session_id,account_id),
  CHECK(available+reserved+spent=capacity),
  CHECK((quota_scope='session' AND scene_id IS NULL AND resource IN ('satellite','drone','localAgency','witness')) OR (quota_scope='scene' AND scene_id IS NOT NULL AND resource IN ('report','upload'))),
  CHECK((resource IN ('satellite','drone') AND role='analyst') OR (resource IN ('localAgency','witness') AND role='liaison') OR (resource='report' AND role IN ('analyst','liaison')) OR (resource='upload' AND role='commander')),
  CHECK((resource='satellite' AND capacity=2) OR (resource='drone' AND capacity=3) OR (resource='localAgency' AND capacity=3) OR (resource='witness' AND capacity=2) OR resource IN ('report','upload'))
);

CREATE TABLE quota_ledger (
  session_id TEXT NOT NULL,
  entry_id TEXT NOT NULL CHECK(length(entry_id)=36),
  account_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK(length(operation_id)=36),
  entry_kind TEXT NOT NULL CHECK(entry_kind IN ('reserve','spend','release','refund')),
  source_bucket TEXT NOT NULL CHECK(source_bucket IN ('available','reserved','spent')),
  amount BIGINT NOT NULL CHECK(amount>0),
  delta_available BIGINT NOT NULL,
  delta_reserved BIGINT NOT NULL,
  delta_spent BIGINT NOT NULL,
  account_version_before BIGINT NOT NULL CHECK(account_version_before>=0),
  parent_entry_id TEXT,
  reason_code TEXT NOT NULL,
  mission_ms BIGINT NOT NULL CHECK(mission_ms>=0),
  created_at_ms BIGINT NOT NULL CHECK(created_at_ms>=0),
  PRIMARY KEY(session_id,entry_id),
  UNIQUE(session_id,operation_id,account_id,entry_kind,source_bucket),
  CHECK((entry_kind='reserve' AND source_bucket='available' AND parent_entry_id IS NULL AND delta_available=-amount AND delta_reserved=amount AND delta_spent=0)
     OR (entry_kind='spend' AND source_bucket='available' AND parent_entry_id IS NULL AND delta_available=-amount AND delta_reserved=0 AND delta_spent=amount)
     OR (entry_kind='spend' AND source_bucket='reserved' AND parent_entry_id IS NOT NULL AND delta_available=0 AND delta_reserved=-amount AND delta_spent=amount)
     OR (entry_kind='release' AND source_bucket='reserved' AND parent_entry_id IS NOT NULL AND delta_available=amount AND delta_reserved=-amount AND delta_spent=0)
     OR (entry_kind='refund' AND source_bucket='spent' AND parent_entry_id IS NOT NULL AND delta_available=amount AND delta_reserved=0 AND delta_spent=-amount))
);

CREATE TABLE task_requests (
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL CHECK(length(task_id)=36),
  scene_id TEXT NOT NULL,
  commander_binding_id TEXT NOT NULL,
  target_role TEXT NOT NULL CHECK(target_role IN ('analyst','liaison')),
  task_kind TEXT NOT NULL CHECK(task_kind IN ('investigate_and_report','request_report')),
  topic_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  option_id TEXT,
  status TEXT NOT NULL DEFAULT 'accepted' CHECK(status IN ('accepted','running','completed','cancelled','failed')),
  report_reservation_id TEXT NOT NULL,
  accepted_mission_ms BIGINT NOT NULL CHECK(accepted_mission_ms>=0),
  due_mission_ms BIGINT NOT NULL CHECK(due_mission_ms>=accepted_mission_ms),
  created_at_ms BIGINT NOT NULL CHECK(created_at_ms>=0),
  completed_at_ms BIGINT CHECK(completed_at_ms>=created_at_ms),
  failure_code TEXT,
  PRIMARY KEY(session_id,task_id),
  UNIQUE(session_id,report_reservation_id),
  CHECK((status IN ('completed','cancelled','failed'))=(completed_at_ms IS NOT NULL)),
  CHECK(task_kind!='investigate_and_report' OR option_id IS NOT NULL)
);

CREATE TABLE investigations (
  session_id TEXT NOT NULL,
  investigation_id TEXT NOT NULL CHECK(length(investigation_id)=36),
  task_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('analyst','liaison')),
  option_id TEXT NOT NULL,
  resource_key TEXT NOT NULL CHECK(resource_key IN ('satellite','drone','localAgency','witness')),
  resource_charge_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('queued','running','completed','cancelled','failed')),
  accepted_mission_ms BIGINT NOT NULL CHECK(accepted_mission_ms>=0),
  due_mission_ms BIGINT NOT NULL CHECK(due_mission_ms>=accepted_mission_ms),
  finished_mission_ms BIGINT CHECK(finished_mission_ms>=accepted_mission_ms),
  failure_code TEXT,
  PRIMARY KEY(session_id,investigation_id),
  UNIQUE(session_id,task_id),
  UNIQUE(session_id,resource_charge_id),
  CHECK((status IN ('completed','cancelled','failed'))=(finished_mission_ms IS NOT NULL))
);

CREATE TABLE operations (
  session_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK(length(operation_id)=36),
  scene_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK(operation_kind IN ('action','wait')),
  action_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted' CHECK(status IN ('accepted','running','completed','cancelled','failed')),
  private_plan_json TEXT NOT NULL CHECK(lm_json_valid(private_plan_json) AND lm_json_type(private_plan_json)='object'),
  public_progress_json TEXT NOT NULL CHECK(lm_json_valid(public_progress_json) AND lm_json_type(public_progress_json)='object'),
  accepted_mission_ms BIGINT NOT NULL CHECK(accepted_mission_ms>=0),
  due_mission_ms BIGINT NOT NULL CHECK(due_mission_ms>=accepted_mission_ms),
  created_at_ms BIGINT NOT NULL CHECK(created_at_ms>=0),
  completed_at_ms BIGINT CHECK(completed_at_ms>=created_at_ms),
  PRIMARY KEY(session_id,operation_id),
  CHECK((status IN ('completed','cancelled','failed'))=(completed_at_ms IS NOT NULL))
);

CREATE TABLE evidence_instances (
  session_id TEXT NOT NULL,
  instance_id TEXT NOT NULL CHECK(length(instance_id)=36),
  revision BIGINT NOT NULL CHECK(revision>0),
  scene_id TEXT NOT NULL,
  owner_role TEXT NOT NULL CHECK(owner_role IN ('analyst','liaison')),
  private_definition_id TEXT NOT NULL,
  observation_type TEXT NOT NULL CHECK(observation_type IN ('directObservation','reportedStatement','provenanceFinding','historicalRecord')),
  acquired_mission_ms BIGINT NOT NULL CHECK(acquired_mission_ms>=0),
  observed_mission_ms BIGINT,
  acquisition_investigation_id TEXT,
  supersedes_instance_id TEXT,
  supersedes_revision BIGINT,
  public_payload_json TEXT NOT NULL CHECK(lm_json_valid(public_payload_json) AND lm_json_type(public_payload_json)='object'),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
  PRIMARY KEY(session_id,instance_id,revision),
  CHECK((supersedes_instance_id IS NULL)=(supersedes_revision IS NULL)),
  CHECK(supersedes_instance_id IS NULL OR supersedes_instance_id!=instance_id OR supersedes_revision<revision)
);

CREATE TABLE provenance_disclosures (
  session_id TEXT NOT NULL,
  finding_id TEXT NOT NULL CHECK(length(finding_id)=36),
  evidence_instance_id TEXT NOT NULL,
  evidence_revision BIGINT NOT NULL,
  subject_instance_id TEXT NOT NULL,
  subject_revision BIGINT NOT NULL,
  relation_type TEXT NOT NULL CHECK(relation_type IN ('sourceIdentityChecked','firstHandOrHearsay','sharedRootConfirmed','contentCorroborated')),
  verification_state TEXT NOT NULL CHECK(verification_state IN ('unknown','reported','hypothesized','verified')),
  public_relation_json TEXT NOT NULL CHECK(lm_json_valid(public_relation_json) AND lm_json_type(public_relation_json)='object'),
  PRIMARY KEY(session_id,finding_id)
);

CREATE TABLE reports (
  session_id TEXT NOT NULL,
  report_id TEXT NOT NULL CHECK(length(report_id)=36),
  scene_id TEXT NOT NULL,
  sender_role TEXT NOT NULL CHECK(sender_role IN ('analyst','liaison')),
  source_instance_id TEXT NOT NULL,
  source_revision BIGINT NOT NULL,
  actor_binding_id TEXT NOT NULL,
  task_id TEXT,
  charge_entry_id TEXT NOT NULL,
  reported_mission_ms BIGINT NOT NULL CHECK(reported_mission_ms>=0),
  immutable_payload_json TEXT NOT NULL CHECK(lm_json_valid(immutable_payload_json) AND lm_json_type(immutable_payload_json)='object'),
  immutable_payload_hash TEXT NOT NULL CHECK(length(immutable_payload_hash)=64),
  PRIMARY KEY(session_id,report_id),
  UNIQUE(session_id,scene_id,source_instance_id,source_revision),
  UNIQUE(session_id,report_id,source_revision),
  UNIQUE(session_id,task_id)
);

CREATE TABLE uploads (
  session_id TEXT NOT NULL,
  upload_id TEXT NOT NULL CHECK(length(upload_id)=36),
  scene_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  report_revision BIGINT NOT NULL,
  charge_entry_id TEXT NOT NULL,
  authorization_binding_id TEXT NOT NULL,
  uploaded_mission_ms BIGINT NOT NULL CHECK(uploaded_mission_ms>=0),
  PRIMARY KEY(session_id,upload_id),
  UNIQUE(session_id,scene_id,report_id,report_revision)
);

CREATE TABLE input_manifests (
  session_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL CHECK(length(manifest_id)=36),
  scene_id TEXT NOT NULL,
  inbox_version BIGINT NOT NULL CHECK(inbox_version>=0),
  context_version BIGINT NOT NULL CHECK(context_version>=0),
  context_epoch TEXT NOT NULL CHECK(length(context_epoch)=36),
  background_hash TEXT NOT NULL CHECK(length(background_hash)=64),
  input_hash TEXT NOT NULL CHECK(length(input_hash)=64),
  permitted_input_json TEXT NOT NULL CHECK(lm_json_valid(permitted_input_json) AND lm_json_type(permitted_input_json)='object'),
  created_at_ms BIGINT NOT NULL CHECK(created_at_ms>=0),
  PRIMARY KEY(session_id,manifest_id),
  UNIQUE(session_id,scene_id,context_version)
);

CREATE TABLE input_manifest_members (
  session_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  PRIMARY KEY(session_id,manifest_id,upload_id)
);

CREATE TABLE player_statements (
  session_id TEXT NOT NULL,
  statement_id TEXT NOT NULL CHECK(length(statement_id)=36),
  scene_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  statement_text TEXT NOT NULL CHECK(length(statement_text) BETWEEN 1 AND 2000),
  trust TEXT NOT NULL DEFAULT 'unverified' CHECK(trust='unverified'),
  created_mission_ms BIGINT NOT NULL CHECK(created_mission_ms>=0),
  PRIMARY KEY(session_id,statement_id)
);

CREATE TABLE manifest_statements (
  session_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  PRIMARY KEY(session_id,manifest_id,statement_id)
);

CREATE TABLE agent_jobs (
  session_id TEXT NOT NULL,
  job_id TEXT NOT NULL CHECK(length(job_id)=36),
  agent_role TEXT NOT NULL CHECK(agent_role IN ('advisor','evaluator')),
  scene_id TEXT,
  manifest_id TEXT,
  seal_hash TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','fallback','failed','cancelled','superseded')),
  mode TEXT NOT NULL CHECK(mode IN ('live_model','offline_template')),
  input_hash TEXT NOT NULL CHECK(length(input_hash)=64),
  config_hash TEXT NOT NULL CHECK(length(config_hash)=64),
  input_version BIGINT NOT NULL CHECK(input_version>=1),
  inbox_version BIGINT,
  context_version BIGINT,
  evaluator_input_json TEXT CHECK(evaluator_input_json IS NULL OR (lm_json_valid(evaluator_input_json) AND lm_json_type(evaluator_input_json)='object')),
  max_attempts BIGINT NOT NULL DEFAULT 2 CHECK(max_attempts BETWEEN 1 AND 2),
  deadline_at_ms BIGINT NOT NULL CHECK(deadline_at_ms>=0),
  result_json TEXT CHECK(result_json IS NULL OR lm_json_valid(result_json)),
  error_code TEXT,
  created_at_ms BIGINT NOT NULL CHECK(created_at_ms>=0),
  updated_at_ms BIGINT NOT NULL CHECK(updated_at_ms>=created_at_ms),
  PRIMARY KEY(session_id,job_id),
  CHECK((agent_role='advisor' AND scene_id IS NOT NULL AND manifest_id IS NOT NULL AND seal_hash IS NULL AND inbox_version IS NOT NULL AND context_version IS NOT NULL AND evaluator_input_json IS NULL)
     OR (agent_role='evaluator' AND scene_id IS NULL AND manifest_id IS NULL AND seal_hash IS NOT NULL AND inbox_version IS NULL AND context_version IS NULL AND evaluator_input_json IS NOT NULL)),
  CHECK(status NOT IN ('succeeded','fallback') OR result_json IS NOT NULL)
);

CREATE TABLE agent_attempts (
  session_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt_no BIGINT NOT NULL CHECK(attempt_no>0),
  request_key TEXT NOT NULL CHECK(length(request_key)=36),
  status TEXT NOT NULL DEFAULT 'sending' CHECK(status IN ('sending','running','succeeded','failed','timeout','unknown')),
  sent_at_ms BIGINT NOT NULL CHECK(sent_at_ms>=0),
  finished_at_ms BIGINT CHECK(finished_at_ms>=sent_at_ms),
  provider_request_id TEXT,
  input_tokens BIGINT CHECK(input_tokens>=0),
  output_tokens BIGINT CHECK(output_tokens>=0),
  billed_microunits BIGINT CHECK(billed_microunits>=0),
  error_code TEXT,
  response_hash TEXT CHECK(response_hash IS NULL OR length(response_hash)=64),
  PRIMARY KEY(session_id,job_id,attempt_no),
  UNIQUE(request_key),
  CHECK((status IN ('succeeded','failed','timeout','unknown'))=(finished_at_ms IS NOT NULL))
);

CREATE TABLE public_records (
  session_id TEXT NOT NULL,
  public_record_id TEXT NOT NULL CHECK(length(public_record_id)=36),
  revision BIGINT NOT NULL CHECK(revision>0),
  view_role TEXT NOT NULL CHECK(view_role IN ('commander','analyst','liaison','all')),
  record_kind TEXT NOT NULL CHECK(record_kind IN ('report','advice','briefing','sceneFeedback')),
  source_seq BIGINT NOT NULL,
  public_payload_json TEXT NOT NULL CHECK(lm_json_valid(public_payload_json) AND lm_json_type(public_payload_json)='object'),
  PRIMARY KEY(session_id,public_record_id,revision)
);

CREATE TABLE display_receipts (
  session_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL CHECK(length(receipt_id)=36),
  binding_id TEXT NOT NULL,
  public_record_id TEXT NOT NULL,
  record_revision BIGINT NOT NULL,
  receipt_kind TEXT NOT NULL CHECK(receipt_kind IN ('displayed','opened','usedInReason')),
  recorded_mission_ms BIGINT NOT NULL CHECK(recorded_mission_ms>=0),
  received_at_ms BIGINT NOT NULL CHECK(received_at_ms>=0),
  PRIMARY KEY(session_id,receipt_id),
  UNIQUE(session_id,binding_id,public_record_id,record_revision,receipt_kind)
);

CREATE TABLE decision_snapshots (
  session_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL CHECK(length(snapshot_id)=36),
  scene_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  snapshot_kind TEXT NOT NULL CHECK(snapshot_kind IN ('task','investigation','report','upload','action')),
  source_seq BIGINT NOT NULL,
  mission_ms BIGINT NOT NULL CHECK(mission_ms>=0),
  state_version BIGINT NOT NULL CHECK(state_version>=0),
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
  snapshot_json TEXT NOT NULL CHECK(lm_json_valid(snapshot_json) AND lm_json_type(snapshot_json)='object'),
  PRIMARY KEY(session_id,snapshot_id)
);

CREATE TABLE terminal_seals (
  session_id TEXT NOT NULL UNIQUE,
  seal_id TEXT NOT NULL CHECK(length(seal_id)=36),
  sealed_hash TEXT NOT NULL CHECK(length(sealed_hash)=64 AND sealed_hash !~ '[^0-9a-f]'),
  terminal_lifecycle TEXT NOT NULL CHECK(terminal_lifecycle IN ('completed','abandoned','interrupted')),
  terminal_seq BIGINT NOT NULL,
  terminal_state_version BIGINT NOT NULL CHECK(terminal_state_version>0),
  terminal_mission_ms BIGINT NOT NULL CHECK(terminal_mission_ms>=0),
  outcome_json TEXT NOT NULL CHECK(lm_json_valid(outcome_json) AND lm_json_type(outcome_json)='object'),
  immutable_behavior_json TEXT NOT NULL CHECK(lm_json_valid(immutable_behavior_json) AND lm_json_type(immutable_behavior_json)='object'),
  content_hash TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  sealed_at_ms BIGINT NOT NULL CHECK(sealed_at_ms>=0),
  PRIMARY KEY(session_id,seal_id),
  UNIQUE(session_id,sealed_hash)
);

CREATE TABLE behavior_facts (
  session_id TEXT NOT NULL,
  fact_id TEXT NOT NULL CHECK(length(fact_id)=36),
  seal_hash TEXT NOT NULL,
  context_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  subject_binding_id TEXT NOT NULL,
  cutoff_seq BIGINT NOT NULL,
  cutoff_state_version BIGINT NOT NULL CHECK(cutoff_state_version>=0),
  fact_payload_json TEXT NOT NULL CHECK(lm_json_valid(fact_payload_json) AND lm_json_type(fact_payload_json)='object'),
  visible_refs_json TEXT NOT NULL CHECK(lm_json_valid(visible_refs_json) AND lm_json_type(visible_refs_json)='array'),
  PRIMARY KEY(session_id,fact_id),
  UNIQUE(session_id,seal_hash,context_id,rule_id,subject_binding_id)
);

CREATE TABLE evaluation_reports (
  session_id TEXT NOT NULL,
  evaluation_id TEXT NOT NULL CHECK(length(evaluation_id)=36),
  job_id TEXT NOT NULL,
  sealed_hash TEXT NOT NULL,
  config_hash TEXT NOT NULL CHECK(length(config_hash)=64),
  revision BIGINT NOT NULL CHECK(revision>0),
  mode TEXT NOT NULL CHECK(mode IN ('live_model','offline_template')),
  report_json TEXT NOT NULL CHECK(lm_json_valid(report_json) AND lm_json_type(report_json)='object'),
  created_at_ms BIGINT NOT NULL CHECK(created_at_ms>=0),
  PRIMARY KEY(session_id,evaluation_id),
  UNIQUE(session_id,sealed_hash,config_hash,revision)
);

CREATE TABLE export_jobs (
  session_id TEXT NOT NULL,
  export_id TEXT NOT NULL CHECK(length(export_id)=36),
  sealed_hash TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK(length(request_id)=36),
  export_kind TEXT NOT NULL CHECK(export_kind IN ('public_replay','team_spoilers','diagnostics')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
  relative_output_path TEXT CHECK(relative_output_path IS NULL OR (relative_output_path NOT LIKE '/%' AND strpos(relative_output_path,'..')=0)),
  output_hash TEXT CHECK(output_hash IS NULL OR length(output_hash)=64),
  error_code TEXT,
  created_at_ms BIGINT NOT NULL CHECK(created_at_ms>=0),
  completed_at_ms BIGINT CHECK(completed_at_ms>=created_at_ms),
  PRIMARY KEY(session_id,export_id),
  UNIQUE(session_id,request_id),
  CHECK(status!='completed' OR (relative_output_path IS NOT NULL AND output_hash IS NOT NULL AND completed_at_ms IS NOT NULL))
);

CREATE TABLE diagnostic_records (
  session_id TEXT NOT NULL,
  diagnostic_id TEXT NOT NULL CHECK(length(diagnostic_id)=36),
  category TEXT NOT NULL CHECK(category IN ('late_callback','transport_unknown','storage_failure','recovery','validation_rejection','postgame_audit')),
  job_id TEXT,
  attempt_no BIGINT,
  recorded_at_ms BIGINT NOT NULL CHECK(recorded_at_ms>=0),
  payload_json TEXT NOT NULL CHECK(lm_json_valid(payload_json) AND lm_json_type(payload_json)='object'),
  PRIMARY KEY(session_id,diagnostic_id),
  CHECK((job_id IS NULL)=(attempt_no IS NULL))
);

ALTER TABLE sessions ADD FOREIGN KEY (launch_id) REFERENCES launches(launch_id);

ALTER TABLE sessions ADD FOREIGN KEY (content_hash) REFERENCES content_versions(content_hash);

ALTER TABLE sessions ADD FOREIGN KEY (policy_hash) REFERENCES policy_profiles(policy_hash);

ALTER TABLE sessions ADD FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE sessions ADD FOREIGN KEY(session_id,terminal_seal_id) REFERENCES terminal_seals(session_id,seal_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE session_scenes ADD FOREIGN KEY (session_id) REFERENCES sessions(session_id);

ALTER TABLE actor_bindings ADD FOREIGN KEY (session_id) REFERENCES sessions(session_id);

ALTER TABLE launch_session_access ADD FOREIGN KEY (launch_id) REFERENCES launches(launch_id);

ALTER TABLE launch_session_access ADD FOREIGN KEY (session_id) REFERENCES sessions(session_id);

ALTER TABLE launch_session_access ADD FOREIGN KEY(session_id,binding_id) REFERENCES actor_bindings(session_id,binding_id);

ALTER TABLE session_creations ADD FOREIGN KEY (launch_id) REFERENCES launches(launch_id);

ALTER TABLE session_creations ADD FOREIGN KEY (session_id) REFERENCES sessions(session_id);

ALTER TABLE commands ADD FOREIGN KEY(session_id,run_epoch) REFERENCES sessions(session_id,run_epoch);

ALTER TABLE commands ADD FOREIGN KEY(session_id,binding_id) REFERENCES actor_bindings(session_id,binding_id);

ALTER TABLE events ADD FOREIGN KEY (session_id) REFERENCES sessions(session_id);

ALTER TABLE events ADD FOREIGN KEY(session_id,binding_id) REFERENCES actor_bindings(session_id,binding_id);

ALTER TABLE events ADD FOREIGN KEY(session_id,causation_id) REFERENCES events(session_id,event_id);

ALTER TABLE view_events ADD FOREIGN KEY(session_id,source_seq) REFERENCES events(session_id,seq);

ALTER TABLE quota_accounts ADD FOREIGN KEY (session_id) REFERENCES sessions(session_id);

ALTER TABLE quota_accounts ADD FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id);

ALTER TABLE quota_accounts ADD FOREIGN KEY(session_id,last_entry_id) REFERENCES quota_ledger(session_id,entry_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE quota_ledger ADD FOREIGN KEY(session_id,account_id) REFERENCES quota_accounts(session_id,account_id);

ALTER TABLE quota_ledger ADD FOREIGN KEY(session_id,parent_entry_id) REFERENCES quota_ledger(session_id,entry_id);

ALTER TABLE task_requests ADD FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id);

ALTER TABLE task_requests ADD FOREIGN KEY(session_id,commander_binding_id) REFERENCES actor_bindings(session_id,binding_id);

ALTER TABLE task_requests ADD FOREIGN KEY(session_id,report_reservation_id) REFERENCES quota_ledger(session_id,entry_id);

ALTER TABLE investigations ADD FOREIGN KEY(session_id,task_id) REFERENCES task_requests(session_id,task_id);

ALTER TABLE investigations ADD FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id);

ALTER TABLE investigations ADD FOREIGN KEY(session_id,resource_charge_id) REFERENCES quota_ledger(session_id,entry_id);

ALTER TABLE operations ADD FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id);

ALTER TABLE evidence_instances ADD FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id);

ALTER TABLE evidence_instances ADD FOREIGN KEY(session_id,acquisition_investigation_id) REFERENCES investigations(session_id,investigation_id);

ALTER TABLE evidence_instances ADD FOREIGN KEY(session_id,supersedes_instance_id,supersedes_revision) REFERENCES evidence_instances(session_id,instance_id,revision);

ALTER TABLE provenance_disclosures ADD FOREIGN KEY(session_id,evidence_instance_id,evidence_revision) REFERENCES evidence_instances(session_id,instance_id,revision);

ALTER TABLE provenance_disclosures ADD FOREIGN KEY(session_id,subject_instance_id,subject_revision) REFERENCES evidence_instances(session_id,instance_id,revision);

ALTER TABLE reports ADD FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id);

ALTER TABLE reports ADD FOREIGN KEY(session_id,source_instance_id,source_revision) REFERENCES evidence_instances(session_id,instance_id,revision);

ALTER TABLE reports ADD FOREIGN KEY(session_id,actor_binding_id) REFERENCES actor_bindings(session_id,binding_id);

ALTER TABLE reports ADD FOREIGN KEY(session_id,task_id) REFERENCES task_requests(session_id,task_id);

ALTER TABLE reports ADD FOREIGN KEY(session_id,charge_entry_id) REFERENCES quota_ledger(session_id,entry_id);

ALTER TABLE uploads ADD FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id);

ALTER TABLE uploads ADD FOREIGN KEY(session_id,report_id,report_revision) REFERENCES reports(session_id,report_id,source_revision);

ALTER TABLE uploads ADD FOREIGN KEY(session_id,charge_entry_id) REFERENCES quota_ledger(session_id,entry_id);

ALTER TABLE uploads ADD FOREIGN KEY(session_id,authorization_binding_id) REFERENCES actor_bindings(session_id,binding_id);

ALTER TABLE input_manifests ADD FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id);

ALTER TABLE input_manifest_members ADD FOREIGN KEY(session_id,manifest_id) REFERENCES input_manifests(session_id,manifest_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE input_manifest_members ADD FOREIGN KEY(session_id,upload_id) REFERENCES uploads(session_id,upload_id);

ALTER TABLE player_statements ADD FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id);

ALTER TABLE player_statements ADD FOREIGN KEY(session_id,binding_id) REFERENCES actor_bindings(session_id,binding_id);

ALTER TABLE manifest_statements ADD FOREIGN KEY(session_id,manifest_id) REFERENCES input_manifests(session_id,manifest_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE manifest_statements ADD FOREIGN KEY(session_id,statement_id) REFERENCES player_statements(session_id,statement_id);

ALTER TABLE agent_jobs ADD FOREIGN KEY (session_id) REFERENCES sessions(session_id);

ALTER TABLE agent_jobs ADD FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id);

ALTER TABLE agent_jobs ADD FOREIGN KEY(session_id,manifest_id) REFERENCES input_manifests(session_id,manifest_id);

ALTER TABLE agent_jobs ADD FOREIGN KEY(session_id,seal_hash) REFERENCES terminal_seals(session_id,sealed_hash);

ALTER TABLE agent_attempts ADD FOREIGN KEY(session_id,job_id) REFERENCES agent_jobs(session_id,job_id);

ALTER TABLE public_records ADD FOREIGN KEY (session_id) REFERENCES sessions(session_id);

ALTER TABLE public_records ADD FOREIGN KEY(session_id,source_seq) REFERENCES events(session_id,seq);

ALTER TABLE display_receipts ADD FOREIGN KEY(session_id,binding_id) REFERENCES actor_bindings(session_id,binding_id);

ALTER TABLE display_receipts ADD FOREIGN KEY(session_id,public_record_id,record_revision) REFERENCES public_records(session_id,public_record_id,revision);

ALTER TABLE decision_snapshots ADD FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id);

ALTER TABLE decision_snapshots ADD FOREIGN KEY(session_id,binding_id) REFERENCES actor_bindings(session_id,binding_id);

ALTER TABLE decision_snapshots ADD FOREIGN KEY(session_id,source_seq) REFERENCES events(session_id,seq);

ALTER TABLE terminal_seals ADD FOREIGN KEY (session_id) REFERENCES sessions(session_id);

ALTER TABLE terminal_seals ADD FOREIGN KEY (content_hash) REFERENCES content_versions(content_hash);

ALTER TABLE terminal_seals ADD FOREIGN KEY (policy_hash) REFERENCES policy_profiles(policy_hash);

ALTER TABLE terminal_seals ADD FOREIGN KEY(session_id,terminal_seq) REFERENCES events(session_id,seq);

ALTER TABLE terminal_seals ADD FOREIGN KEY(session_id,seal_id) REFERENCES sessions(session_id,terminal_seal_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE behavior_facts ADD FOREIGN KEY(session_id,seal_hash) REFERENCES terminal_seals(session_id,sealed_hash);

ALTER TABLE behavior_facts ADD FOREIGN KEY(session_id,context_id) REFERENCES decision_snapshots(session_id,snapshot_id);

ALTER TABLE behavior_facts ADD FOREIGN KEY(session_id,subject_binding_id) REFERENCES actor_bindings(session_id,binding_id);

ALTER TABLE behavior_facts ADD FOREIGN KEY(session_id,cutoff_seq) REFERENCES events(session_id,seq);

ALTER TABLE evaluation_reports ADD FOREIGN KEY(session_id,job_id) REFERENCES agent_jobs(session_id,job_id);

ALTER TABLE evaluation_reports ADD FOREIGN KEY(session_id,sealed_hash) REFERENCES terminal_seals(session_id,sealed_hash);

ALTER TABLE export_jobs ADD FOREIGN KEY(session_id,sealed_hash) REFERENCES terminal_seals(session_id,sealed_hash);

ALTER TABLE diagnostic_records ADD FOREIGN KEY (session_id) REFERENCES sessions(session_id);

ALTER TABLE diagnostic_records ADD FOREIGN KEY(session_id,job_id,attempt_no) REFERENCES agent_attempts(session_id,job_id,attempt_no);

CREATE INDEX ix_events_request ON events(session_id,request_id) WHERE request_id IS NOT NULL;

CREATE UNIQUE INDEX ux_quota_session ON quota_accounts(session_id,role,resource) WHERE quota_scope='session';

CREATE UNIQUE INDEX ux_quota_scene ON quota_accounts(session_id,scene_id,role,resource) WHERE quota_scope='scene';

CREATE INDEX ix_ledger_account ON quota_ledger(session_id,account_id,created_at_ms);

CREATE INDEX ix_ledger_parent ON quota_ledger(session_id,parent_entry_id) WHERE parent_entry_id IS NOT NULL;

CREATE UNIQUE INDEX ux_task_active_role ON task_requests(session_id,target_role) WHERE status IN ('accepted','running');

CREATE INDEX ix_task_due ON task_requests(session_id,due_mission_ms) WHERE status IN ('accepted','running');

CREATE UNIQUE INDEX ux_investigation_active_role ON investigations(session_id,role) WHERE status IN ('queued','running');

CREATE INDEX ix_investigation_due ON investigations(session_id,due_mission_ms) WHERE status IN ('queued','running');

CREATE UNIQUE INDEX ux_operation_active ON operations(session_id) WHERE status IN ('accepted','running');

CREATE INDEX ix_evidence_inventory ON evidence_instances(session_id,owner_role,scene_id,acquired_mission_ms);

CREATE INDEX ix_reports_charge ON reports(session_id,charge_entry_id);

CREATE INDEX ix_reports_commander ON reports(session_id,scene_id,reported_mission_ms);

CREATE INDEX ix_uploads_charge ON uploads(session_id,charge_entry_id);

CREATE UNIQUE INDEX ux_advisor_input ON agent_jobs(session_id,scene_id,context_version,input_hash,config_hash) WHERE agent_role='advisor';

CREATE UNIQUE INDEX ux_evaluator_seal_config ON agent_jobs(session_id,seal_hash,config_hash) WHERE agent_role='evaluator';

CREATE UNIQUE INDEX ux_advisor_active ON agent_jobs(session_id) WHERE agent_role='advisor' AND status IN ('queued','running');

CREATE UNIQUE INDEX ux_evaluator_active ON agent_jobs(session_id,seal_hash,config_hash) WHERE agent_role='evaluator' AND status IN ('queued','running');

CREATE INDEX ix_agent_jobs_dispatch ON agent_jobs(status,deadline_at_ms) WHERE status IN ('queued','running');

CREATE UNIQUE INDEX ux_attempt_active ON agent_attempts(session_id,job_id) WHERE status IN ('sending','running');

-- SQLite trigger: access_grant_guard
CREATE FUNCTION lm_access_grant_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM actor_bindings b WHERE b.session_id=NEW.session_id AND b.binding_id=NEW.binding_id AND b.role='commander') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='ACCESS_COMMANDER_BINDING_REQUIRED';
  END IF;
  IF NEW.capability='commander.command' AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.session_id=NEW.session_id AND s.launch_id=NEW.launch_id AND s.lifecycle IN ('briefing','running')) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='GAMEPLAY_ACCESS_ORIGINAL_LAUNCH_ONLY';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER access_grant_guard BEFORE INSERT ON launch_session_access
FOR EACH ROW EXECUTE FUNCTION lm_access_grant_guard();

-- SQLite trigger: access_grant_immutable_update
CREATE FUNCTION lm_access_grant_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER access_grant_immutable_update BEFORE UPDATE ON launch_session_access
FOR EACH ROW EXECUTE FUNCTION lm_access_grant_immutable_update();

-- SQLite trigger: access_grant_immutable_delete
CREATE FUNCTION lm_access_grant_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER access_grant_immutable_delete BEFORE DELETE ON launch_session_access
FOR EACH ROW EXECUTE FUNCTION lm_access_grant_immutable_delete();

-- SQLite trigger: sessions_insert_policy
CREATE FUNCTION lm_sessions_insert_policy() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.mode='normal' AND (SELECT approval_status FROM policy_profiles WHERE policy_hash=NEW.policy_hash)!='approved' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='POLICY_NOT_APPROVED';
  END IF;
  IF NEW.lifecycle!='briefing' OR NEW.terminal_seal_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INITIAL_SESSION_STATE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sessions_insert_policy BEFORE INSERT ON sessions
FOR EACH ROW EXECUTE FUNCTION lm_sessions_insert_policy();

-- SQLite trigger: sessions_update_guard
CREATE FUNCTION lm_sessions_update_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.lifecycle IN ('completed','abandoned','interrupted') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  IF NEW.session_id!=OLD.session_id OR NEW.run_epoch!=OLD.run_epoch OR NEW.launch_id!=OLD.launch_id OR NEW.content_hash!=OLD.content_hash OR NEW.policy_hash!=OLD.policy_hash OR NEW.private_case_id!=OLD.private_case_id OR NEW.mode!=OLD.mode THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW.state_version<OLD.state_version OR NEW.state_version>OLD.state_version+1 OR NEW.inbox_version<OLD.inbox_version OR NEW.assistant_context_version<OLD.assistant_context_version OR NEW.mission_ms<OLD.mission_ms THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='STATE_VERSION_OR_TIME_REGRESSION';
  END IF;
  IF NEW.lifecycle IN ('completed','abandoned','interrupted') AND NOT EXISTS(SELECT 1 FROM terminal_seals z WHERE z.session_id=NEW.session_id AND z.seal_id=NEW.terminal_seal_id AND z.terminal_lifecycle=NEW.lifecycle AND z.terminal_state_version=NEW.state_version AND z.terminal_mission_ms=NEW.mission_ms AND z.terminal_seq=NEW.last_event_seq) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='TERMINAL_SEAL_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sessions_update_guard BEFORE UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION lm_sessions_update_guard();

-- SQLite trigger: event_sequence
CREATE FUNCTION lm_event_sequence() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.seq!=(SELECT last_event_seq+1 FROM sessions WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='EVENT_SEQUENCE_CONFLICT';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER event_sequence BEFORE INSERT ON events
FOR EACH ROW EXECUTE FUNCTION lm_event_sequence();

-- SQLite trigger: event_sequence_advance
CREATE FUNCTION lm_event_sequence_advance() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE sessions SET last_event_seq=NEW.seq WHERE session_id=NEW.session_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER event_sequence_advance AFTER INSERT ON events
FOR EACH ROW EXECUTE FUNCTION lm_event_sequence_advance();

-- SQLite trigger: view_cursor
CREATE FUNCTION lm_view_cursor() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cursor!=COALESCE((SELECT MAX(cursor)+1 FROM view_events WHERE session_id=NEW.session_id AND view_role=NEW.view_role),1) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='VIEW_CURSOR_CONFLICT';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER view_cursor BEFORE INSERT ON view_events
FOR EACH ROW EXECUTE FUNCTION lm_view_cursor();

-- SQLite trigger: quota_account_initial
CREATE FUNCTION lm_quota_account_initial() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.available!=NEW.capacity OR NEW.reserved!=0 OR NEW.spent!=0 OR NEW.account_version!=0 OR NEW.last_entry_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='QUOTA_ACCOUNT_INITIAL';
  END IF;
  IF NEW.resource='report' AND NEW.capacity!=COALESCE((SELECT (p.policy_json::json ->> 'reportLimitPerRolePerScene')::bigint FROM sessions s JOIN policy_profiles p USING(policy_hash) WHERE s.session_id=NEW.session_id),-1) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='REPORT_CAPACITY_POLICY';
  END IF;
  IF NEW.resource='upload' AND NEW.capacity!=COALESCE((SELECT (p.policy_json::json ->> 'uploadLimitPerScene')::bigint FROM sessions s JOIN policy_profiles p USING(policy_hash) WHERE s.session_id=NEW.session_id),-1) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='UPLOAD_CAPACITY_POLICY';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quota_account_initial BEFORE INSERT ON quota_accounts
FOR EACH ROW EXECUTE FUNCTION lm_quota_account_initial();

-- SQLite trigger: quota_ledger_guard
CREATE FUNCTION lm_quota_ledger_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM quota_accounts q WHERE q.session_id=NEW.session_id AND q.account_id=NEW.account_id AND q.account_version=NEW.account_version_before AND q.available+NEW.delta_available>=0 AND q.reserved+NEW.delta_reserved>=0 AND q.spent+NEW.delta_spent>=0) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='QUOTA_EXHAUSTED_OR_STALE';
  END IF;
  IF NEW.parent_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM quota_ledger p WHERE p.session_id=NEW.session_id AND p.entry_id=NEW.parent_entry_id AND p.account_id=NEW.account_id AND p.entry_kind=CASE WHEN NEW.entry_kind='refund' THEN 'spend' ELSE 'reserve' END AND p.amount>=NEW.amount+COALESCE((SELECT SUM(c.amount) FROM quota_ledger c WHERE c.session_id=NEW.session_id AND c.parent_entry_id=p.entry_id),0)) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='QUOTA_PARENT_OVERDRAW';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quota_ledger_guard BEFORE INSERT ON quota_ledger
FOR EACH ROW EXECUTE FUNCTION lm_quota_ledger_guard();

-- SQLite trigger: quota_account_mutation_guard
CREATE FUNCTION lm_quota_account_mutation_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.capacity!=OLD.capacity OR NEW.resource!=OLD.resource OR NEW.quota_scope!=OLD.quota_scope OR NEW.scene_id IS DISTINCT FROM OLD.scene_id OR NEW.role!=OLD.role OR NEW.account_id!=OLD.account_id OR NEW.session_id!=OLD.session_id THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='QUOTA_IDENTITY_IMMUTABLE';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM quota_ledger l WHERE l.session_id=OLD.session_id AND l.account_id=OLD.account_id AND l.entry_id=NEW.last_entry_id AND l.account_version_before=OLD.account_version AND NEW.account_version=OLD.account_version+1 AND NEW.available=OLD.available+l.delta_available AND NEW.reserved=OLD.reserved+l.delta_reserved AND NEW.spent=OLD.spent+l.delta_spent) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='QUOTA_DIRECT_UPDATE_FORBIDDEN';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quota_account_mutation_guard BEFORE UPDATE ON quota_accounts
FOR EACH ROW EXECUTE FUNCTION lm_quota_account_mutation_guard();

-- SQLite trigger: quota_apply
CREATE FUNCTION lm_quota_apply() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE quota_accounts SET available=available+NEW.delta_available,reserved=reserved+NEW.delta_reserved,spent=spent+NEW.delta_spent,account_version=account_version+1,last_entry_id=NEW.entry_id WHERE session_id=NEW.session_id AND account_id=NEW.account_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quota_apply AFTER INSERT ON quota_ledger
FOR EACH ROW EXECUTE FUNCTION lm_quota_apply();

-- SQLite trigger: task_authorization
CREATE FUNCTION lm_task_authorization() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM actor_bindings b WHERE b.session_id=NEW.session_id AND b.binding_id=NEW.commander_binding_id AND b.role='commander') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='TASK_COMMANDER_REQUIRED';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM quota_ledger l JOIN quota_accounts q ON q.session_id=l.session_id AND q.account_id=l.account_id WHERE l.session_id=NEW.session_id AND l.entry_id=NEW.report_reservation_id AND l.entry_kind='reserve' AND l.amount=1 AND q.resource='report' AND q.role=NEW.target_role AND q.scene_id=NEW.scene_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='TASK_REPORT_RESERVATION_REQUIRED';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER task_authorization BEFORE INSERT ON task_requests
FOR EACH ROW EXECUTE FUNCTION lm_task_authorization();

-- SQLite trigger: investigation_authorization
CREATE FUNCTION lm_investigation_authorization() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM task_requests t WHERE t.session_id=NEW.session_id AND t.task_id=NEW.task_id AND t.target_role=NEW.role AND t.scene_id=NEW.scene_id AND t.task_kind='investigate_and_report' AND t.option_id=NEW.option_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INVESTIGATION_TASK_MISMATCH';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM quota_ledger l JOIN quota_accounts q ON q.session_id=l.session_id AND q.account_id=l.account_id WHERE l.session_id=NEW.session_id AND l.entry_id=NEW.resource_charge_id AND l.entry_kind='spend' AND l.amount=1 AND q.role=NEW.role AND q.resource=NEW.resource_key AND q.quota_scope='session') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INVESTIGATION_RESOURCE_CHARGE_REQUIRED';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER investigation_authorization BEFORE INSERT ON investigations
FOR EACH ROW EXECUTE FUNCTION lm_investigation_authorization();

-- SQLite trigger: evidence_acquisition_guard
CREATE FUNCTION lm_evidence_acquisition_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.acquisition_investigation_id IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM investigations i WHERE i.session_id=NEW.session_id AND i.investigation_id=NEW.acquisition_investigation_id AND i.role=NEW.owner_role AND i.scene_id=NEW.scene_id AND i.status='completed' AND NEW.acquired_mission_ms>=i.due_mission_ms) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='EVIDENCE_NOT_OBSERVED';
  END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER evidence_acquisition_guard BEFORE INSERT ON evidence_instances
FOR EACH ROW EXECUTE FUNCTION lm_evidence_acquisition_guard();

-- SQLite trigger: report_guard
CREATE FUNCTION lm_report_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.task_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM task_requests t JOIN quota_ledger l ON l.session_id=t.session_id AND l.entry_id=NEW.charge_entry_id WHERE t.session_id=NEW.session_id AND t.task_id=NEW.task_id AND t.scene_id=NEW.scene_id AND t.target_role=NEW.sender_role AND t.status IN ('accepted','running') AND l.parent_entry_id=t.report_reservation_id AND l.entry_kind='spend' AND l.source_bucket='reserved') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='REPORT_TASK_MISMATCH';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM evidence_instances e WHERE e.session_id=NEW.session_id AND e.instance_id=NEW.source_instance_id AND e.revision=NEW.source_revision AND e.owner_role=NEW.sender_role AND e.scene_id=NEW.scene_id AND e.payload_hash=NEW.immutable_payload_hash AND e.public_payload_json=NEW.immutable_payload_json) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='REPORT_SOURCE_MISMATCH';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM actor_bindings b WHERE b.session_id=NEW.session_id AND b.binding_id=NEW.actor_binding_id AND b.role=NEW.sender_role) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='REPORT_ROLE_FORBIDDEN';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM quota_ledger l JOIN quota_accounts q ON q.session_id=l.session_id AND q.account_id=l.account_id WHERE l.session_id=NEW.session_id AND l.entry_id=NEW.charge_entry_id AND l.entry_kind='spend' AND q.resource='report' AND q.role=NEW.sender_role AND q.scene_id=NEW.scene_id AND l.amount>(SELECT COUNT(*) FROM reports r WHERE r.session_id=NEW.session_id AND r.charge_entry_id=l.entry_id)) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='REPORT_CHARGE_EXHAUSTED';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER report_guard BEFORE INSERT ON reports
FOR EACH ROW EXECUTE FUNCTION lm_report_guard();

-- SQLite trigger: upload_guard
CREATE FUNCTION lm_upload_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM reports r WHERE r.session_id=NEW.session_id AND r.report_id=NEW.report_id AND r.source_revision=NEW.report_revision AND r.scene_id=NEW.scene_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='UPLOAD_REPORT_NOT_RECEIVED';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM actor_bindings b WHERE b.session_id=NEW.session_id AND b.binding_id=NEW.authorization_binding_id AND b.role='commander') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='UPLOAD_COMMANDER_REQUIRED';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM quota_ledger l JOIN quota_accounts q ON q.session_id=l.session_id AND q.account_id=l.account_id WHERE l.session_id=NEW.session_id AND l.entry_id=NEW.charge_entry_id AND l.entry_kind='spend' AND q.resource='upload' AND q.scene_id=NEW.scene_id AND l.amount>(SELECT COUNT(*) FROM uploads u WHERE u.session_id=NEW.session_id AND u.charge_entry_id=l.entry_id)) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='UPLOAD_CHARGE_EXHAUSTED';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER upload_guard BEFORE INSERT ON uploads
FOR EACH ROW EXECUTE FUNCTION lm_upload_guard();

-- SQLite trigger: manifest_members_before_seal
CREATE FUNCTION lm_manifest_members_before_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM input_manifests m WHERE m.session_id=NEW.session_id AND m.manifest_id=NEW.manifest_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='MANIFEST_ALREADY_FINALIZED';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER manifest_members_before_seal BEFORE INSERT ON input_manifest_members
FOR EACH ROW EXECUTE FUNCTION lm_manifest_members_before_seal();

-- SQLite trigger: manifest_statements_before_seal
CREATE FUNCTION lm_manifest_statements_before_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM input_manifests m WHERE m.session_id=NEW.session_id AND m.manifest_id=NEW.manifest_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='MANIFEST_ALREADY_FINALIZED';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER manifest_statements_before_seal BEFORE INSERT ON manifest_statements
FOR EACH ROW EXECUTE FUNCTION lm_manifest_statements_before_seal();

-- SQLite trigger: manifest_finalize
CREATE FUNCTION lm_manifest_finalize() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT COUNT(*) FROM input_manifest_members x WHERE x.session_id=NEW.session_id AND x.manifest_id=NEW.manifest_id)>5 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='MANIFEST_UPLOAD_LIMIT';
  END IF;
  IF EXISTS(SELECT 1 FROM input_manifest_members x JOIN uploads u ON u.session_id=x.session_id AND u.upload_id=x.upload_id WHERE x.session_id=NEW.session_id AND x.manifest_id=NEW.manifest_id AND u.scene_id!=NEW.scene_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='MANIFEST_SCENE_MISMATCH';
  END IF;
  IF EXISTS(SELECT 1 FROM manifest_statements x JOIN player_statements p ON p.session_id=x.session_id AND p.statement_id=x.statement_id WHERE x.session_id=NEW.session_id AND x.manifest_id=NEW.manifest_id AND p.scene_id!=NEW.scene_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='MANIFEST_STATEMENT_SCENE_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER manifest_finalize BEFORE INSERT ON input_manifests
FOR EACH ROW EXECUTE FUNCTION lm_manifest_finalize();

-- SQLite trigger: player_statement_commander
CREATE FUNCTION lm_player_statement_commander() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM actor_bindings b WHERE b.session_id=NEW.session_id AND b.binding_id=NEW.binding_id AND b.role='commander') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='STATEMENT_COMMANDER_REQUIRED';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER player_statement_commander BEFORE INSERT ON player_statements
FOR EACH ROW EXECUTE FUNCTION lm_player_statement_commander();

-- SQLite trigger: agent_job_input_guard
CREATE FUNCTION lm_agent_job_input_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.agent_role='advisor' AND NOT EXISTS(SELECT 1 FROM input_manifests m WHERE m.session_id=NEW.session_id AND m.manifest_id=NEW.manifest_id AND m.scene_id=NEW.scene_id AND m.context_version=NEW.context_version AND m.inbox_version=NEW.inbox_version AND m.input_hash=NEW.input_hash) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='ADVISOR_MANIFEST_MISMATCH';
  END IF;
  IF NEW.agent_role='advisor' AND EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  IF NEW.agent_role='evaluator' AND NOT EXISTS(SELECT 1 FROM sessions s JOIN terminal_seals z ON z.session_id=s.session_id AND z.seal_id=s.terminal_seal_id WHERE s.session_id=NEW.session_id AND z.sealed_hash=NEW.seal_hash AND s.lifecycle IN ('completed','abandoned','interrupted')) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='EVALUATOR_REQUIRES_SEAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_job_input_guard BEFORE INSERT ON agent_jobs
FOR EACH ROW EXECUTE FUNCTION lm_agent_job_input_guard();

-- SQLite trigger: agent_job_update_guard
CREATE FUNCTION lm_agent_job_update_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.session_id!=OLD.session_id OR NEW.job_id!=OLD.job_id OR NEW.agent_role!=OLD.agent_role OR NEW.scene_id IS DISTINCT FROM OLD.scene_id OR NEW.manifest_id IS DISTINCT FROM OLD.manifest_id OR NEW.seal_hash IS DISTINCT FROM OLD.seal_hash OR NEW.input_hash!=OLD.input_hash OR NEW.config_hash!=OLD.config_hash OR NEW.input_version!=OLD.input_version OR NEW.context_version IS DISTINCT FROM OLD.context_version OR NEW.inbox_version IS DISTINCT FROM OLD.inbox_version OR NEW.evaluator_input_json IS DISTINCT FROM OLD.evaluator_input_json OR NEW.max_attempts!=OLD.max_attempts THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='AGENT_INPUT_IMMUTABLE';
  END IF;
  IF OLD.status IN ('succeeded','cancelled','superseded') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='AGENT_JOB_FINAL';
  END IF;
  IF NEW.status!=OLD.status AND NOT ((OLD.status='queued' AND NEW.status IN ('running','fallback','failed','cancelled','superseded')) OR (OLD.status='running' AND NEW.status IN ('succeeded','fallback','failed','cancelled','superseded')) OR (OLD.status IN ('fallback','failed') AND NEW.status IN ('queued','cancelled','superseded'))) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='AGENT_STATUS_TRANSITION';
  END IF;
  IF NEW.agent_role='advisor' AND EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_job_update_guard BEFORE UPDATE ON agent_jobs
FOR EACH ROW EXECUTE FUNCTION lm_agent_job_update_guard();

-- SQLite trigger: attempt_insert_guard
CREATE FUNCTION lm_attempt_insert_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status!='sending' OR NOT EXISTS(SELECT 1 FROM agent_jobs j WHERE j.session_id=NEW.session_id AND j.job_id=NEW.job_id AND j.status='running' AND j.mode='live_model' AND NEW.attempt_no<=j.max_attempts) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='ATTEMPT_NOT_ALLOWED';
  END IF;
  IF NEW.attempt_no!=COALESCE((SELECT MAX(attempt_no)+1 FROM agent_attempts WHERE session_id=NEW.session_id AND job_id=NEW.job_id),1) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='ATTEMPT_SEQUENCE';
  END IF;
  IF (SELECT agent_role FROM agent_jobs WHERE session_id=NEW.session_id AND job_id=NEW.job_id)='advisor' AND (SELECT COUNT(*) FROM agent_attempts a JOIN agent_jobs j ON j.session_id=a.session_id AND j.job_id=a.job_id WHERE a.session_id=NEW.session_id AND j.agent_role='advisor')>=30 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='ADVISOR_SESSION_CALL_LIMIT';
  END IF;
  IF (SELECT agent_role FROM agent_jobs WHERE session_id=NEW.session_id AND job_id=NEW.job_id)='advisor' AND EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER attempt_insert_guard BEFORE INSERT ON agent_attempts
FOR EACH ROW EXECUTE FUNCTION lm_attempt_insert_guard();

-- SQLite trigger: attempt_update_guard
CREATE FUNCTION lm_attempt_update_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.session_id!=OLD.session_id OR NEW.job_id!=OLD.job_id OR NEW.attempt_no!=OLD.attempt_no OR NEW.request_key!=OLD.request_key OR NEW.sent_at_ms!=OLD.sent_at_ms THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='ATTEMPT_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD.status NOT IN ('sending','running') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='ATTEMPT_FINAL';
  END IF;
  IF OLD.status='running' AND NEW.status='sending' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='ATTEMPT_STATUS_REGRESSION';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER attempt_update_guard BEFORE UPDATE ON agent_attempts
FOR EACH ROW EXECUTE FUNCTION lm_attempt_update_guard();

-- SQLite trigger: display_owner_guard
CREATE FUNCTION lm_display_owner_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public_records p JOIN actor_bindings b ON b.session_id=p.session_id WHERE p.session_id=NEW.session_id AND p.public_record_id=NEW.public_record_id AND p.revision=NEW.record_revision AND b.binding_id=NEW.binding_id AND (p.view_role=b.role OR p.view_role='all')) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='DISPLAY_NOT_VISIBLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER display_owner_guard BEFORE INSERT ON display_receipts
FOR EACH ROW EXECUTE FUNCTION lm_display_owner_guard();

-- SQLite trigger: terminal_seal_guard
CREATE FUNCTION lm_terminal_seal_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM sessions s WHERE s.session_id=NEW.session_id AND s.lifecycle IN ('briefing','running') AND NEW.terminal_state_version=s.state_version+1 AND NEW.terminal_seq=s.last_event_seq AND NEW.terminal_mission_ms>=s.mission_ms AND NEW.content_hash=s.content_hash AND NEW.policy_hash=s.policy_hash) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SEAL_STATE_MISMATCH';
  END IF;
  IF EXISTS(SELECT 1 FROM investigations WHERE session_id=NEW.session_id AND status IN ('queued','running')) OR EXISTS(SELECT 1 FROM task_requests WHERE session_id=NEW.session_id AND status IN ('accepted','running')) OR EXISTS(SELECT 1 FROM operations WHERE session_id=NEW.session_id AND status IN ('accepted','running')) OR EXISTS(SELECT 1 FROM agent_jobs WHERE session_id=NEW.session_id AND agent_role='advisor' AND status IN ('queued','running')) OR EXISTS(SELECT 1 FROM quota_accounts WHERE session_id=NEW.session_id AND reserved>0) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SEAL_HAS_UNSETTLED_OPERATIONS';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER terminal_seal_guard BEFORE INSERT ON terminal_seals
FOR EACH ROW EXECUTE FUNCTION lm_terminal_seal_guard();

-- SQLite trigger: behavior_cutoff_guard
CREATE FUNCTION lm_behavior_cutoff_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM decision_snapshots d JOIN terminal_seals z ON z.session_id=d.session_id WHERE d.session_id=NEW.session_id AND d.snapshot_id=NEW.context_id AND z.sealed_hash=NEW.seal_hash AND NEW.cutoff_seq=d.source_seq AND NEW.cutoff_state_version=d.state_version AND NEW.cutoff_seq<=z.terminal_seq AND NEW.cutoff_state_version<=z.terminal_state_version) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BEHAVIOR_CUTOFF_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER behavior_cutoff_guard BEFORE INSERT ON behavior_facts
FOR EACH ROW EXECUTE FUNCTION lm_behavior_cutoff_guard();

-- SQLite trigger: evaluation_result_guard
CREATE FUNCTION lm_evaluation_result_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM agent_jobs j WHERE j.session_id=NEW.session_id AND j.job_id=NEW.job_id AND j.agent_role='evaluator' AND j.seal_hash=NEW.sealed_hash AND j.config_hash=NEW.config_hash AND j.status IN ('succeeded','fallback') AND j.result_json=NEW.report_json AND j.mode=NEW.mode) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='EVALUATION_JOB_RESULT_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER evaluation_result_guard BEFORE INSERT ON evaluation_reports
FOR EACH ROW EXECUTE FUNCTION lm_evaluation_result_guard();

-- SQLite trigger: schema_migrations_immutable_update
CREATE FUNCTION lm_schema_migrations_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER schema_migrations_immutable_update BEFORE UPDATE ON schema_migrations
FOR EACH ROW EXECUTE FUNCTION lm_schema_migrations_immutable_update();

-- SQLite trigger: schema_migrations_immutable_delete
CREATE FUNCTION lm_schema_migrations_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER schema_migrations_immutable_delete BEFORE DELETE ON schema_migrations
FOR EACH ROW EXECUTE FUNCTION lm_schema_migrations_immutable_delete();

-- SQLite trigger: content_versions_immutable_update
CREATE FUNCTION lm_content_versions_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER content_versions_immutable_update BEFORE UPDATE ON content_versions
FOR EACH ROW EXECUTE FUNCTION lm_content_versions_immutable_update();

-- SQLite trigger: content_versions_immutable_delete
CREATE FUNCTION lm_content_versions_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER content_versions_immutable_delete BEFORE DELETE ON content_versions
FOR EACH ROW EXECUTE FUNCTION lm_content_versions_immutable_delete();

-- SQLite trigger: policy_profiles_immutable_update
CREATE FUNCTION lm_policy_profiles_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER policy_profiles_immutable_update BEFORE UPDATE ON policy_profiles
FOR EACH ROW EXECUTE FUNCTION lm_policy_profiles_immutable_update();

-- SQLite trigger: policy_profiles_immutable_delete
CREATE FUNCTION lm_policy_profiles_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER policy_profiles_immutable_delete BEFORE DELETE ON policy_profiles
FOR EACH ROW EXECUTE FUNCTION lm_policy_profiles_immutable_delete();

-- SQLite trigger: actor_bindings_immutable_update
CREATE FUNCTION lm_actor_bindings_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER actor_bindings_immutable_update BEFORE UPDATE ON actor_bindings
FOR EACH ROW EXECUTE FUNCTION lm_actor_bindings_immutable_update();

-- SQLite trigger: actor_bindings_immutable_delete
CREATE FUNCTION lm_actor_bindings_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER actor_bindings_immutable_delete BEFORE DELETE ON actor_bindings
FOR EACH ROW EXECUTE FUNCTION lm_actor_bindings_immutable_delete();

-- SQLite trigger: session_creations_immutable_update
CREATE FUNCTION lm_session_creations_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER session_creations_immutable_update BEFORE UPDATE ON session_creations
FOR EACH ROW EXECUTE FUNCTION lm_session_creations_immutable_update();

-- SQLite trigger: session_creations_immutable_delete
CREATE FUNCTION lm_session_creations_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER session_creations_immutable_delete BEFORE DELETE ON session_creations
FOR EACH ROW EXECUTE FUNCTION lm_session_creations_immutable_delete();

-- SQLite trigger: commands_immutable_update
CREATE FUNCTION lm_commands_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER commands_immutable_update BEFORE UPDATE ON commands
FOR EACH ROW EXECUTE FUNCTION lm_commands_immutable_update();

-- SQLite trigger: commands_immutable_delete
CREATE FUNCTION lm_commands_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER commands_immutable_delete BEFORE DELETE ON commands
FOR EACH ROW EXECUTE FUNCTION lm_commands_immutable_delete();

-- SQLite trigger: events_immutable_update
CREATE FUNCTION lm_events_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER events_immutable_update BEFORE UPDATE ON events
FOR EACH ROW EXECUTE FUNCTION lm_events_immutable_update();

-- SQLite trigger: events_immutable_delete
CREATE FUNCTION lm_events_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER events_immutable_delete BEFORE DELETE ON events
FOR EACH ROW EXECUTE FUNCTION lm_events_immutable_delete();

-- SQLite trigger: view_events_immutable_update
CREATE FUNCTION lm_view_events_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER view_events_immutable_update BEFORE UPDATE ON view_events
FOR EACH ROW EXECUTE FUNCTION lm_view_events_immutable_update();

-- SQLite trigger: view_events_immutable_delete
CREATE FUNCTION lm_view_events_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER view_events_immutable_delete BEFORE DELETE ON view_events
FOR EACH ROW EXECUTE FUNCTION lm_view_events_immutable_delete();

-- SQLite trigger: quota_ledger_immutable_update
CREATE FUNCTION lm_quota_ledger_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER quota_ledger_immutable_update BEFORE UPDATE ON quota_ledger
FOR EACH ROW EXECUTE FUNCTION lm_quota_ledger_immutable_update();

-- SQLite trigger: quota_ledger_immutable_delete
CREATE FUNCTION lm_quota_ledger_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER quota_ledger_immutable_delete BEFORE DELETE ON quota_ledger
FOR EACH ROW EXECUTE FUNCTION lm_quota_ledger_immutable_delete();

-- SQLite trigger: evidence_instances_immutable_update
CREATE FUNCTION lm_evidence_instances_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER evidence_instances_immutable_update BEFORE UPDATE ON evidence_instances
FOR EACH ROW EXECUTE FUNCTION lm_evidence_instances_immutable_update();

-- SQLite trigger: evidence_instances_immutable_delete
CREATE FUNCTION lm_evidence_instances_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER evidence_instances_immutable_delete BEFORE DELETE ON evidence_instances
FOR EACH ROW EXECUTE FUNCTION lm_evidence_instances_immutable_delete();

-- SQLite trigger: provenance_disclosures_immutable_update
CREATE FUNCTION lm_provenance_disclosures_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER provenance_disclosures_immutable_update BEFORE UPDATE ON provenance_disclosures
FOR EACH ROW EXECUTE FUNCTION lm_provenance_disclosures_immutable_update();

-- SQLite trigger: provenance_disclosures_immutable_delete
CREATE FUNCTION lm_provenance_disclosures_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER provenance_disclosures_immutable_delete BEFORE DELETE ON provenance_disclosures
FOR EACH ROW EXECUTE FUNCTION lm_provenance_disclosures_immutable_delete();

-- SQLite trigger: reports_immutable_update
CREATE FUNCTION lm_reports_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER reports_immutable_update BEFORE UPDATE ON reports
FOR EACH ROW EXECUTE FUNCTION lm_reports_immutable_update();

-- SQLite trigger: reports_immutable_delete
CREATE FUNCTION lm_reports_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER reports_immutable_delete BEFORE DELETE ON reports
FOR EACH ROW EXECUTE FUNCTION lm_reports_immutable_delete();

-- SQLite trigger: uploads_immutable_update
CREATE FUNCTION lm_uploads_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER uploads_immutable_update BEFORE UPDATE ON uploads
FOR EACH ROW EXECUTE FUNCTION lm_uploads_immutable_update();

-- SQLite trigger: uploads_immutable_delete
CREATE FUNCTION lm_uploads_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER uploads_immutable_delete BEFORE DELETE ON uploads
FOR EACH ROW EXECUTE FUNCTION lm_uploads_immutable_delete();

-- SQLite trigger: input_manifests_immutable_update
CREATE FUNCTION lm_input_manifests_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER input_manifests_immutable_update BEFORE UPDATE ON input_manifests
FOR EACH ROW EXECUTE FUNCTION lm_input_manifests_immutable_update();

-- SQLite trigger: input_manifests_immutable_delete
CREATE FUNCTION lm_input_manifests_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER input_manifests_immutable_delete BEFORE DELETE ON input_manifests
FOR EACH ROW EXECUTE FUNCTION lm_input_manifests_immutable_delete();

-- SQLite trigger: input_manifest_members_immutable_update
CREATE FUNCTION lm_input_manifest_members_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER input_manifest_members_immutable_update BEFORE UPDATE ON input_manifest_members
FOR EACH ROW EXECUTE FUNCTION lm_input_manifest_members_immutable_update();

-- SQLite trigger: input_manifest_members_immutable_delete
CREATE FUNCTION lm_input_manifest_members_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER input_manifest_members_immutable_delete BEFORE DELETE ON input_manifest_members
FOR EACH ROW EXECUTE FUNCTION lm_input_manifest_members_immutable_delete();

-- SQLite trigger: player_statements_immutable_update
CREATE FUNCTION lm_player_statements_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER player_statements_immutable_update BEFORE UPDATE ON player_statements
FOR EACH ROW EXECUTE FUNCTION lm_player_statements_immutable_update();

-- SQLite trigger: player_statements_immutable_delete
CREATE FUNCTION lm_player_statements_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER player_statements_immutable_delete BEFORE DELETE ON player_statements
FOR EACH ROW EXECUTE FUNCTION lm_player_statements_immutable_delete();

-- SQLite trigger: manifest_statements_immutable_update
CREATE FUNCTION lm_manifest_statements_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER manifest_statements_immutable_update BEFORE UPDATE ON manifest_statements
FOR EACH ROW EXECUTE FUNCTION lm_manifest_statements_immutable_update();

-- SQLite trigger: manifest_statements_immutable_delete
CREATE FUNCTION lm_manifest_statements_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER manifest_statements_immutable_delete BEFORE DELETE ON manifest_statements
FOR EACH ROW EXECUTE FUNCTION lm_manifest_statements_immutable_delete();

-- SQLite trigger: public_records_immutable_update
CREATE FUNCTION lm_public_records_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER public_records_immutable_update BEFORE UPDATE ON public_records
FOR EACH ROW EXECUTE FUNCTION lm_public_records_immutable_update();

-- SQLite trigger: public_records_immutable_delete
CREATE FUNCTION lm_public_records_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER public_records_immutable_delete BEFORE DELETE ON public_records
FOR EACH ROW EXECUTE FUNCTION lm_public_records_immutable_delete();

-- SQLite trigger: display_receipts_immutable_update
CREATE FUNCTION lm_display_receipts_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER display_receipts_immutable_update BEFORE UPDATE ON display_receipts
FOR EACH ROW EXECUTE FUNCTION lm_display_receipts_immutable_update();

-- SQLite trigger: display_receipts_immutable_delete
CREATE FUNCTION lm_display_receipts_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER display_receipts_immutable_delete BEFORE DELETE ON display_receipts
FOR EACH ROW EXECUTE FUNCTION lm_display_receipts_immutable_delete();

-- SQLite trigger: decision_snapshots_immutable_update
CREATE FUNCTION lm_decision_snapshots_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER decision_snapshots_immutable_update BEFORE UPDATE ON decision_snapshots
FOR EACH ROW EXECUTE FUNCTION lm_decision_snapshots_immutable_update();

-- SQLite trigger: decision_snapshots_immutable_delete
CREATE FUNCTION lm_decision_snapshots_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER decision_snapshots_immutable_delete BEFORE DELETE ON decision_snapshots
FOR EACH ROW EXECUTE FUNCTION lm_decision_snapshots_immutable_delete();

-- SQLite trigger: terminal_seals_immutable_update
CREATE FUNCTION lm_terminal_seals_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER terminal_seals_immutable_update BEFORE UPDATE ON terminal_seals
FOR EACH ROW EXECUTE FUNCTION lm_terminal_seals_immutable_update();

-- SQLite trigger: terminal_seals_immutable_delete
CREATE FUNCTION lm_terminal_seals_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER terminal_seals_immutable_delete BEFORE DELETE ON terminal_seals
FOR EACH ROW EXECUTE FUNCTION lm_terminal_seals_immutable_delete();

-- SQLite trigger: behavior_facts_immutable_update
CREATE FUNCTION lm_behavior_facts_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER behavior_facts_immutable_update BEFORE UPDATE ON behavior_facts
FOR EACH ROW EXECUTE FUNCTION lm_behavior_facts_immutable_update();

-- SQLite trigger: behavior_facts_immutable_delete
CREATE FUNCTION lm_behavior_facts_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER behavior_facts_immutable_delete BEFORE DELETE ON behavior_facts
FOR EACH ROW EXECUTE FUNCTION lm_behavior_facts_immutable_delete();

-- SQLite trigger: evaluation_reports_immutable_update
CREATE FUNCTION lm_evaluation_reports_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER evaluation_reports_immutable_update BEFORE UPDATE ON evaluation_reports
FOR EACH ROW EXECUTE FUNCTION lm_evaluation_reports_immutable_update();

-- SQLite trigger: evaluation_reports_immutable_delete
CREATE FUNCTION lm_evaluation_reports_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER evaluation_reports_immutable_delete BEFORE DELETE ON evaluation_reports
FOR EACH ROW EXECUTE FUNCTION lm_evaluation_reports_immutable_delete();

-- SQLite trigger: sessions_no_delete
CREATE FUNCTION lm_sessions_no_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='AUDIT_DELETE_FORBIDDEN';
  RETURN OLD;
END;
$$;
CREATE TRIGGER sessions_no_delete BEFORE DELETE ON sessions
FOR EACH ROW EXECUTE FUNCTION lm_sessions_no_delete();

-- SQLite trigger: session_scenes_no_delete
CREATE FUNCTION lm_session_scenes_no_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='AUDIT_DELETE_FORBIDDEN';
  RETURN OLD;
END;
$$;
CREATE TRIGGER session_scenes_no_delete BEFORE DELETE ON session_scenes
FOR EACH ROW EXECUTE FUNCTION lm_session_scenes_no_delete();

-- SQLite trigger: quota_accounts_no_delete
CREATE FUNCTION lm_quota_accounts_no_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='AUDIT_DELETE_FORBIDDEN';
  RETURN OLD;
END;
$$;
CREATE TRIGGER quota_accounts_no_delete BEFORE DELETE ON quota_accounts
FOR EACH ROW EXECUTE FUNCTION lm_quota_accounts_no_delete();

-- SQLite trigger: task_requests_no_delete
CREATE FUNCTION lm_task_requests_no_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='AUDIT_DELETE_FORBIDDEN';
  RETURN OLD;
END;
$$;
CREATE TRIGGER task_requests_no_delete BEFORE DELETE ON task_requests
FOR EACH ROW EXECUTE FUNCTION lm_task_requests_no_delete();

-- SQLite trigger: investigations_no_delete
CREATE FUNCTION lm_investigations_no_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='AUDIT_DELETE_FORBIDDEN';
  RETURN OLD;
END;
$$;
CREATE TRIGGER investigations_no_delete BEFORE DELETE ON investigations
FOR EACH ROW EXECUTE FUNCTION lm_investigations_no_delete();

-- SQLite trigger: operations_no_delete
CREATE FUNCTION lm_operations_no_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='AUDIT_DELETE_FORBIDDEN';
  RETURN OLD;
END;
$$;
CREATE TRIGGER operations_no_delete BEFORE DELETE ON operations
FOR EACH ROW EXECUTE FUNCTION lm_operations_no_delete();

-- SQLite trigger: agent_jobs_no_delete
CREATE FUNCTION lm_agent_jobs_no_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='AUDIT_DELETE_FORBIDDEN';
  RETURN OLD;
END;
$$;
CREATE TRIGGER agent_jobs_no_delete BEFORE DELETE ON agent_jobs
FOR EACH ROW EXECUTE FUNCTION lm_agent_jobs_no_delete();

-- SQLite trigger: agent_attempts_no_delete
CREATE FUNCTION lm_agent_attempts_no_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='AUDIT_DELETE_FORBIDDEN';
  RETURN OLD;
END;
$$;
CREATE TRIGGER agent_attempts_no_delete BEFORE DELETE ON agent_attempts
FOR EACH ROW EXECUTE FUNCTION lm_agent_attempts_no_delete();

-- SQLite trigger: export_jobs_no_delete
CREATE FUNCTION lm_export_jobs_no_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='AUDIT_DELETE_FORBIDDEN';
  RETURN OLD;
END;
$$;
CREATE TRIGGER export_jobs_no_delete BEFORE DELETE ON export_jobs
FOR EACH ROW EXECUTE FUNCTION lm_export_jobs_no_delete();

-- SQLite trigger: session_scenes_terminal_insert
CREATE FUNCTION lm_session_scenes_terminal_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER session_scenes_terminal_insert BEFORE INSERT ON session_scenes
FOR EACH ROW EXECUTE FUNCTION lm_session_scenes_terminal_insert();

-- SQLite trigger: session_scenes_terminal_update
CREATE FUNCTION lm_session_scenes_terminal_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER session_scenes_terminal_update BEFORE UPDATE ON session_scenes
FOR EACH ROW EXECUTE FUNCTION lm_session_scenes_terminal_update();

-- SQLite trigger: actor_bindings_terminal_insert
CREATE FUNCTION lm_actor_bindings_terminal_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER actor_bindings_terminal_insert BEFORE INSERT ON actor_bindings
FOR EACH ROW EXECUTE FUNCTION lm_actor_bindings_terminal_insert();

-- SQLite trigger: events_terminal_insert
CREATE FUNCTION lm_events_terminal_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER events_terminal_insert BEFORE INSERT ON events
FOR EACH ROW EXECUTE FUNCTION lm_events_terminal_insert();

-- SQLite trigger: quota_accounts_terminal_insert
CREATE FUNCTION lm_quota_accounts_terminal_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quota_accounts_terminal_insert BEFORE INSERT ON quota_accounts
FOR EACH ROW EXECUTE FUNCTION lm_quota_accounts_terminal_insert();

-- SQLite trigger: quota_accounts_terminal_update
CREATE FUNCTION lm_quota_accounts_terminal_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quota_accounts_terminal_update BEFORE UPDATE ON quota_accounts
FOR EACH ROW EXECUTE FUNCTION lm_quota_accounts_terminal_update();

-- SQLite trigger: quota_ledger_terminal_insert
CREATE FUNCTION lm_quota_ledger_terminal_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quota_ledger_terminal_insert BEFORE INSERT ON quota_ledger
FOR EACH ROW EXECUTE FUNCTION lm_quota_ledger_terminal_insert();

-- SQLite trigger: task_requests_terminal_insert
CREATE FUNCTION lm_task_requests_terminal_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER task_requests_terminal_insert BEFORE INSERT ON task_requests
FOR EACH ROW EXECUTE FUNCTION lm_task_requests_terminal_insert();

-- SQLite trigger: task_requests_terminal_update
CREATE FUNCTION lm_task_requests_terminal_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER task_requests_terminal_update BEFORE UPDATE ON task_requests
FOR EACH ROW EXECUTE FUNCTION lm_task_requests_terminal_update();

-- SQLite trigger: investigations_terminal_insert
CREATE FUNCTION lm_investigations_terminal_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER investigations_terminal_insert BEFORE INSERT ON investigations
FOR EACH ROW EXECUTE FUNCTION lm_investigations_terminal_insert();

-- SQLite trigger: investigations_terminal_update
CREATE FUNCTION lm_investigations_terminal_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER investigations_terminal_update BEFORE UPDATE ON investigations
FOR EACH ROW EXECUTE FUNCTION lm_investigations_terminal_update();

-- SQLite trigger: operations_terminal_insert
CREATE FUNCTION lm_operations_terminal_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER operations_terminal_insert BEFORE INSERT ON operations
FOR EACH ROW EXECUTE FUNCTION lm_operations_terminal_insert();

-- SQLite trigger: operations_terminal_update
CREATE FUNCTION lm_operations_terminal_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER operations_terminal_update BEFORE UPDATE ON operations
FOR EACH ROW EXECUTE FUNCTION lm_operations_terminal_update();

-- SQLite trigger: evidence_instances_terminal_insert
CREATE FUNCTION lm_evidence_instances_terminal_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER evidence_instances_terminal_insert BEFORE INSERT ON evidence_instances
FOR EACH ROW EXECUTE FUNCTION lm_evidence_instances_terminal_insert();

-- SQLite trigger: provenance_disclosures_terminal_insert
CREATE FUNCTION lm_provenance_disclosures_terminal_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER provenance_disclosures_terminal_insert BEFORE INSERT ON provenance_disclosures
FOR EACH ROW EXECUTE FUNCTION lm_provenance_disclosures_terminal_insert();

-- SQLite trigger: reports_terminal_insert
CREATE FUNCTION lm_reports_terminal_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reports_terminal_insert BEFORE INSERT ON reports
FOR EACH ROW EXECUTE FUNCTION lm_reports_terminal_insert();

-- SQLite trigger: uploads_terminal_insert
CREATE FUNCTION lm_uploads_terminal_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER uploads_terminal_insert BEFORE INSERT ON uploads
FOR EACH ROW EXECUTE FUNCTION lm_uploads_terminal_insert();

-- SQLite trigger: input_manifests_terminal_insert
CREATE FUNCTION lm_input_manifests_terminal_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER input_manifests_terminal_insert BEFORE INSERT ON input_manifests
FOR EACH ROW EXECUTE FUNCTION lm_input_manifests_terminal_insert();

-- SQLite trigger: input_manifest_members_terminal_insert
CREATE FUNCTION lm_input_manifest_members_terminal_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER input_manifest_members_terminal_insert BEFORE INSERT ON input_manifest_members
FOR EACH ROW EXECUTE FUNCTION lm_input_manifest_members_terminal_insert();

-- SQLite trigger: player_statements_terminal_insert
CREATE FUNCTION lm_player_statements_terminal_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER player_statements_terminal_insert BEFORE INSERT ON player_statements
FOR EACH ROW EXECUTE FUNCTION lm_player_statements_terminal_insert();

-- SQLite trigger: manifest_statements_terminal_insert
CREATE FUNCTION lm_manifest_statements_terminal_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER manifest_statements_terminal_insert BEFORE INSERT ON manifest_statements
FOR EACH ROW EXECUTE FUNCTION lm_manifest_statements_terminal_insert();

-- SQLite trigger: public_records_terminal_insert
CREATE FUNCTION lm_public_records_terminal_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER public_records_terminal_insert BEFORE INSERT ON public_records
FOR EACH ROW EXECUTE FUNCTION lm_public_records_terminal_insert();

-- SQLite trigger: display_receipts_terminal_insert
CREATE FUNCTION lm_display_receipts_terminal_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER display_receipts_terminal_insert BEFORE INSERT ON display_receipts
FOR EACH ROW EXECUTE FUNCTION lm_display_receipts_terminal_insert();

-- SQLite trigger: decision_snapshots_terminal_insert
CREATE FUNCTION lm_decision_snapshots_terminal_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SESSION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER decision_snapshots_terminal_insert BEFORE INSERT ON decision_snapshots
FOR EACH ROW EXECUTE FUNCTION lm_decision_snapshots_terminal_insert();

-- SQLite trigger: task_requests_status_guard
CREATE FUNCTION lm_task_requests_status_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('accepted','running') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='OPERATION_FINAL';
  END IF;
  IF NEW.session_id!=OLD.session_id OR NEW.task_id!=OLD.task_id OR NEW.scene_id!=OLD.scene_id OR NEW.created_at_ms!=OLD.created_at_ms THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='OPERATION_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD.status='running' AND NEW.status='accepted' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='OPERATION_STATUS_REGRESSION';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER task_requests_status_guard BEFORE UPDATE ON task_requests
FOR EACH ROW EXECUTE FUNCTION lm_task_requests_status_guard();

-- SQLite trigger: investigations_status_guard
CREATE FUNCTION lm_investigations_status_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('queued','running') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='OPERATION_FINAL';
  END IF;
  IF NEW.session_id!=OLD.session_id OR NEW.investigation_id!=OLD.investigation_id OR NEW.scene_id!=OLD.scene_id OR NEW.accepted_mission_ms!=OLD.accepted_mission_ms THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='OPERATION_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD.status='running' AND NEW.status='queued' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='OPERATION_STATUS_REGRESSION';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER investigations_status_guard BEFORE UPDATE ON investigations
FOR EACH ROW EXECUTE FUNCTION lm_investigations_status_guard();

-- SQLite trigger: operations_status_guard
CREATE FUNCTION lm_operations_status_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('accepted','running') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='OPERATION_FINAL';
  END IF;
  IF NEW.session_id!=OLD.session_id OR NEW.operation_id!=OLD.operation_id OR NEW.scene_id!=OLD.scene_id OR NEW.accepted_mission_ms!=OLD.accepted_mission_ms THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='OPERATION_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD.status='running' AND NEW.status='accepted' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='OPERATION_STATUS_REGRESSION';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER operations_status_guard BEFORE UPDATE ON operations
FOR EACH ROW EXECUTE FUNCTION lm_operations_status_guard();

-- SQLite trigger: postgame_audit_seal_guard
CREATE FUNCTION lm_postgame_audit_seal_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.category='postgame_audit' THEN
    IF NOT EXISTS(SELECT 1 FROM sessions s JOIN terminal_seals z ON z.session_id=s.session_id AND z.seal_id=s.terminal_seal_id WHERE s.session_id=NEW.session_id AND s.lifecycle IN ('completed','abandoned','interrupted') AND z.sealed_hash=(NEW.payload_json::json ->> 'sealedHash') AND s.session_id=(NEW.payload_json::json ->> 'sessionId') AND NEW.diagnostic_id=(NEW.payload_json::json ->> 'auditId')) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='POSTGAME_AUDIT_SEAL_MISMATCH';
  END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER postgame_audit_seal_guard BEFORE INSERT ON diagnostic_records
FOR EACH ROW EXECUTE FUNCTION lm_postgame_audit_seal_guard();

-- SQLite trigger: diagnostic_records_immutable_update
CREATE FUNCTION lm_diagnostic_records_immutable_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN NEW;
END;
$$;
CREATE TRIGGER diagnostic_records_immutable_update BEFORE UPDATE ON diagnostic_records
FOR EACH ROW EXECUTE FUNCTION lm_diagnostic_records_immutable_update();

-- SQLite trigger: diagnostic_records_immutable_delete
CREATE FUNCTION lm_diagnostic_records_immutable_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IMMUTABLE_RECORD';
  RETURN OLD;
END;
$$;
CREATE TRIGGER diagnostic_records_immutable_delete BEFORE DELETE ON diagnostic_records
FOR EACH ROW EXECUTE FUNCTION lm_diagnostic_records_immutable_delete();

-- SQLite trigger: task_payload_immutable
CREATE FUNCTION lm_task_payload_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.commander_binding_id!=OLD.commander_binding_id OR NEW.target_role!=OLD.target_role OR NEW.task_kind!=OLD.task_kind OR NEW.topic_id!=OLD.topic_id OR NEW.target_id!=OLD.target_id OR NEW.option_id IS DISTINCT FROM OLD.option_id OR NEW.report_reservation_id!=OLD.report_reservation_id OR NEW.accepted_mission_ms!=OLD.accepted_mission_ms OR NEW.due_mission_ms!=OLD.due_mission_ms THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='TASK_PAYLOAD_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER task_payload_immutable BEFORE UPDATE ON task_requests
FOR EACH ROW EXECUTE FUNCTION lm_task_payload_immutable();

-- SQLite trigger: investigation_payload_immutable
CREATE FUNCTION lm_investigation_payload_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.task_id!=OLD.task_id OR NEW.role!=OLD.role OR NEW.option_id!=OLD.option_id OR NEW.resource_key!=OLD.resource_key OR NEW.resource_charge_id!=OLD.resource_charge_id OR NEW.due_mission_ms!=OLD.due_mission_ms THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INVESTIGATION_PAYLOAD_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER investigation_payload_immutable BEFORE UPDATE ON investigations
FOR EACH ROW EXECUTE FUNCTION lm_investigation_payload_immutable();

-- SQLite trigger: operation_payload_immutable
CREATE FUNCTION lm_operation_payload_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operation_kind!=OLD.operation_kind OR NEW.action_id!=OLD.action_id OR NEW.private_plan_json!=OLD.private_plan_json OR NEW.due_mission_ms!=OLD.due_mission_ms THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='OPERATION_PAYLOAD_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER operation_payload_immutable BEFORE UPDATE ON operations
FOR EACH ROW EXECUTE FUNCTION lm_operation_payload_immutable();

INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(1,'initial_engineering_reference',0);
