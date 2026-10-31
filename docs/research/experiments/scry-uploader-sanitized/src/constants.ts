export const VERSION = '0.2.3'
export const UPLOADER_VERSION = `scry-uploader/${VERSION}`
export const REDACTION_VERSION = 'none'
export const LEGACY_REDACTION_VERSION = 'agent-turn-v1'

export const MCP_SERVER = 'agent-trace-service'
export const MCP_TOOL = 'submitTurns'
export const MCP_SKILL = 'agent-trace-skill'

export const EXPORT_LIMIT = 100
export const MAX_RECORD_BYTES = 9 * 1024 * 1024
export const MAX_BATCH_BYTES = 512 * 1024
export const MAX_BATCH_RECORDS = 5
export const TRANSPORT_TIMEOUT_SECONDS = 110
export const UPLOAD_DEADLINE_SECONDS = 270
export const TIMEOUT_RETRY_BASE_SECONDS = 60
export const TIMEOUT_RETRY_MAX_SECONDS = 15 * 60

export const JOB_MAX_ATTEMPTS = 6
export const JOB_BACKOFF_BASE_MS = 1_000
export const JOB_BACKOFF_MAX_MS = 60_000
export const PROVIDERS = ['claude', 'codex', 'qoder', 'opencode', 'pi'] as const
export type Provider = (typeof PROVIDERS)[number]
