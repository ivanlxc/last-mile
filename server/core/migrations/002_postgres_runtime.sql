-- Additive runtime and cloud support. Baseline JSON is deliberately stored as text.
CREATE TABLE IF NOT EXISTS runtime_schema_migrations(version BIGINT PRIMARY KEY,name TEXT NOT NULL,applied_at_ms BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS runtime_session_meta(session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),locale TEXT NOT NULL,run_purpose TEXT NOT NULL,start_wall_ms BIGINT);
CREATE TABLE IF NOT EXISTS runtime_display_bindings(session_id TEXT NOT NULL REFERENCES sessions(session_id),record_key TEXT NOT NULL,public_record_id TEXT NOT NULL,revision BIGINT NOT NULL,PRIMARY KEY(session_id,record_key));
CREATE TABLE IF NOT EXISTS runtime_export_artifacts(export_id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(session_id),artifact_json TEXT NOT NULL CHECK(lm_json_valid(artifact_json)));
INSERT INTO runtime_schema_migrations VALUES(1,'private_runtime_snapshots_and_display_lookup',0) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS cloud_players(player_id TEXT PRIMARY KEY,created_at_ms BIGINT NOT NULL CHECK(created_at_ms>=0));
CREATE TABLE IF NOT EXISTS cloud_sessions(session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),player_id TEXT NOT NULL REFERENCES cloud_players(player_id));
CREATE INDEX IF NOT EXISTS ix_cloud_sessions_player ON cloud_sessions(player_id);
CREATE TABLE IF NOT EXISTS cloud_creation_keys(player_id TEXT NOT NULL REFERENCES cloud_players(player_id),request_id TEXT NOT NULL,session_id TEXT NOT NULL REFERENCES sessions(session_id),payload_hash TEXT NOT NULL,response_json TEXT NOT NULL CHECK(lm_json_valid(response_json)),created_at_ms BIGINT NOT NULL CHECK(created_at_ms>=0),PRIMARY KEY(player_id,request_id));
CREATE TABLE IF NOT EXISTS cloud_daily_usage(day TEXT PRIMARY KEY,attempt_count BIGINT NOT NULL CHECK(attempt_count>=0));
CREATE TABLE IF NOT EXISTS cloud_credentials(token_hash TEXT PRIMARY KEY,player_id TEXT NOT NULL REFERENCES cloud_players(player_id),expires_at_ms BIGINT NOT NULL CHECK(expires_at_ms>=0));
CREATE INDEX IF NOT EXISTS ix_cloud_credentials_player ON cloud_credentials(player_id);
CREATE INDEX IF NOT EXISTS ix_cloud_credentials_expiry ON cloud_credentials(expires_at_ms);
INSERT INTO runtime_schema_migrations VALUES(2,'durable_cloud_identity_and_usage',0) ON CONFLICT DO NOTHING;
