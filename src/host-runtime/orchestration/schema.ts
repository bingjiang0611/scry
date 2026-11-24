export const ORCHESTRATION_SCHEMA_VERSION = 10
export const ORCHESTRATION_PROJECTION_SCHEMA_VERSION = 6

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

export const ORCH_DDL_V5: readonly string[] = [
  'ALTER TABLE orch_p_run ADD COLUMN app_run_id TEXT',
  "UPDATE orch_meta SET value = '3' WHERE key = 'projection_schema_version'"
]

const ORCH_DDL_V6: readonly string[] = [
  // Restore prior-history flags from discoveries of the current session generation.
  // Already written turn ordinals and subscriber revisions remain immutable.
  `UPDATE orch_p_session SET legacy = 1
   WHERE legacy = 0 AND EXISTS (
     SELECT 1 FROM orch_event AS discovery
     WHERE discovery.session_key = orch_p_session.session_key AND discovery.type = 'session.discovered'
       AND json_extract(discovery.payload, '$.transcript.status') = 'available'
       AND json_extract(discovery.payload, '$.transcript.quality') = 'exact'
       AND length(json_extract(discovery.payload, '$.transcript.value')) > 0
       AND NOT EXISTS (
         SELECT 1 FROM orch_event AS retired WHERE retired.session_key = discovery.session_key
           AND retired.seq > discovery.seq AND retired.type IN ('session.deleted', 'session.withdrawn')
       )
       AND NOT EXISTS (
         SELECT 1 FROM orch_event AS turn WHERE turn.session_key = discovery.session_key
           AND turn.seq < discovery.seq AND turn.type = 'turn.began'
           AND turn.seq > COALESCE((
             SELECT MAX(previous.seq) FROM orch_event AS previous WHERE previous.session_key = discovery.session_key
               AND previous.seq < discovery.seq AND previous.type IN ('session.deleted', 'session.withdrawn')
           ), 0)
       )
       AND NOT EXISTS (
         SELECT 1 FROM orch_p_turn AS projected
         LEFT JOIN orch_p_run AS run ON run.run_id = projected.run_id
         WHERE projected.session_key = discovery.session_key
           AND (projected.rev_seq < discovery.seq OR (run.intent_seq < discovery.seq AND NOT EXISTS (
             SELECT 1 FROM orch_event AS began WHERE began.run_id = projected.run_id AND began.type = 'turn.began'
           )))
       )
   )`,
  // Compaction can erase the discovery event but retains the scanner's verified frontier.
  // Only use it for a session with no projected turns, where their order cannot be ambiguous.
  `UPDATE orch_p_session SET legacy = 1
   WHERE legacy = 0
     AND NOT EXISTS (SELECT 1 FROM orch_p_turn WHERE session_key = orch_p_session.session_key)
     AND EXISTS (
       SELECT 1 FROM orch_meta AS frontier
       WHERE frontier.key = 'catalog_transcript:' || orch_p_session.session_key
         AND CASE WHEN json_valid(frontier.value) THEN
           json_extract(frontier.value, '$.source.provider') = orch_p_session.provider
           AND json_extract(frontier.value, '$.source.nativeSessionId') =
             COALESCE(json_extract(orch_p_session.catalog, '$.nativeSessionId'), orch_p_session.session_key)
           AND json_extract(frontier.value, '$.extent.size') > 0
           AND json_extract(frontier.value, '$.reference') LIKE 'transcript:%#bytes=%,sha256=%'
         ELSE FALSE END
     )`,
  "UPDATE orch_meta SET value = '4' WHERE key = 'projection_schema_version'"
]

/**
 * B3: native identity bindings and their tombstones move out of `orch_event`.
 * `UNIQUE(provider, profile, cwd, native_id)` makes a second key impossible, and a binding is
 * never reassigned after deletion, so a pruned event log can no longer resurrect a deleted session.
 */
