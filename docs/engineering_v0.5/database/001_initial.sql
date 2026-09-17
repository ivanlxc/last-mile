-- LAST MILE engineering reference schema v0.5.
-- Requires SQLite >= 3.38 (JSON built in). Run on an empty database.
-- Runtime: PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=500.
PRAGMA foreign_keys=ON;
BEGIN IMMEDIATE;
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK(version > 0),
  name TEXT NOT NULL UNIQUE,
  applied_at_ms INTEGER NOT NULL CHECK(applied_at_ms >= 0)
) STRICT;
CREATE TABLE content_versions (
  content_version_id TEXT NOT NULL UNIQUE CHECK(length(content_version_id)=36),
  content_hash TEXT PRIMARY KEY CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  schema_version TEXT NOT NULL,
  registry_json TEXT NOT NULL CHECK(json_valid(registry_json) AND json_type(registry_json)='object'),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0)
) STRICT;
CREATE TABLE policy_profiles (
  policy_hash TEXT PRIMARY KEY CHECK(length(policy_hash)=64 AND policy_hash NOT GLOB '*[^0-9a-f]*'),
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK(profile_version>0),
  approval_status TEXT NOT NULL CHECK(approval_status IN ('review','approved','retired')),
  policy_json TEXT NOT NULL CHECK(json_valid(policy_json) AND json_type(policy_json)='object'),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  UNIQUE(profile_id,profile_version)
) STRICT;
CREATE TABLE launches (
  launch_id TEXT PRIMARY KEY CHECK(length(launch_id)=36),
  token_hash TEXT NOT NULL CHECK(length(token_hash)=64),
  started_at_ms INTEGER NOT NULL CHECK(started_at_ms>=0),
  ended_at_ms INTEGER CHECK(ended_at_ms>=started_at_ms)
) STRICT;
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY CHECK(length(session_id)=36),
  run_epoch TEXT NOT NULL CHECK(length(run_epoch)=36),
  launch_id TEXT NOT NULL REFERENCES launches(launch_id),
  mode TEXT NOT NULL CHECK(mode IN ('normal','demo','test')),
  lifecycle TEXT NOT NULL DEFAULT 'briefing' CHECK(lifecycle IN ('briefing','running','completed','abandoned','interrupted')),
  phase TEXT NOT NULL DEFAULT 'briefing' CHECK(phase IN ('briefing','decision','coordinating','travelling','resolving','terminal')),
  scene_id TEXT,
  content_hash TEXT NOT NULL REFERENCES content_versions(content_hash),
  policy_hash TEXT NOT NULL REFERENCES policy_profiles(policy_hash),
  private_case_id TEXT NOT NULL,
  state_version INTEGER NOT NULL DEFAULT 0 CHECK(state_version>=0),
  inbox_version INTEGER NOT NULL DEFAULT 0 CHECK(inbox_version>=0),
  assistant_context_version INTEGER NOT NULL DEFAULT 0 CHECK(assistant_context_version>=0),
  last_event_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_event_seq>=0),
  mission_ms INTEGER NOT NULL DEFAULT 0 CHECK(mission_ms>=0),
  anchor_monotonic_ms INTEGER,
  world_state_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(world_state_json) AND json_type(world_state_json)='object'),
  terminal_seal_id TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=created_at_ms),
  UNIQUE(session_id,run_epoch),
  UNIQUE(session_id,terminal_seal_id),
  FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(session_id,terminal_seal_id) REFERENCES terminal_seals(session_id,seal_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK((lifecycle IN ('completed','abandoned','interrupted')) = (terminal_seal_id IS NOT NULL)),
  CHECK((lifecycle IN ('completed','abandoned','interrupted')) = (phase='terminal'))
) STRICT;
CREATE TABLE session_scenes (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  scene_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>0),
  entered_mission_ms INTEGER CHECK(entered_mission_ms>=0),
  closed_mission_ms INTEGER CHECK(closed_mission_ms>=entered_mission_ms),
  PRIMARY KEY(session_id,scene_id),
  UNIQUE(session_id,ordinal)
) STRICT;
CREATE TABLE actor_bindings (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  binding_id TEXT NOT NULL CHECK(length(binding_id)=36),
  role TEXT NOT NULL CHECK(role IN ('commander','analyst','liaison')),
  controller_kind TEXT NOT NULL CHECK(controller_kind IN ('human','npc')),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  PRIMARY KEY(session_id,binding_id),
  UNIQUE(session_id,role)
) STRICT;
CREATE TABLE launch_session_access (
  launch_id TEXT NOT NULL REFERENCES launches(launch_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  binding_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK(capability IN ('commander.read','commander.command','evaluation.request','export.request')),
  granted_at_ms INTEGER NOT NULL CHECK(granted_at_ms>=0),
  PRIMARY KEY(launch_id,session_id,capability),
  FOREIGN KEY(session_id,binding_id) REFERENCES actor_bindings(session_id,binding_id)
) STRICT;
CREATE TRIGGER access_grant_guard BEFORE INSERT ON launch_session_access BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM actor_bindings b WHERE b.session_id=NEW.session_id AND b.binding_id=NEW.binding_id AND b.role='commander') THEN RAISE(ABORT,'ACCESS_COMMANDER_BINDING_REQUIRED') END;
 SELECT CASE WHEN NEW.capability='commander.command' AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.session_id=NEW.session_id AND s.launch_id=NEW.launch_id AND s.lifecycle IN ('briefing','running')) THEN RAISE(ABORT,'GAMEPLAY_ACCESS_ORIGINAL_LAUNCH_ONLY') END;
