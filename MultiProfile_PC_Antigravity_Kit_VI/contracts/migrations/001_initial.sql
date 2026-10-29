-- Reference migration, schema version 1. No secrets or browser payloads.
-- Apply with one writer. Cross-row lifecycle policies remain application rules.
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE proxies (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  scheme TEXT NOT NULL CHECK (scheme IN ('http','https','socks5')),
  host TEXT NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  auth_kind TEXT NOT NULL CHECK (auth_kind IN ('none','basic','username_password')),
  secret_ref TEXT,
  config_revision INTEGER NOT NULL CHECK (config_revision > 0),
  CHECK ((auth_kind = 'none' AND secret_ref IS NULL) OR
         (auth_kind <> 'none' AND secret_ref IS NOT NULL AND length(secret_ref) > 0)),
  CHECK ((scheme = 'socks5' AND auth_kind IN ('none','username_password')) OR
         (scheme IN ('http','https') AND auth_kind IN ('none','basic')))
);

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  group_name TEXT NOT NULL DEFAULT '',
  proxy_mode TEXT NOT NULL CHECK (proxy_mode IN ('required','direct')),
  proxy_id TEXT REFERENCES proxies(id) ON DELETE RESTRICT,
  preset_json TEXT NOT NULL CHECK (json_valid(preset_json)),
  start_url TEXT NOT NULL,
  config_revision INTEGER NOT NULL CHECK (config_revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK ((proxy_mode='required' AND proxy_id IS NOT NULL) OR
         (proxy_mode='direct' AND proxy_id IS NULL))
);

CREATE TABLE profile_runtime (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation > 0),
  state TEXT NOT NULL CHECK (state IN ('STOPPED','VALIDATING','STARTING','READY','DEGRADED','STOPPING','ERROR')),
  worker_pid INTEGER,
  worker_birth_time TEXT,
  session_nonce TEXT,
  last_error_code TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE sync_sessions (
  id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  master_profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('DRAFT','ARMING','RUNNING','PAUSED','STOPPING','STOPPED')),
  mode TEXT NOT NULL CHECK (mode IN ('dom','coordinate')),
  failure_policy TEXT NOT NULL CHECK (failure_policy IN ('strict','continueHealthy')),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  config_revision INTEGER NOT NULL CHECK (config_revision > 0),
  created_at TEXT NOT NULL
);

CREATE TABLE sync_members (
  session_id TEXT NOT NULL REFERENCES sync_sessions(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('MASTER','FOLLOWER')),
  logical_tab_id TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  PRIMARY KEY (session_id, profile_id)
);
CREATE UNIQUE INDEX one_active_session_per_profile
  ON sync_members(profile_id) WHERE active=1;
CREATE UNIQUE INDEX one_active_master_per_session
  ON sync_members(session_id) WHERE active=1 AND role='MASTER';

-- Metadata-only ledger: no text, clipboard, selector, cookie or URL payload.
CREATE TABLE sync_deliveries (
  session_id TEXT NOT NULL REFERENCES sync_sessions(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  event_id TEXT NOT NULL,
  follower_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq > 0),
  event_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('RECEIVED','DISPATCHING','APPLIED','SKIPPED','BLOCKED','FAILED','UNKNOWN')),
  verification TEXT NOT NULL CHECK (verification IN ('matched','unverified','mismatched')),
  queued_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT,
  trace_id TEXT NOT NULL,
  PRIMARY KEY (session_id, epoch, event_id, follower_id),
  UNIQUE (session_id, epoch, seq, follower_id)
);

CREATE TABLE variable_sets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  fields_json TEXT NOT NULL CHECK (json_valid(fields_json)),
  created_at TEXT NOT NULL
);
CREATE TABLE variable_values (
  dataset_id TEXT NOT NULL REFERENCES variable_sets(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  field_name TEXT NOT NULL,
  value_ciphertext BLOB NOT NULL,
  encryption_version INTEGER NOT NULL CHECK (encryption_version > 0),
  PRIMARY KEY (dataset_id, profile_id, field_name)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  trace_id TEXT,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json))
);
CREATE INDEX audit_created_at ON audit_events(created_at);

CREATE TABLE request_dedup (
  request_id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  operation_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('ACCEPTED','COMPLETED','FAILED','UNKNOWN')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Migration runner inserts its verified checksum into schema_migrations.
COMMIT;
