export const ORCHESTRATION_SCHEMA_VERSION = 4
export const ORCHESTRATION_PROJECTION_SCHEMA_VERSION = 2

export const ORCH_DDL_V1: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS orch_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS orch_event (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    at INTEGER NOT NULL,
    type TEXT NOT NULL,
    stream TEXT NOT NULL,
    session_key TEXT,
    run_id TEXT,
    cwd TEXT,
    command_id TEXT,
    actor TEXT NOT NULL,
    scope TEXT NOT NULL,
    payload TEXT NOT NULL,
    evidence TEXT,
    principal TEXT NOT NULL,
    via TEXT,
    actor_run_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_orch_event_stream_seq ON orch_event(stream, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_orch_event_run_seq ON orch_event(run_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_orch_event_session_seq ON orch_event(session_key, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_orch_event_command_id ON orch_event(command_id)`,

  `CREATE TABLE IF NOT EXISTS orch_command (
    command_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    accepted_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    result TEXT,
    result_seq INTEGER,
    principal TEXT NOT NULL,
    via TEXT,
    actor_run_id TEXT,
    PRIMARY KEY (command_id, actor)
  )`,

  `CREATE TABLE IF NOT EXISTS orch_p_session (
    session_key TEXT PRIMARY KEY,
    conversation_id TEXT,
    provider TEXT,
    profile TEXT,
    cwd TEXT,
    title TEXT,
    ts INTEGER NOT NULL,
    pinned_at INTEGER,
    archived_at INTEGER,
    last_run_id TEXT,
    last_run_outcome TEXT,
    active_run_id TEXT,
    pending_questions INTEGER NOT NULL DEFAULT 0,
    legacy INTEGER NOT NULL DEFAULT 0,
    rev_seq INTEGER NOT NULL,
    parent_session_key TEXT,
    root_session_key TEXT,
    lineage TEXT,
    created_by TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_orch_p_session_keyset ON orch_p_session(archived_at, ts DESC, session_key)`,

  `CREATE TABLE IF NOT EXISTS orch_p_turn (
    session_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    run_id TEXT NOT NULL UNIQUE,
    ordinal_origin TEXT NOT NULL,
    user_text_preview TEXT,
    delivery TEXT NOT NULL,
    outcome TEXT,
    started_at INTEGER,
    settled_at INTEGER,
    recovered_at INTEGER,
    content_ref TEXT,
    evidence TEXT,
    rev_seq INTEGER NOT NULL,
    author TEXT NOT NULL DEFAULT 'unavailable',
    PRIMARY KEY (session_key, ordinal)
  )`,

  `CREATE TABLE IF NOT EXISTS orch_p_run (
    run_id TEXT PRIMARY KEY,
    session_key TEXT,
    owner_actor TEXT NOT NULL,
    scope TEXT NOT NULL,
    origin TEXT NOT NULL,
    provider TEXT,
    profile TEXT,
    cwd TEXT,
    prompt_preview TEXT,
    lifecycle TEXT NOT NULL,
    stop_state TEXT,
    output_seq INTEGER,
    intent_seq INTEGER NOT NULL,
    body TEXT,
    settled_at INTEGER,
    recovered_at INTEGER,
    outcome TEXT,
    rev_seq INTEGER NOT NULL,
    parent_run_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_orch_p_run_lifecycle ON orch_p_run(lifecycle)`,
  `CREATE INDEX IF NOT EXISTS idx_orch_p_run_parent ON orch_p_run(parent_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orch_p_run_origin_lifecycle ON orch_p_run(origin, lifecycle)`,

  `CREATE TABLE IF NOT EXISTS orch_p_interaction (
    run_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    state TEXT NOT NULL,
    answer_id TEXT,
    answer_sha256 TEXT,
    opened_seq INTEGER NOT NULL,
    closed_seq INTEGER,
    answered_by TEXT,
    PRIMARY KEY (run_id, question_id)
  )`,

  `CREATE TABLE IF NOT EXISTS orch_outbox (
    effect_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    policy TEXT NOT NULL,
    run_id TEXT,
    causation_seq INTEGER NOT NULL,
    payload TEXT NOT NULL,
    state TEXT NOT NULL,
    expires_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT,
    claimed_at INTEGER,
    completed_at INTEGER,
    result_seq INTEGER,
    last_error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_orch_outbox_state_id ON orch_outbox(state, effect_id)`,

  `CREATE TABLE IF NOT EXISTS orch_legacy_run (
    ledger_run_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE
  )`
]

/**
 * V2 migration: rebuilds `orch_p_run` with nullable `output_seq INTEGER` so databases created
 * under early V1 builds (where `output_seq` had `NOT NULL DEFAULT 0`) accept `NULL` cleanly.
 */
export const ORCH_DDL_V2: readonly string[] = [
  `CREATE TABLE orch_p_run_v2 (
    run_id TEXT PRIMARY KEY,
    session_key TEXT,
    owner_actor TEXT NOT NULL,
    scope TEXT NOT NULL,
    origin TEXT NOT NULL,
    provider TEXT,
    profile TEXT,
    cwd TEXT,
    prompt_preview TEXT,
    lifecycle TEXT NOT NULL,
    stop_state TEXT,
    output_seq INTEGER,
    intent_seq INTEGER NOT NULL,
    body TEXT,
    settled_at INTEGER,
    recovered_at INTEGER,
    outcome TEXT,
    rev_seq INTEGER NOT NULL,
    parent_run_id TEXT
  )`,
  `INSERT INTO orch_p_run_v2 (
    run_id, session_key, owner_actor, scope, origin, provider, profile, cwd,
    prompt_preview, lifecycle, stop_state, output_seq, intent_seq, body,
    settled_at, recovered_at, outcome, rev_seq, parent_run_id
  ) SELECT
    run_id, session_key, owner_actor, scope, origin, provider, profile, cwd,
    prompt_preview, lifecycle, stop_state,
    CASE WHEN output_seq = 0 THEN NULL ELSE output_seq END,
    intent_seq, body,
    settled_at, recovered_at, outcome, rev_seq, parent_run_id
  FROM orch_p_run`,
  `DROP TABLE orch_p_run`,
  `ALTER TABLE orch_p_run_v2 RENAME TO orch_p_run`,
  `CREATE INDEX IF NOT EXISTS idx_orch_p_run_lifecycle ON orch_p_run(lifecycle)`,
  `CREATE INDEX IF NOT EXISTS idx_orch_p_run_parent ON orch_p_run(parent_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orch_p_run_origin_lifecycle ON orch_p_run(origin, lifecycle)`
]

export const ORCH_DDL_V3: readonly string[] = [
  'ALTER TABLE orch_p_session ADD COLUMN catalog TEXT',
  "UPDATE orch_meta SET value = '2' WHERE key = 'projection_schema_version'",
  "UPDATE orch_meta SET value = '' WHERE key = 'legacy_catalog_sha256'"
]

export const ORCH_DDL_V4: readonly string[] = [
  `CREATE TABLE orch_body_erase (
    session_key TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    PRIMARY KEY (session_key, sha256)
  )`,
  `CREATE INDEX idx_orch_event_deleted_native
   ON orch_event(json_extract(payload, '$.nativeIdentity')) WHERE type = 'session.deleted'`,
  `CREATE INDEX idx_orch_event_deleted_native_source
   ON orch_event(json_extract(payload, '$.nativeSource')) WHERE type = 'session.deleted'`
]

export const ORCHESTRATION_MIGRATIONS: readonly (readonly string[])[] = [ORCH_DDL_V1, ORCH_DDL_V2, ORCH_DDL_V3, ORCH_DDL_V4]