END;
CREATE TRIGGER access_grant_immutable_update BEFORE UPDATE ON launch_session_access BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER access_grant_immutable_delete BEFORE DELETE ON launch_session_access BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TABLE session_creations (
  launch_id TEXT NOT NULL REFERENCES launches(launch_id),
  request_id TEXT NOT NULL CHECK(length(request_id)=36),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(session_id),
  response_json TEXT NOT NULL CHECK(json_valid(response_json) AND json_type(response_json)='object'),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  PRIMARY KEY(launch_id,request_id)
) STRICT;
CREATE TABLE commands (
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK(length(request_id)=36),
  run_epoch TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  command_kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
  accepted_state_version INTEGER NOT NULL CHECK(accepted_state_version>=0),
  response_status INTEGER NOT NULL CHECK(response_status IN (200,201,202,204)),
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  accepted_at_ms INTEGER NOT NULL CHECK(accepted_at_ms>=0),
  PRIMARY KEY(session_id,request_id),
  FOREIGN KEY(session_id,run_epoch) REFERENCES sessions(session_id,run_epoch),
  FOREIGN KEY(session_id,binding_id) REFERENCES actor_bindings(session_id,binding_id)
) STRICT;
CREATE TABLE events (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  seq INTEGER NOT NULL CHECK(seq>0),
  event_id TEXT NOT NULL CHECK(length(event_id)=36),
  kind TEXT NOT NULL,
  mission_ms INTEGER NOT NULL CHECK(mission_ms>=0),
  state_version INTEGER NOT NULL CHECK(state_version>=0),
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','npc','rules','system')),
  binding_id TEXT,
  request_id TEXT CHECK(request_id IS NULL OR length(request_id)=36),
  causation_id TEXT,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json)='object'),
  recorded_at_ms INTEGER NOT NULL CHECK(recorded_at_ms>=0),
  PRIMARY KEY(session_id,seq),
  UNIQUE(session_id,event_id),
  FOREIGN KEY(session_id,binding_id) REFERENCES actor_bindings(session_id,binding_id),
  FOREIGN KEY(session_id,causation_id) REFERENCES events(session_id,event_id)
) STRICT;
CREATE INDEX ix_events_request ON events(session_id,request_id) WHERE request_id IS NOT NULL;
CREATE TABLE view_events (
  session_id TEXT NOT NULL,
  view_role TEXT NOT NULL CHECK(view_role IN ('commander','analyst','liaison')),
  cursor INTEGER NOT NULL CHECK(cursor>0),
  source_seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  public_payload_json TEXT NOT NULL CHECK(json_valid(public_payload_json) AND json_type(public_payload_json)='object'),
  PRIMARY KEY(session_id,view_role,cursor),
  FOREIGN KEY(session_id,source_seq) REFERENCES events(session_id,seq)
) STRICT;
CREATE TABLE quota_accounts (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  account_id TEXT NOT NULL CHECK(length(account_id)=36),
  quota_scope TEXT NOT NULL CHECK(quota_scope IN ('session','scene')),
  scene_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('analyst','liaison','commander')),
  resource TEXT NOT NULL CHECK(resource IN ('satellite','drone','localAgency','witness','report','upload')),
  capacity INTEGER NOT NULL CHECK(capacity>=0),
  available INTEGER NOT NULL CHECK(available>=0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0),
  spent INTEGER NOT NULL DEFAULT 0 CHECK(spent>=0),
  account_version INTEGER NOT NULL DEFAULT 0 CHECK(account_version>=0),
  last_entry_id TEXT,
  PRIMARY KEY(session_id,account_id),
  FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id),
  FOREIGN KEY(session_id,last_entry_id) REFERENCES quota_ledger(session_id,entry_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK(available+reserved+spent=capacity),
  CHECK((quota_scope='session' AND scene_id IS NULL AND resource IN ('satellite','drone','localAgency','witness')) OR (quota_scope='scene' AND scene_id IS NOT NULL AND resource IN ('report','upload'))),
  CHECK((resource IN ('satellite','drone') AND role='analyst') OR (resource IN ('localAgency','witness') AND role='liaison') OR (resource='report' AND role IN ('analyst','liaison')) OR (resource='upload' AND role='commander')),
  CHECK((resource='satellite' AND capacity=2) OR (resource='drone' AND capacity=3) OR (resource='localAgency' AND capacity=3) OR (resource='witness' AND capacity=2) OR resource IN ('report','upload'))
) STRICT;
CREATE UNIQUE INDEX ux_quota_session ON quota_accounts(session_id,role,resource) WHERE quota_scope='session';
CREATE UNIQUE INDEX ux_quota_scene ON quota_accounts(session_id,scene_id,role,resource) WHERE quota_scope='scene';
CREATE TABLE quota_ledger (
  session_id TEXT NOT NULL,
  entry_id TEXT NOT NULL CHECK(length(entry_id)=36),
  account_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK(length(operation_id)=36),
  entry_kind TEXT NOT NULL CHECK(entry_kind IN ('reserve','spend','release','refund')),
  source_bucket TEXT NOT NULL CHECK(source_bucket IN ('available','reserved','spent')),
  amount INTEGER NOT NULL CHECK(amount>0),
  delta_available INTEGER NOT NULL,
  delta_reserved INTEGER NOT NULL,
  delta_spent INTEGER NOT NULL,
  account_version_before INTEGER NOT NULL CHECK(account_version_before>=0),
  parent_entry_id TEXT,
  reason_code TEXT NOT NULL,
  mission_ms INTEGER NOT NULL CHECK(mission_ms>=0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  PRIMARY KEY(session_id,entry_id),
  UNIQUE(session_id,operation_id,account_id,entry_kind,source_bucket),
  FOREIGN KEY(session_id,account_id) REFERENCES quota_accounts(session_id,account_id),
  FOREIGN KEY(session_id,parent_entry_id) REFERENCES quota_ledger(session_id,entry_id),
  CHECK((entry_kind='reserve' AND source_bucket='available' AND parent_entry_id IS NULL AND delta_available=-amount AND delta_reserved=amount AND delta_spent=0)
     OR (entry_kind='spend' AND source_bucket='available' AND parent_entry_id IS NULL AND delta_available=-amount AND delta_reserved=0 AND delta_spent=amount)
     OR (entry_kind='spend' AND source_bucket='reserved' AND parent_entry_id IS NOT NULL AND delta_available=0 AND delta_reserved=-amount AND delta_spent=amount)
     OR (entry_kind='release' AND source_bucket='reserved' AND parent_entry_id IS NOT NULL AND delta_available=amount AND delta_reserved=-amount AND delta_spent=0)
     OR (entry_kind='refund' AND source_bucket='spent' AND parent_entry_id IS NOT NULL AND delta_available=amount AND delta_reserved=0 AND delta_spent=-amount))
) STRICT;
CREATE INDEX ix_ledger_account ON quota_ledger(session_id,account_id,created_at_ms);
CREATE INDEX ix_ledger_parent ON quota_ledger(session_id,parent_entry_id) WHERE parent_entry_id IS NOT NULL;
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
  accepted_mission_ms INTEGER NOT NULL CHECK(accepted_mission_ms>=0),
  due_mission_ms INTEGER NOT NULL CHECK(due_mission_ms>=accepted_mission_ms),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  completed_at_ms INTEGER CHECK(completed_at_ms>=created_at_ms),
  failure_code TEXT,
  PRIMARY KEY(session_id,task_id),
  FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id),
  FOREIGN KEY(session_id,commander_binding_id) REFERENCES actor_bindings(session_id,binding_id),
  UNIQUE(session_id,report_reservation_id),
  FOREIGN KEY(session_id,report_reservation_id) REFERENCES quota_ledger(session_id,entry_id),
  CHECK((status IN ('completed','cancelled','failed'))=(completed_at_ms IS NOT NULL)),
  CHECK(task_kind!='investigate_and_report' OR option_id IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX ux_task_active_role ON task_requests(session_id,target_role) WHERE status IN ('accepted','running');
CREATE INDEX ix_task_due ON task_requests(session_id,due_mission_ms) WHERE status IN ('accepted','running');
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
  accepted_mission_ms INTEGER NOT NULL CHECK(accepted_mission_ms>=0),
  due_mission_ms INTEGER NOT NULL CHECK(due_mission_ms>=accepted_mission_ms),
  finished_mission_ms INTEGER CHECK(finished_mission_ms>=accepted_mission_ms),
  failure_code TEXT,
  PRIMARY KEY(session_id,investigation_id),
  UNIQUE(session_id,task_id),
  UNIQUE(session_id,resource_charge_id),
  FOREIGN KEY(session_id,task_id) REFERENCES task_requests(session_id,task_id),
  FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id),
  FOREIGN KEY(session_id,resource_charge_id) REFERENCES quota_ledger(session_id,entry_id),
  CHECK((status IN ('completed','cancelled','failed'))=(finished_mission_ms IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX ux_investigation_active_role ON investigations(session_id,role) WHERE status IN ('queued','running');
CREATE INDEX ix_investigation_due ON investigations(session_id,due_mission_ms) WHERE status IN ('queued','running');
CREATE TABLE operations (
  session_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK(length(operation_id)=36),
  scene_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK(operation_kind IN ('action','wait')),
  action_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted' CHECK(status IN ('accepted','running','completed','cancelled','failed')),
  private_plan_json TEXT NOT NULL CHECK(json_valid(private_plan_json) AND json_type(private_plan_json)='object'),
  public_progress_json TEXT NOT NULL CHECK(json_valid(public_progress_json) AND json_type(public_progress_json)='object'),
  accepted_mission_ms INTEGER NOT NULL CHECK(accepted_mission_ms>=0),
  due_mission_ms INTEGER NOT NULL CHECK(due_mission_ms>=accepted_mission_ms),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  completed_at_ms INTEGER CHECK(completed_at_ms>=created_at_ms),
  PRIMARY KEY(session_id,operation_id),
  FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id),
  CHECK((status IN ('completed','cancelled','failed'))=(completed_at_ms IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX ux_operation_active ON operations(session_id) WHERE status IN ('accepted','running');
CREATE TABLE evidence_instances (
  session_id TEXT NOT NULL,
  instance_id TEXT NOT NULL CHECK(length(instance_id)=36),
  revision INTEGER NOT NULL CHECK(revision>0),
  scene_id TEXT NOT NULL,
  owner_role TEXT NOT NULL CHECK(owner_role IN ('analyst','liaison')),
  private_definition_id TEXT NOT NULL,
  observation_type TEXT NOT NULL CHECK(observation_type IN ('directObservation','reportedStatement','provenanceFinding','historicalRecord')),
  acquired_mission_ms INTEGER NOT NULL CHECK(acquired_mission_ms>=0),
  observed_mission_ms INTEGER,
  acquisition_investigation_id TEXT,
  supersedes_instance_id TEXT,
  supersedes_revision INTEGER,
  public_payload_json TEXT NOT NULL CHECK(json_valid(public_payload_json) AND json_type(public_payload_json)='object'),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
  PRIMARY KEY(session_id,instance_id,revision),
  FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id),
  FOREIGN KEY(session_id,acquisition_investigation_id) REFERENCES investigations(session_id,investigation_id),
  FOREIGN KEY(session_id,supersedes_instance_id,supersedes_revision) REFERENCES evidence_instances(session_id,instance_id,revision),
  CHECK((supersedes_instance_id IS NULL)=(supersedes_revision IS NULL)),
  CHECK(supersedes_instance_id IS NULL OR supersedes_instance_id!=instance_id OR supersedes_revision<revision)
) STRICT;
CREATE INDEX ix_evidence_inventory ON evidence_instances(session_id,owner_role,scene_id,acquired_mission_ms);
CREATE TABLE provenance_disclosures (
  session_id TEXT NOT NULL,
  finding_id TEXT NOT NULL CHECK(length(finding_id)=36),
  evidence_instance_id TEXT NOT NULL,
  evidence_revision INTEGER NOT NULL,
  subject_instance_id TEXT NOT NULL,
  subject_revision INTEGER NOT NULL,
  relation_type TEXT NOT NULL CHECK(relation_type IN ('sourceIdentityChecked','firstHandOrHearsay','sharedRootConfirmed','contentCorroborated')),
  verification_state TEXT NOT NULL CHECK(verification_state IN ('unknown','reported','hypothesized','verified')),
  public_relation_json TEXT NOT NULL CHECK(json_valid(public_relation_json) AND json_type(public_relation_json)='object'),
  PRIMARY KEY(session_id,finding_id),
  FOREIGN KEY(session_id,evidence_instance_id,evidence_revision) REFERENCES evidence_instances(session_id,instance_id,revision),
  FOREIGN KEY(session_id,subject_instance_id,subject_revision) REFERENCES evidence_instances(session_id,instance_id,revision)
) STRICT;
CREATE TABLE reports (
  session_id TEXT NOT NULL,
  report_id TEXT NOT NULL CHECK(length(report_id)=36),
  scene_id TEXT NOT NULL,
  sender_role TEXT NOT NULL CHECK(sender_role IN ('analyst','liaison')),
  source_instance_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  actor_binding_id TEXT NOT NULL,
  task_id TEXT,
  charge_entry_id TEXT NOT NULL,
  reported_mission_ms INTEGER NOT NULL CHECK(reported_mission_ms>=0),
  immutable_payload_json TEXT NOT NULL CHECK(json_valid(immutable_payload_json) AND json_type(immutable_payload_json)='object'),
  immutable_payload_hash TEXT NOT NULL CHECK(length(immutable_payload_hash)=64),
  PRIMARY KEY(session_id,report_id),
  UNIQUE(session_id,scene_id,source_instance_id,source_revision),
  UNIQUE(session_id,report_id,source_revision),
  UNIQUE(session_id,task_id),
  FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id),
  FOREIGN KEY(session_id,source_instance_id,source_revision) REFERENCES evidence_instances(session_id,instance_id,revision),
  FOREIGN KEY(session_id,actor_binding_id) REFERENCES actor_bindings(session_id,binding_id),
  FOREIGN KEY(session_id,task_id) REFERENCES task_requests(session_id,task_id),
  FOREIGN KEY(session_id,charge_entry_id) REFERENCES quota_ledger(session_id,entry_id)
) STRICT;
CREATE INDEX ix_reports_charge ON reports(session_id,charge_entry_id);
CREATE INDEX ix_reports_commander ON reports(session_id,scene_id,reported_mission_ms);
CREATE TABLE uploads (
  session_id TEXT NOT NULL,
  upload_id TEXT NOT NULL CHECK(length(upload_id)=36),
  scene_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  report_revision INTEGER NOT NULL,
  charge_entry_id TEXT NOT NULL,
  authorization_binding_id TEXT NOT NULL,
  uploaded_mission_ms INTEGER NOT NULL CHECK(uploaded_mission_ms>=0),
  PRIMARY KEY(session_id,upload_id),
  UNIQUE(session_id,scene_id,report_id,report_revision),
  FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id),
  FOREIGN KEY(session_id,report_id,report_revision) REFERENCES reports(session_id,report_id,source_revision),
  FOREIGN KEY(session_id,charge_entry_id) REFERENCES quota_ledger(session_id,entry_id),
  FOREIGN KEY(session_id,authorization_binding_id) REFERENCES actor_bindings(session_id,binding_id)
) STRICT;
CREATE INDEX ix_uploads_charge ON uploads(session_id,charge_entry_id);
CREATE TABLE input_manifests (
  session_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL CHECK(length(manifest_id)=36),
  scene_id TEXT NOT NULL,
  inbox_version INTEGER NOT NULL CHECK(inbox_version>=0),
  context_version INTEGER NOT NULL CHECK(context_version>=0),
  context_epoch TEXT NOT NULL CHECK(length(context_epoch)=36),
  background_hash TEXT NOT NULL CHECK(length(background_hash)=64),
  input_hash TEXT NOT NULL CHECK(length(input_hash)=64),
  permitted_input_json TEXT NOT NULL CHECK(json_valid(permitted_input_json) AND json_type(permitted_input_json)='object'),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  PRIMARY KEY(session_id,manifest_id),
  UNIQUE(session_id,scene_id,context_version),
  FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id)
) STRICT;
CREATE TABLE input_manifest_members (
  session_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  PRIMARY KEY(session_id,manifest_id,upload_id),
  FOREIGN KEY(session_id,manifest_id) REFERENCES input_manifests(session_id,manifest_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(session_id,upload_id) REFERENCES uploads(session_id,upload_id)
) STRICT;
CREATE TABLE player_statements (
  session_id TEXT NOT NULL,
  statement_id TEXT NOT NULL CHECK(length(statement_id)=36),
  scene_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  statement_text TEXT NOT NULL CHECK(length(statement_text) BETWEEN 1 AND 2000),
  trust TEXT NOT NULL DEFAULT 'unverified' CHECK(trust='unverified'),
  created_mission_ms INTEGER NOT NULL CHECK(created_mission_ms>=0),
  PRIMARY KEY(session_id,statement_id),
  FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id),
  FOREIGN KEY(session_id,binding_id) REFERENCES actor_bindings(session_id,binding_id)
) STRICT;
CREATE TABLE manifest_statements (
  session_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  PRIMARY KEY(session_id,manifest_id,statement_id),
  FOREIGN KEY(session_id,manifest_id) REFERENCES input_manifests(session_id,manifest_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(session_id,statement_id) REFERENCES player_statements(session_id,statement_id)
) STRICT;
CREATE TABLE agent_jobs (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  job_id TEXT NOT NULL CHECK(length(job_id)=36),
  agent_role TEXT NOT NULL CHECK(agent_role IN ('advisor','evaluator')),
  scene_id TEXT,
  manifest_id TEXT,
  seal_hash TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','fallback','failed','cancelled','superseded')),
  mode TEXT NOT NULL CHECK(mode IN ('live_model','offline_template')),
  input_hash TEXT NOT NULL CHECK(length(input_hash)=64),
  config_hash TEXT NOT NULL CHECK(length(config_hash)=64),
  input_version INTEGER NOT NULL CHECK(input_version>=1),
  inbox_version INTEGER,
  context_version INTEGER,
  evaluator_input_json TEXT CHECK(evaluator_input_json IS NULL OR (json_valid(evaluator_input_json) AND json_type(evaluator_input_json)='object')),
  max_attempts INTEGER NOT NULL DEFAULT 2 CHECK(max_attempts BETWEEN 1 AND 2),
  deadline_at_ms INTEGER NOT NULL CHECK(deadline_at_ms>=0),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  error_code TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=created_at_ms),
  PRIMARY KEY(session_id,job_id),
  FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id),
  FOREIGN KEY(session_id,manifest_id) REFERENCES input_manifests(session_id,manifest_id),
  FOREIGN KEY(session_id,seal_hash) REFERENCES terminal_seals(session_id,sealed_hash),
  CHECK((agent_role='advisor' AND scene_id IS NOT NULL AND manifest_id IS NOT NULL AND seal_hash IS NULL AND inbox_version IS NOT NULL AND context_version IS NOT NULL AND evaluator_input_json IS NULL)
     OR (agent_role='evaluator' AND scene_id IS NULL AND manifest_id IS NULL AND seal_hash IS NOT NULL AND inbox_version IS NULL AND context_version IS NULL AND evaluator_input_json IS NOT NULL)),
  CHECK(status NOT IN ('succeeded','fallback') OR result_json IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX ux_advisor_input ON agent_jobs(session_id,scene_id,context_version,input_hash,config_hash) WHERE agent_role='advisor';
CREATE UNIQUE INDEX ux_evaluator_seal_config ON agent_jobs(session_id,seal_hash,config_hash) WHERE agent_role='evaluator';
CREATE UNIQUE INDEX ux_advisor_active ON agent_jobs(session_id) WHERE agent_role='advisor' AND status IN ('queued','running');
CREATE UNIQUE INDEX ux_evaluator_active ON agent_jobs(session_id,seal_hash,config_hash) WHERE agent_role='evaluator' AND status IN ('queued','running');
CREATE INDEX ix_agent_jobs_dispatch ON agent_jobs(status,deadline_at_ms) WHERE status IN ('queued','running');
CREATE TABLE agent_attempts (
  session_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK(attempt_no>0),
  request_key TEXT NOT NULL CHECK(length(request_key)=36),
  status TEXT NOT NULL DEFAULT 'sending' CHECK(status IN ('sending','running','succeeded','failed','timeout','unknown')),
  sent_at_ms INTEGER NOT NULL CHECK(sent_at_ms>=0),
  finished_at_ms INTEGER CHECK(finished_at_ms>=sent_at_ms),
  provider_request_id TEXT,
  input_tokens INTEGER CHECK(input_tokens>=0),
  output_tokens INTEGER CHECK(output_tokens>=0),
  billed_microunits INTEGER CHECK(billed_microunits>=0),
  error_code TEXT,
  response_hash TEXT CHECK(response_hash IS NULL OR length(response_hash)=64),
  PRIMARY KEY(session_id,job_id,attempt_no),
  UNIQUE(request_key),
  FOREIGN KEY(session_id,job_id) REFERENCES agent_jobs(session_id,job_id),
  CHECK((status IN ('succeeded','failed','timeout','unknown'))=(finished_at_ms IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX ux_attempt_active ON agent_attempts(session_id,job_id) WHERE status IN ('sending','running');
CREATE TABLE public_records (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  public_record_id TEXT NOT NULL CHECK(length(public_record_id)=36),
  revision INTEGER NOT NULL CHECK(revision>0),
  view_role TEXT NOT NULL CHECK(view_role IN ('commander','analyst','liaison','all')),
  record_kind TEXT NOT NULL CHECK(record_kind IN ('report','advice','briefing','sceneFeedback')),
  source_seq INTEGER NOT NULL,
  public_payload_json TEXT NOT NULL CHECK(json_valid(public_payload_json) AND json_type(public_payload_json)='object'),
  PRIMARY KEY(session_id,public_record_id,revision),
  FOREIGN KEY(session_id,source_seq) REFERENCES events(session_id,seq)
) STRICT;
CREATE TABLE display_receipts (
  session_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL CHECK(length(receipt_id)=36),
  binding_id TEXT NOT NULL,
  public_record_id TEXT NOT NULL,
  record_revision INTEGER NOT NULL,
  receipt_kind TEXT NOT NULL CHECK(receipt_kind IN ('displayed','opened','usedInReason')),
  recorded_mission_ms INTEGER NOT NULL CHECK(recorded_mission_ms>=0),
  received_at_ms INTEGER NOT NULL CHECK(received_at_ms>=0),
  PRIMARY KEY(session_id,receipt_id),
  UNIQUE(session_id,binding_id,public_record_id,record_revision,receipt_kind),
  FOREIGN KEY(session_id,binding_id) REFERENCES actor_bindings(session_id,binding_id),
  FOREIGN KEY(session_id,public_record_id,record_revision) REFERENCES public_records(session_id,public_record_id,revision)
) STRICT;
CREATE TABLE decision_snapshots (
  session_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL CHECK(length(snapshot_id)=36),
  scene_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  snapshot_kind TEXT NOT NULL CHECK(snapshot_kind IN ('task','investigation','report','upload','action')),
  source_seq INTEGER NOT NULL,
  mission_ms INTEGER NOT NULL CHECK(mission_ms>=0),
  state_version INTEGER NOT NULL CHECK(state_version>=0),
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND json_type(snapshot_json)='object'),
  PRIMARY KEY(session_id,snapshot_id),
  FOREIGN KEY(session_id,scene_id) REFERENCES session_scenes(session_id,scene_id),
  FOREIGN KEY(session_id,binding_id) REFERENCES actor_bindings(session_id,binding_id),
  FOREIGN KEY(session_id,source_seq) REFERENCES events(session_id,seq)
) STRICT;
CREATE TABLE terminal_seals (
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(session_id),
  seal_id TEXT NOT NULL CHECK(length(seal_id)=36),
  sealed_hash TEXT NOT NULL CHECK(length(sealed_hash)=64 AND sealed_hash NOT GLOB '*[^0-9a-f]*'),
  terminal_lifecycle TEXT NOT NULL CHECK(terminal_lifecycle IN ('completed','abandoned','interrupted')),
  terminal_seq INTEGER NOT NULL,
  terminal_state_version INTEGER NOT NULL CHECK(terminal_state_version>0),
  terminal_mission_ms INTEGER NOT NULL CHECK(terminal_mission_ms>=0),
  outcome_json TEXT NOT NULL CHECK(json_valid(outcome_json) AND json_type(outcome_json)='object'),
  immutable_behavior_json TEXT NOT NULL CHECK(json_valid(immutable_behavior_json) AND json_type(immutable_behavior_json)='object'),
  content_hash TEXT NOT NULL REFERENCES content_versions(content_hash),
  policy_hash TEXT NOT NULL REFERENCES policy_profiles(policy_hash),
  sealed_at_ms INTEGER NOT NULL CHECK(sealed_at_ms>=0),
  PRIMARY KEY(session_id,seal_id),
  UNIQUE(session_id,sealed_hash),
  FOREIGN KEY(session_id,terminal_seq) REFERENCES events(session_id,seq),
  FOREIGN KEY(session_id,seal_id) REFERENCES sessions(session_id,terminal_seal_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE behavior_facts (
  session_id TEXT NOT NULL,
  fact_id TEXT NOT NULL CHECK(length(fact_id)=36),
  seal_hash TEXT NOT NULL,
  context_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  subject_binding_id TEXT NOT NULL,
  cutoff_seq INTEGER NOT NULL,
  cutoff_state_version INTEGER NOT NULL CHECK(cutoff_state_version>=0),
  fact_payload_json TEXT NOT NULL CHECK(json_valid(fact_payload_json) AND json_type(fact_payload_json)='object'),
  visible_refs_json TEXT NOT NULL CHECK(json_valid(visible_refs_json) AND json_type(visible_refs_json)='array'),
  PRIMARY KEY(session_id,fact_id),
  UNIQUE(session_id,seal_hash,context_id,rule_id,subject_binding_id),
  FOREIGN KEY(session_id,seal_hash) REFERENCES terminal_seals(session_id,sealed_hash),
  FOREIGN KEY(session_id,context_id) REFERENCES decision_snapshots(session_id,snapshot_id),
  FOREIGN KEY(session_id,subject_binding_id) REFERENCES actor_bindings(session_id,binding_id),
  FOREIGN KEY(session_id,cutoff_seq) REFERENCES events(session_id,seq)
) STRICT;
CREATE TABLE evaluation_reports (
  session_id TEXT NOT NULL,
  evaluation_id TEXT NOT NULL CHECK(length(evaluation_id)=36),
  job_id TEXT NOT NULL,
  sealed_hash TEXT NOT NULL,
  config_hash TEXT NOT NULL CHECK(length(config_hash)=64),
  revision INTEGER NOT NULL CHECK(revision>0),
  mode TEXT NOT NULL CHECK(mode IN ('live_model','offline_template')),
  report_json TEXT NOT NULL CHECK(json_valid(report_json) AND json_type(report_json)='object'),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  PRIMARY KEY(session_id,evaluation_id),
  UNIQUE(session_id,sealed_hash,config_hash,revision),
  FOREIGN KEY(session_id,job_id) REFERENCES agent_jobs(session_id,job_id),
  FOREIGN KEY(session_id,sealed_hash) REFERENCES terminal_seals(session_id,sealed_hash)
) STRICT;
CREATE TABLE export_jobs (
  session_id TEXT NOT NULL,
  export_id TEXT NOT NULL CHECK(length(export_id)=36),
  sealed_hash TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK(length(request_id)=36),
  export_kind TEXT NOT NULL CHECK(export_kind IN ('public_replay','team_spoilers','diagnostics')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
  relative_output_path TEXT CHECK(relative_output_path IS NULL OR (relative_output_path NOT LIKE '/%' AND instr(relative_output_path,'..')=0)),
  output_hash TEXT CHECK(output_hash IS NULL OR length(output_hash)=64),
  error_code TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  completed_at_ms INTEGER CHECK(completed_at_ms>=created_at_ms),
  PRIMARY KEY(session_id,export_id),
  UNIQUE(session_id,request_id),
  FOREIGN KEY(session_id,sealed_hash) REFERENCES terminal_seals(session_id,sealed_hash),
  CHECK(status!='completed' OR (relative_output_path IS NOT NULL AND output_hash IS NOT NULL AND completed_at_ms IS NOT NULL))
) STRICT;
-- Business constraints that cannot be represented by a row CHECK.
CREATE TRIGGER sessions_insert_policy BEFORE INSERT ON sessions BEGIN
  SELECT CASE WHEN NEW.mode='normal' AND (SELECT approval_status FROM policy_profiles WHERE policy_hash=NEW.policy_hash)!='approved' THEN RAISE(ABORT,'POLICY_NOT_APPROVED') END;
  SELECT CASE WHEN NEW.lifecycle!='briefing' OR NEW.terminal_seal_id IS NOT NULL THEN RAISE(ABORT,'INITIAL_SESSION_STATE') END;
END;
CREATE TRIGGER sessions_update_guard BEFORE UPDATE ON sessions BEGIN
  SELECT CASE WHEN OLD.lifecycle IN ('completed','abandoned','interrupted') THEN RAISE(ABORT,'SESSION_TERMINAL') END;
  SELECT CASE WHEN NEW.session_id!=OLD.session_id OR NEW.run_epoch!=OLD.run_epoch OR NEW.launch_id!=OLD.launch_id OR NEW.content_hash!=OLD.content_hash OR NEW.policy_hash!=OLD.policy_hash OR NEW.private_case_id!=OLD.private_case_id OR NEW.mode!=OLD.mode THEN RAISE(ABORT,'SESSION_IDENTITY_IMMUTABLE') END;
  SELECT CASE WHEN NEW.state_version<OLD.state_version OR NEW.state_version>OLD.state_version+1 OR NEW.inbox_version<OLD.inbox_version OR NEW.assistant_context_version<OLD.assistant_context_version OR NEW.mission_ms<OLD.mission_ms THEN RAISE(ABORT,'STATE_VERSION_OR_TIME_REGRESSION') END;
  SELECT CASE WHEN NEW.lifecycle IN ('completed','abandoned','interrupted') AND NOT EXISTS(SELECT 1 FROM terminal_seals z WHERE z.session_id=NEW.session_id AND z.seal_id=NEW.terminal_seal_id AND z.terminal_lifecycle=NEW.lifecycle AND z.terminal_state_version=NEW.state_version AND z.terminal_mission_ms=NEW.mission_ms AND z.terminal_seq=NEW.last_event_seq) THEN RAISE(ABORT,'TERMINAL_SEAL_MISMATCH') END;
END;
CREATE TRIGGER event_sequence BEFORE INSERT ON events BEGIN
  SELECT CASE WHEN NEW.seq!=(SELECT last_event_seq+1 FROM sessions WHERE session_id=NEW.session_id) THEN RAISE(ABORT,'EVENT_SEQUENCE_CONFLICT') END;
END;
CREATE TRIGGER event_sequence_advance AFTER INSERT ON events BEGIN
  UPDATE sessions SET last_event_seq=NEW.seq WHERE session_id=NEW.session_id;
END;
CREATE TRIGGER view_cursor BEFORE INSERT ON view_events BEGIN
  SELECT CASE WHEN NEW.cursor!=COALESCE((SELECT MAX(cursor)+1 FROM view_events WHERE session_id=NEW.session_id AND view_role=NEW.view_role),1) THEN RAISE(ABORT,'VIEW_CURSOR_CONFLICT') END;
END;
CREATE TRIGGER quota_account_initial BEFORE INSERT ON quota_accounts BEGIN
  SELECT CASE WHEN NEW.available!=NEW.capacity OR NEW.reserved!=0 OR NEW.spent!=0 OR NEW.account_version!=0 OR NEW.last_entry_id IS NOT NULL THEN RAISE(ABORT,'QUOTA_ACCOUNT_INITIAL') END;
  SELECT CASE WHEN NEW.resource='report' AND NEW.capacity!=COALESCE((SELECT json_extract(p.policy_json,'$.reportLimitPerRolePerScene') FROM sessions s JOIN policy_profiles p USING(policy_hash) WHERE s.session_id=NEW.session_id),-1) THEN RAISE(ABORT,'REPORT_CAPACITY_POLICY') END;
  SELECT CASE WHEN NEW.resource='upload' AND NEW.capacity!=COALESCE((SELECT json_extract(p.policy_json,'$.uploadLimitPerScene') FROM sessions s JOIN policy_profiles p USING(policy_hash) WHERE s.session_id=NEW.session_id),-1) THEN RAISE(ABORT,'UPLOAD_CAPACITY_POLICY') END;
END;
CREATE TRIGGER quota_ledger_guard BEFORE INSERT ON quota_ledger BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM quota_accounts q WHERE q.session_id=NEW.session_id AND q.account_id=NEW.account_id AND q.account_version=NEW.account_version_before AND q.available+NEW.delta_available>=0 AND q.reserved+NEW.delta_reserved>=0 AND q.spent+NEW.delta_spent>=0) THEN RAISE(ABORT,'QUOTA_EXHAUSTED_OR_STALE') END;
  SELECT CASE WHEN NEW.parent_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM quota_ledger p WHERE p.session_id=NEW.session_id AND p.entry_id=NEW.parent_entry_id AND p.account_id=NEW.account_id AND p.entry_kind=CASE WHEN NEW.entry_kind='refund' THEN 'spend' ELSE 'reserve' END AND p.amount>=NEW.amount+COALESCE((SELECT SUM(c.amount) FROM quota_ledger c WHERE c.session_id=NEW.session_id AND c.parent_entry_id=p.entry_id),0)) THEN RAISE(ABORT,'QUOTA_PARENT_OVERDRAW') END;
END;
CREATE TRIGGER quota_account_mutation_guard BEFORE UPDATE ON quota_accounts BEGIN
  SELECT CASE WHEN NEW.capacity!=OLD.capacity OR NEW.resource!=OLD.resource OR NEW.quota_scope!=OLD.quota_scope OR NEW.scene_id IS NOT OLD.scene_id OR NEW.role!=OLD.role OR NEW.account_id!=OLD.account_id OR NEW.session_id!=OLD.session_id THEN RAISE(ABORT,'QUOTA_IDENTITY_IMMUTABLE') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM quota_ledger l WHERE l.session_id=OLD.session_id AND l.account_id=OLD.account_id AND l.entry_id=NEW.last_entry_id AND l.account_version_before=OLD.account_version AND NEW.account_version=OLD.account_version+1 AND NEW.available=OLD.available+l.delta_available AND NEW.reserved=OLD.reserved+l.delta_reserved AND NEW.spent=OLD.spent+l.delta_spent) THEN RAISE(ABORT,'QUOTA_DIRECT_UPDATE_FORBIDDEN') END;
END;
CREATE TRIGGER quota_apply AFTER INSERT ON quota_ledger BEGIN
  UPDATE quota_accounts SET available=available+NEW.delta_available,reserved=reserved+NEW.delta_reserved,spent=spent+NEW.delta_spent,account_version=account_version+1,last_entry_id=NEW.entry_id WHERE session_id=NEW.session_id AND account_id=NEW.account_id;
END;
CREATE TRIGGER task_authorization BEFORE INSERT ON task_requests BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM actor_bindings b WHERE b.session_id=NEW.session_id AND b.binding_id=NEW.commander_binding_id AND b.role='commander') THEN RAISE(ABORT,'TASK_COMMANDER_REQUIRED') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM quota_ledger l JOIN quota_accounts q ON q.session_id=l.session_id AND q.account_id=l.account_id WHERE l.session_id=NEW.session_id AND l.entry_id=NEW.report_reservation_id AND l.entry_kind='reserve' AND l.amount=1 AND q.resource='report' AND q.role=NEW.target_role AND q.scene_id=NEW.scene_id) THEN RAISE(ABORT,'TASK_REPORT_RESERVATION_REQUIRED') END;
END;
CREATE TRIGGER investigation_authorization BEFORE INSERT ON investigations BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM task_requests t WHERE t.session_id=NEW.session_id AND t.task_id=NEW.task_id AND t.target_role=NEW.role AND t.scene_id=NEW.scene_id AND t.task_kind='investigate_and_report' AND t.option_id=NEW.option_id) THEN RAISE(ABORT,'INVESTIGATION_TASK_MISMATCH') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM quota_ledger l JOIN quota_accounts q ON q.session_id=l.session_id AND q.account_id=l.account_id WHERE l.session_id=NEW.session_id AND l.entry_id=NEW.resource_charge_id AND l.entry_kind='spend' AND l.amount=1 AND q.role=NEW.role AND q.resource=NEW.resource_key AND q.quota_scope='session') THEN RAISE(ABORT,'INVESTIGATION_RESOURCE_CHARGE_REQUIRED') END;
END;
CREATE TRIGGER evidence_acquisition_guard BEFORE INSERT ON evidence_instances WHEN NEW.acquisition_investigation_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM investigations i WHERE i.session_id=NEW.session_id AND i.investigation_id=NEW.acquisition_investigation_id AND i.role=NEW.owner_role AND i.scene_id=NEW.scene_id AND i.status='completed' AND NEW.acquired_mission_ms>=i.due_mission_ms) THEN RAISE(ABORT,'EVIDENCE_NOT_OBSERVED') END;
END;
CREATE TRIGGER report_guard BEFORE INSERT ON reports BEGIN
  SELECT CASE WHEN NEW.task_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM task_requests t JOIN quota_ledger l ON l.session_id=t.session_id AND l.entry_id=NEW.charge_entry_id WHERE t.session_id=NEW.session_id AND t.task_id=NEW.task_id AND t.scene_id=NEW.scene_id AND t.target_role=NEW.sender_role AND t.status IN ('accepted','running') AND l.parent_entry_id=t.report_reservation_id AND l.entry_kind='spend' AND l.source_bucket='reserved') THEN RAISE(ABORT,'REPORT_TASK_MISMATCH') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM evidence_instances e WHERE e.session_id=NEW.session_id AND e.instance_id=NEW.source_instance_id AND e.revision=NEW.source_revision AND e.owner_role=NEW.sender_role AND e.scene_id=NEW.scene_id AND e.payload_hash=NEW.immutable_payload_hash AND e.public_payload_json=NEW.immutable_payload_json) THEN RAISE(ABORT,'REPORT_SOURCE_MISMATCH') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM actor_bindings b WHERE b.session_id=NEW.session_id AND b.binding_id=NEW.actor_binding_id AND b.role=NEW.sender_role) THEN RAISE(ABORT,'REPORT_ROLE_FORBIDDEN') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM quota_ledger l JOIN quota_accounts q ON q.session_id=l.session_id AND q.account_id=l.account_id WHERE l.session_id=NEW.session_id AND l.entry_id=NEW.charge_entry_id AND l.entry_kind='spend' AND q.resource='report' AND q.role=NEW.sender_role AND q.scene_id=NEW.scene_id AND l.amount>(SELECT COUNT(*) FROM reports r WHERE r.session_id=NEW.session_id AND r.charge_entry_id=l.entry_id)) THEN RAISE(ABORT,'REPORT_CHARGE_EXHAUSTED') END;