const ORCH_DDL_V7: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS orch_binding (
    provider TEXT NOT NULL,
    profile TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL DEFAULT '',
    native_id TEXT NOT NULL,
    session_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER,
    delete_epoch INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider, profile, cwd, native_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_orch_binding_deleted ON orch_binding(deleted_at, session_key)`,
  // Backfill from projections that already carry a catalog identity.
  `INSERT OR IGNORE INTO orch_binding (provider, profile, cwd, native_id, session_key, created_at)
   SELECT COALESCE(provider, 'legacy_unknown'), COALESCE(profile, ''), COALESCE(cwd, ''),
          json_extract(catalog, '$.nativeSessionId'), session_key, ts
   FROM orch_p_session
   WHERE json_extract(catalog, '$.nativeSessionId') IS NOT NULL`,
  // Backfill tombstones from retired sessions still present in the event log.
  `UPDATE orch_binding SET deleted_at = (
     SELECT MAX(retiring.at) FROM orch_event AS retiring
     WHERE retiring.type IN ('session.deleted', 'session.withdrawn')
       AND retiring.session_key = orch_binding.session_key
   )
   WHERE deleted_at IS NULL AND EXISTS (
     SELECT 1 FROM orch_event AS retiring
     WHERE retiring.type IN ('session.deleted', 'session.withdrawn')
       AND retiring.session_key = orch_binding.session_key
   )`,
  "UPDATE orch_meta SET value = '5' WHERE key = 'projection_schema_version'"
]

/**
 * B2: dispatch-ledger metadata was read back out of `run.intent_recorded` events, which made the
 * event log a durable index that pruning could never touch. It now lives on the run projection.
 */
const ORCH_DDL_V8: readonly string[] = [
  'ALTER TABLE orch_p_run ADD COLUMN intent_command_id TEXT',
  'ALTER TABLE orch_p_run ADD COLUMN intent_at INTEGER',
  'ALTER TABLE orch_p_run ADD COLUMN intent_detail_sha256 TEXT',
  `UPDATE orch_p_run SET
     intent_command_id = (SELECT command_id FROM orch_event WHERE type = 'run.intent_recorded' AND run_id = orch_p_run.run_id),
     intent_at = (SELECT at FROM orch_event WHERE type = 'run.intent_recorded' AND run_id = orch_p_run.run_id),
     intent_detail_sha256 = (
       SELECT json_extract(payload, '$.intentDetailSha256') FROM orch_event
       WHERE type = 'run.intent_recorded' AND run_id = orch_p_run.run_id
         AND json_extract(payload, '$.intentDetailSha256') IS NOT NULL
     )`,
  "UPDATE orch_meta SET value = '6' WHERE key = 'projection_schema_version'"
]

/** B1: the outbox needs its own session key to enforce per-session FIFO without reading the log. */
const ORCH_DDL_V9: readonly string[] = [
  'ALTER TABLE orch_outbox ADD COLUMN session_key TEXT',
  `UPDATE orch_outbox SET session_key = COALESCE(
     json_extract(payload, '$.sessionKey'),
     (SELECT r.session_key FROM orch_p_run r WHERE r.run_id = orch_outbox.run_id)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_orch_outbox_fifo ON orch_outbox(session_key, state, causation_seq, effect_id)'
]

/**
 * C1: which Provider sessions are open, and why they were released. The App can only claim a
 * session was reused or released if this row exists, so the reason is a stored fact rather than a
 * log line. Rows are never pruned: one row per opened session is the audit trail.
 */
const ORCH_DDL_V10: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS orch_provider_session (
     key TEXT PRIMARY KEY,
     provider TEXT NOT NULL,
     session_key TEXT,
     native_session_id TEXT,
     opened_at INTEGER NOT NULL,
     last_used_at INTEGER NOT NULL,
     released_at INTEGER,
     release_reason TEXT
   )`,
  'CREATE INDEX IF NOT EXISTS idx_orch_provider_session_released ON orch_provider_session(released_at)'
]

export const ORCHESTRATION_MIGRATIONS: readonly (readonly string[])[] = [
  ORCH_DDL_V1, ORCH_DDL_V2, ORCH_DDL_V3, ORCH_DDL_V4, ORCH_DDL_V5, ORCH_DDL_V6, ORCH_DDL_V7, ORCH_DDL_V8,
  ORCH_DDL_V9, ORCH_DDL_V10
]