END;
CREATE TRIGGER upload_guard BEFORE INSERT ON uploads BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM reports r WHERE r.session_id=NEW.session_id AND r.report_id=NEW.report_id AND r.source_revision=NEW.report_revision AND r.scene_id=NEW.scene_id) THEN RAISE(ABORT,'UPLOAD_REPORT_NOT_RECEIVED') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM actor_bindings b WHERE b.session_id=NEW.session_id AND b.binding_id=NEW.authorization_binding_id AND b.role='commander') THEN RAISE(ABORT,'UPLOAD_COMMANDER_REQUIRED') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM quota_ledger l JOIN quota_accounts q ON q.session_id=l.session_id AND q.account_id=l.account_id WHERE l.session_id=NEW.session_id AND l.entry_id=NEW.charge_entry_id AND l.entry_kind='spend' AND q.resource='upload' AND q.scene_id=NEW.scene_id AND l.amount>(SELECT COUNT(*) FROM uploads u WHERE u.session_id=NEW.session_id AND u.charge_entry_id=l.entry_id)) THEN RAISE(ABORT,'UPLOAD_CHARGE_EXHAUSTED') END;
END;
CREATE TRIGGER manifest_members_before_seal BEFORE INSERT ON input_manifest_members BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM input_manifests m WHERE m.session_id=NEW.session_id AND m.manifest_id=NEW.manifest_id) THEN RAISE(ABORT,'MANIFEST_ALREADY_FINALIZED') END;
END;
CREATE TRIGGER manifest_statements_before_seal BEFORE INSERT ON manifest_statements BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM input_manifests m WHERE m.session_id=NEW.session_id AND m.manifest_id=NEW.manifest_id) THEN RAISE(ABORT,'MANIFEST_ALREADY_FINALIZED') END;
END;
CREATE TRIGGER manifest_finalize BEFORE INSERT ON input_manifests BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM input_manifest_members x WHERE x.session_id=NEW.session_id AND x.manifest_id=NEW.manifest_id)>5 THEN RAISE(ABORT,'MANIFEST_UPLOAD_LIMIT') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM input_manifest_members x JOIN uploads u ON u.session_id=x.session_id AND u.upload_id=x.upload_id WHERE x.session_id=NEW.session_id AND x.manifest_id=NEW.manifest_id AND u.scene_id!=NEW.scene_id) THEN RAISE(ABORT,'MANIFEST_SCENE_MISMATCH') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM manifest_statements x JOIN player_statements p ON p.session_id=x.session_id AND p.statement_id=x.statement_id WHERE x.session_id=NEW.session_id AND x.manifest_id=NEW.manifest_id AND p.scene_id!=NEW.scene_id) THEN RAISE(ABORT,'MANIFEST_STATEMENT_SCENE_MISMATCH') END;
END;
CREATE TRIGGER player_statement_commander BEFORE INSERT ON player_statements BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM actor_bindings b WHERE b.session_id=NEW.session_id AND b.binding_id=NEW.binding_id AND b.role='commander') THEN RAISE(ABORT,'STATEMENT_COMMANDER_REQUIRED') END;
END;
CREATE TRIGGER agent_job_input_guard BEFORE INSERT ON agent_jobs BEGIN
  SELECT CASE WHEN NEW.agent_role='advisor' AND NOT EXISTS(SELECT 1 FROM input_manifests m WHERE m.session_id=NEW.session_id AND m.manifest_id=NEW.manifest_id AND m.scene_id=NEW.scene_id AND m.context_version=NEW.context_version AND m.inbox_version=NEW.inbox_version AND m.input_hash=NEW.input_hash) THEN RAISE(ABORT,'ADVISOR_MANIFEST_MISMATCH') END;
  SELECT CASE WHEN NEW.agent_role='advisor' AND EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN RAISE(ABORT,'SESSION_TERMINAL') END;
  SELECT CASE WHEN NEW.agent_role='evaluator' AND NOT EXISTS(SELECT 1 FROM sessions s JOIN terminal_seals z ON z.session_id=s.session_id AND z.seal_id=s.terminal_seal_id WHERE s.session_id=NEW.session_id AND z.sealed_hash=NEW.seal_hash AND s.lifecycle IN ('completed','abandoned','interrupted')) THEN RAISE(ABORT,'EVALUATOR_REQUIRES_SEAL') END;
END;
CREATE TRIGGER agent_job_update_guard BEFORE UPDATE ON agent_jobs BEGIN
  SELECT CASE WHEN NEW.session_id!=OLD.session_id OR NEW.job_id!=OLD.job_id OR NEW.agent_role!=OLD.agent_role OR NEW.scene_id IS NOT OLD.scene_id OR NEW.manifest_id IS NOT OLD.manifest_id OR NEW.seal_hash IS NOT OLD.seal_hash OR NEW.input_hash!=OLD.input_hash OR NEW.config_hash!=OLD.config_hash OR NEW.input_version!=OLD.input_version OR NEW.context_version IS NOT OLD.context_version OR NEW.inbox_version IS NOT OLD.inbox_version OR NEW.evaluator_input_json IS NOT OLD.evaluator_input_json OR NEW.max_attempts!=OLD.max_attempts THEN RAISE(ABORT,'AGENT_INPUT_IMMUTABLE') END;
  SELECT CASE WHEN OLD.status IN ('succeeded','cancelled','superseded') THEN RAISE(ABORT,'AGENT_JOB_FINAL') END;
  SELECT CASE WHEN NEW.status!=OLD.status AND NOT ((OLD.status='queued' AND NEW.status IN ('running','fallback','failed','cancelled','superseded')) OR (OLD.status='running' AND NEW.status IN ('succeeded','fallback','failed','cancelled','superseded')) OR (OLD.status IN ('fallback','failed') AND NEW.status IN ('queued','cancelled','superseded'))) THEN RAISE(ABORT,'AGENT_STATUS_TRANSITION') END;
  SELECT CASE WHEN NEW.agent_role='advisor' AND EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN RAISE(ABORT,'SESSION_TERMINAL') END;
END;
CREATE TRIGGER attempt_insert_guard BEFORE INSERT ON agent_attempts BEGIN
  SELECT CASE WHEN NEW.status!='sending' OR NOT EXISTS(SELECT 1 FROM agent_jobs j WHERE j.session_id=NEW.session_id AND j.job_id=NEW.job_id AND j.status='running' AND j.mode='live_model' AND NEW.attempt_no<=j.max_attempts) THEN RAISE(ABORT,'ATTEMPT_NOT_ALLOWED') END;
  SELECT CASE WHEN NEW.attempt_no!=COALESCE((SELECT MAX(attempt_no)+1 FROM agent_attempts WHERE session_id=NEW.session_id AND job_id=NEW.job_id),1) THEN RAISE(ABORT,'ATTEMPT_SEQUENCE') END;
  SELECT CASE WHEN (SELECT agent_role FROM agent_jobs WHERE session_id=NEW.session_id AND job_id=NEW.job_id)='advisor' AND (SELECT COUNT(*) FROM agent_attempts a JOIN agent_jobs j ON j.session_id=a.session_id AND j.job_id=a.job_id WHERE a.session_id=NEW.session_id AND j.agent_role='advisor')>=30 THEN RAISE(ABORT,'ADVISOR_SESSION_CALL_LIMIT') END;
  SELECT CASE WHEN (SELECT agent_role FROM agent_jobs WHERE session_id=NEW.session_id AND job_id=NEW.job_id)='advisor' AND EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) THEN RAISE(ABORT,'SESSION_TERMINAL') END;
END;
CREATE TRIGGER attempt_update_guard BEFORE UPDATE ON agent_attempts BEGIN
  SELECT CASE WHEN NEW.session_id!=OLD.session_id OR NEW.job_id!=OLD.job_id OR NEW.attempt_no!=OLD.attempt_no OR NEW.request_key!=OLD.request_key OR NEW.sent_at_ms!=OLD.sent_at_ms THEN RAISE(ABORT,'ATTEMPT_IDENTITY_IMMUTABLE') END;
  SELECT CASE WHEN OLD.status NOT IN ('sending','running') THEN RAISE(ABORT,'ATTEMPT_FINAL') END;
  SELECT CASE WHEN OLD.status='running' AND NEW.status='sending' THEN RAISE(ABORT,'ATTEMPT_STATUS_REGRESSION') END;
END;
CREATE TRIGGER display_owner_guard BEFORE INSERT ON display_receipts BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM public_records p JOIN actor_bindings b ON b.session_id=p.session_id WHERE p.session_id=NEW.session_id AND p.public_record_id=NEW.public_record_id AND p.revision=NEW.record_revision AND b.binding_id=NEW.binding_id AND (p.view_role=b.role OR p.view_role='all')) THEN RAISE(ABORT,'DISPLAY_NOT_VISIBLE') END;
END;
CREATE TRIGGER terminal_seal_guard BEFORE INSERT ON terminal_seals BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM sessions s WHERE s.session_id=NEW.session_id AND s.lifecycle IN ('briefing','running') AND NEW.terminal_state_version=s.state_version+1 AND NEW.terminal_seq=s.last_event_seq AND NEW.terminal_mission_ms>=s.mission_ms AND NEW.content_hash=s.content_hash AND NEW.policy_hash=s.policy_hash) THEN RAISE(ABORT,'SEAL_STATE_MISMATCH') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investigations WHERE session_id=NEW.session_id AND status IN ('queued','running')) OR EXISTS(SELECT 1 FROM task_requests WHERE session_id=NEW.session_id AND status IN ('accepted','running')) OR EXISTS(SELECT 1 FROM operations WHERE session_id=NEW.session_id AND status IN ('accepted','running')) OR EXISTS(SELECT 1 FROM agent_jobs WHERE session_id=NEW.session_id AND agent_role='advisor' AND status IN ('queued','running')) OR EXISTS(SELECT 1 FROM quota_accounts WHERE session_id=NEW.session_id AND reserved>0) THEN RAISE(ABORT,'SEAL_HAS_UNSETTLED_OPERATIONS') END;
END;
CREATE TRIGGER behavior_cutoff_guard BEFORE INSERT ON behavior_facts BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM decision_snapshots d JOIN terminal_seals z ON z.session_id=d.session_id WHERE d.session_id=NEW.session_id AND d.snapshot_id=NEW.context_id AND z.sealed_hash=NEW.seal_hash AND NEW.cutoff_seq=d.source_seq AND NEW.cutoff_state_version=d.state_version AND NEW.cutoff_seq<=z.terminal_seq AND NEW.cutoff_state_version<=z.terminal_state_version) THEN RAISE(ABORT,'BEHAVIOR_CUTOFF_MISMATCH') END;
END;
CREATE TRIGGER evaluation_result_guard BEFORE INSERT ON evaluation_reports BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM agent_jobs j WHERE j.session_id=NEW.session_id AND j.job_id=NEW.job_id AND j.agent_role='evaluator' AND j.seal_hash=NEW.sealed_hash AND j.config_hash=NEW.config_hash AND j.status IN ('succeeded','fallback') AND j.result_json=NEW.report_json AND j.mode=NEW.mode) THEN RAISE(ABORT,'EVALUATION_JOB_RESULT_MISMATCH') END;
END;
CREATE TRIGGER schema_migrations_immutable_update BEFORE UPDATE ON schema_migrations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER schema_migrations_immutable_delete BEFORE DELETE ON schema_migrations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER content_versions_immutable_update BEFORE UPDATE ON content_versions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER content_versions_immutable_delete BEFORE DELETE ON content_versions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER policy_profiles_immutable_update BEFORE UPDATE ON policy_profiles BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER policy_profiles_immutable_delete BEFORE DELETE ON policy_profiles BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER actor_bindings_immutable_update BEFORE UPDATE ON actor_bindings BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER actor_bindings_immutable_delete BEFORE DELETE ON actor_bindings BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER session_creations_immutable_update BEFORE UPDATE ON session_creations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER session_creations_immutable_delete BEFORE DELETE ON session_creations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER commands_immutable_update BEFORE UPDATE ON commands BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER commands_immutable_delete BEFORE DELETE ON commands BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER events_immutable_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER events_immutable_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER view_events_immutable_update BEFORE UPDATE ON view_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER view_events_immutable_delete BEFORE DELETE ON view_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER quota_ledger_immutable_update BEFORE UPDATE ON quota_ledger BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER quota_ledger_immutable_delete BEFORE DELETE ON quota_ledger BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER evidence_instances_immutable_update BEFORE UPDATE ON evidence_instances BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER evidence_instances_immutable_delete BEFORE DELETE ON evidence_instances BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER provenance_disclosures_immutable_update BEFORE UPDATE ON provenance_disclosures BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER provenance_disclosures_immutable_delete BEFORE DELETE ON provenance_disclosures BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER reports_immutable_update BEFORE UPDATE ON reports BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER reports_immutable_delete BEFORE DELETE ON reports BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER uploads_immutable_update BEFORE UPDATE ON uploads BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER uploads_immutable_delete BEFORE DELETE ON uploads BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER input_manifests_immutable_update BEFORE UPDATE ON input_manifests BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER input_manifests_immutable_delete BEFORE DELETE ON input_manifests BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER input_manifest_members_immutable_update BEFORE UPDATE ON input_manifest_members BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER input_manifest_members_immutable_delete BEFORE DELETE ON input_manifest_members BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER player_statements_immutable_update BEFORE UPDATE ON player_statements BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER player_statements_immutable_delete BEFORE DELETE ON player_statements BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER manifest_statements_immutable_update BEFORE UPDATE ON manifest_statements BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER manifest_statements_immutable_delete BEFORE DELETE ON manifest_statements BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER public_records_immutable_update BEFORE UPDATE ON public_records BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER public_records_immutable_delete BEFORE DELETE ON public_records BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER display_receipts_immutable_update BEFORE UPDATE ON display_receipts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER display_receipts_immutable_delete BEFORE DELETE ON display_receipts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER decision_snapshots_immutable_update BEFORE UPDATE ON decision_snapshots BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER decision_snapshots_immutable_delete BEFORE DELETE ON decision_snapshots BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER terminal_seals_immutable_update BEFORE UPDATE ON terminal_seals BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER terminal_seals_immutable_delete BEFORE DELETE ON terminal_seals BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER behavior_facts_immutable_update BEFORE UPDATE ON behavior_facts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER behavior_facts_immutable_delete BEFORE DELETE ON behavior_facts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER evaluation_reports_immutable_update BEFORE UPDATE ON evaluation_reports BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER evaluation_reports_immutable_delete BEFORE DELETE ON evaluation_reports BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER sessions_no_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'AUDIT_DELETE_FORBIDDEN'); END;
CREATE TRIGGER session_scenes_no_delete BEFORE DELETE ON session_scenes BEGIN SELECT RAISE(ABORT,'AUDIT_DELETE_FORBIDDEN'); END;
CREATE TRIGGER quota_accounts_no_delete BEFORE DELETE ON quota_accounts BEGIN SELECT RAISE(ABORT,'AUDIT_DELETE_FORBIDDEN'); END;
CREATE TRIGGER task_requests_no_delete BEFORE DELETE ON task_requests BEGIN SELECT RAISE(ABORT,'AUDIT_DELETE_FORBIDDEN'); END;
CREATE TRIGGER investigations_no_delete BEFORE DELETE ON investigations BEGIN SELECT RAISE(ABORT,'AUDIT_DELETE_FORBIDDEN'); END;
CREATE TRIGGER operations_no_delete BEFORE DELETE ON operations BEGIN SELECT RAISE(ABORT,'AUDIT_DELETE_FORBIDDEN'); END;
CREATE TRIGGER agent_jobs_no_delete BEFORE DELETE ON agent_jobs BEGIN SELECT RAISE(ABORT,'AUDIT_DELETE_FORBIDDEN'); END;
CREATE TRIGGER agent_attempts_no_delete BEFORE DELETE ON agent_attempts BEGIN SELECT RAISE(ABORT,'AUDIT_DELETE_FORBIDDEN'); END;
CREATE TRIGGER export_jobs_no_delete BEFORE DELETE ON export_jobs BEGIN SELECT RAISE(ABORT,'AUDIT_DELETE_FORBIDDEN'); END;
CREATE TRIGGER session_scenes_terminal_insert BEFORE INSERT ON session_scenes WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER session_scenes_terminal_update BEFORE UPDATE ON session_scenes WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER actor_bindings_terminal_insert BEFORE INSERT ON actor_bindings WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER events_terminal_insert BEFORE INSERT ON events WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER quota_accounts_terminal_insert BEFORE INSERT ON quota_accounts WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER quota_accounts_terminal_update BEFORE UPDATE ON quota_accounts WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER quota_ledger_terminal_insert BEFORE INSERT ON quota_ledger WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER task_requests_terminal_insert BEFORE INSERT ON task_requests WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER task_requests_terminal_update BEFORE UPDATE ON task_requests WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER investigations_terminal_insert BEFORE INSERT ON investigations WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER investigations_terminal_update BEFORE UPDATE ON investigations WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER operations_terminal_insert BEFORE INSERT ON operations WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER operations_terminal_update BEFORE UPDATE ON operations WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER evidence_instances_terminal_insert BEFORE INSERT ON evidence_instances WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER provenance_disclosures_terminal_insert BEFORE INSERT ON provenance_disclosures WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER reports_terminal_insert BEFORE INSERT ON reports WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER uploads_terminal_insert BEFORE INSERT ON uploads WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER input_manifests_terminal_insert BEFORE INSERT ON input_manifests WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER input_manifest_members_terminal_insert BEFORE INSERT ON input_manifest_members WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER player_statements_terminal_insert BEFORE INSERT ON player_statements WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER manifest_statements_terminal_insert BEFORE INSERT ON manifest_statements WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER public_records_terminal_insert BEFORE INSERT ON public_records WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER display_receipts_terminal_insert BEFORE INSERT ON display_receipts WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER decision_snapshots_terminal_insert BEFORE INSERT ON decision_snapshots WHEN EXISTS(SELECT 1 FROM terminal_seals WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'SESSION_TERMINAL'); END;
CREATE TRIGGER task_requests_status_guard BEFORE UPDATE ON task_requests BEGIN SELECT CASE WHEN OLD.status NOT IN ('accepted','running') THEN RAISE(ABORT,'OPERATION_FINAL') END; SELECT CASE WHEN NEW.session_id!=OLD.session_id OR NEW.task_id!=OLD.task_id OR NEW.scene_id!=OLD.scene_id OR NEW.created_at_ms!=OLD.created_at_ms THEN RAISE(ABORT,'OPERATION_IDENTITY_IMMUTABLE') END; SELECT CASE WHEN OLD.status='running' AND NEW.status='accepted' THEN RAISE(ABORT,'OPERATION_STATUS_REGRESSION') END; END;
CREATE TRIGGER investigations_status_guard BEFORE UPDATE ON investigations BEGIN SELECT CASE WHEN OLD.status NOT IN ('queued','running') THEN RAISE(ABORT,'OPERATION_FINAL') END; SELECT CASE WHEN NEW.session_id!=OLD.session_id OR NEW.investigation_id!=OLD.investigation_id OR NEW.scene_id!=OLD.scene_id OR NEW.accepted_mission_ms!=OLD.accepted_mission_ms THEN RAISE(ABORT,'OPERATION_IDENTITY_IMMUTABLE') END; SELECT CASE WHEN OLD.status='running' AND NEW.status='queued' THEN RAISE(ABORT,'OPERATION_STATUS_REGRESSION') END; END;
CREATE TRIGGER operations_status_guard BEFORE UPDATE ON operations BEGIN SELECT CASE WHEN OLD.status NOT IN ('accepted','running') THEN RAISE(ABORT,'OPERATION_FINAL') END; SELECT CASE WHEN NEW.session_id!=OLD.session_id OR NEW.operation_id!=OLD.operation_id OR NEW.scene_id!=OLD.scene_id OR NEW.accepted_mission_ms!=OLD.accepted_mission_ms THEN RAISE(ABORT,'OPERATION_IDENTITY_IMMUTABLE') END; SELECT CASE WHEN OLD.status='running' AND NEW.status='accepted' THEN RAISE(ABORT,'OPERATION_STATUS_REGRESSION') END; END;

CREATE TABLE diagnostic_records (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  diagnostic_id TEXT NOT NULL CHECK(length(diagnostic_id)=36),
  category TEXT NOT NULL CHECK(category IN ('late_callback','transport_unknown','storage_failure','recovery','validation_rejection','postgame_audit')),
  job_id TEXT,
  attempt_no INTEGER,
  recorded_at_ms INTEGER NOT NULL CHECK(recorded_at_ms>=0),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json)='object'),
  PRIMARY KEY(session_id,diagnostic_id),
  FOREIGN KEY(session_id,job_id,attempt_no) REFERENCES agent_attempts(session_id,job_id,attempt_no),
  CHECK((job_id IS NULL)=(attempt_no IS NULL))
) STRICT;
CREATE TRIGGER postgame_audit_seal_guard BEFORE INSERT ON diagnostic_records WHEN NEW.category='postgame_audit' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM sessions s JOIN terminal_seals z ON z.session_id=s.session_id AND z.seal_id=s.terminal_seal_id WHERE s.session_id=NEW.session_id AND s.lifecycle IN ('completed','abandoned','interrupted') AND z.sealed_hash=json_extract(NEW.payload_json,'$.sealedHash') AND s.session_id=json_extract(NEW.payload_json,'$.sessionId') AND NEW.diagnostic_id=json_extract(NEW.payload_json,'$.auditId')) THEN RAISE(ABORT,'POSTGAME_AUDIT_SEAL_MISMATCH') END;
END;
CREATE TRIGGER diagnostic_records_immutable_update BEFORE UPDATE ON diagnostic_records BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER diagnostic_records_immutable_delete BEFORE DELETE ON diagnostic_records BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER task_payload_immutable BEFORE UPDATE ON task_requests BEGIN
 SELECT CASE WHEN NEW.commander_binding_id!=OLD.commander_binding_id OR NEW.target_role!=OLD.target_role OR NEW.task_kind!=OLD.task_kind OR NEW.topic_id!=OLD.topic_id OR NEW.target_id!=OLD.target_id OR NEW.option_id IS NOT OLD.option_id OR NEW.report_reservation_id!=OLD.report_reservation_id OR NEW.accepted_mission_ms!=OLD.accepted_mission_ms OR NEW.due_mission_ms!=OLD.due_mission_ms THEN RAISE(ABORT,'TASK_PAYLOAD_IMMUTABLE') END;
END;
CREATE TRIGGER investigation_payload_immutable BEFORE UPDATE ON investigations BEGIN
 SELECT CASE WHEN NEW.task_id!=OLD.task_id OR NEW.role!=OLD.role OR NEW.option_id!=OLD.option_id OR NEW.resource_key!=OLD.resource_key OR NEW.resource_charge_id!=OLD.resource_charge_id OR NEW.due_mission_ms!=OLD.due_mission_ms THEN RAISE(ABORT,'INVESTIGATION_PAYLOAD_IMMUTABLE') END;
END;
CREATE TRIGGER operation_payload_immutable BEFORE UPDATE ON operations BEGIN
 SELECT CASE WHEN NEW.operation_kind!=OLD.operation_kind OR NEW.action_id!=OLD.action_id OR NEW.private_plan_json!=OLD.private_plan_json OR NEW.due_mission_ms!=OLD.due_mission_ms THEN RAISE(ABORT,'OPERATION_PAYLOAD_IMMUTABLE') END;
END;

INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(1,'initial_engineering_reference',0);
PRAGMA user_version=1;
COMMIT;
