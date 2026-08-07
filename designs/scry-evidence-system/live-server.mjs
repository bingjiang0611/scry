import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const here = resolve(fileURLToPath(new URL('.', import.meta.url)))
const root = resolve(process.env.SCRY_DESIGNS_ROOT || join(here, '..'))
const userData = resolve(process.env.SCRY_USER_DATA || join(homedir(), 'Library', 'Application Support', 'scry'))
const dbPath = resolve(process.env.SCRY_DB_PATH || join(userData, 'scry.db'))
const host = '127.0.0.1'
const port = Number(process.env.SCRY_PREVIEW_PORT || 4313)
const maxTurns = 40
const maxTraceRows = 12

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
}

const secretPatterns = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[po]_[A-Za-z0-9]{36}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
  /\bBasic\s+[A-Za-z0-9+/]{12,}={0,2}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g,
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss):\/\/[^\s"'<>]+/gi,
  /\bhttps?:\/\/[^/\s:@]+:[^@\s/]+@[^\s"'<>]+/gi,
]

const secretKeyNames = new Set([
  'access_token', 'api_key', 'auth_token', 'authorization', 'client_secret', 'cookie',
  'database_url', 'db_url', 'password', 'passwd', 'private_key', 'pwd', 'refresh_token',
  'secret', 'secret_access_key', 'session_token', 'set_cookie', 'token',
])

function isSecretKey(key) {
  const normalized = String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase()
  if (secretKeyNames.has(normalized)) return true
  if (['access_token', 'api_key', 'auth_token', 'client_secret', 'database_url', 'db_url', 'password', 'passwd', 'private_key', 'pwd', 'refresh_token', 'secret', 'secret_access_key', 'session_token'].some((suffix) => normalized.endsWith(`_${suffix}`))) return true
  return /^(?:anthropic|aws|azure|github|gitlab|google|mongodb|mysql|npm|openai|postgres|slack|stripe|supabase|vercel)_/.test(normalized)
    && /(?:key|password|pwd|secret|token)$/.test(normalized)
}

function safeText(value, limit = 600) {
  if (value == null) return ''
  let text = String(value)
  for (const pattern of secretPatterns) text = text.replace(pattern, '«REDACTED»')
  text = text
    .replace(/([?&](?:_dt_[a-z]+|access_token|auth|code|key|password|pwd|refresh_token|secret|session_token|sig|signature|token)=)[^&#\s"']+/gi, '$1«REDACTED»')
    .replace(/((?:["']?(?:access_token|accessToken|api_key|apiKey|auth_token|authToken|authorization|awsSecretAccessKey|client_secret|clientSecret|cookie|database_url|databaseUrl|db_url|dbUrl|password|passwd|private_key|privateKey|pwd|refresh_token|refreshToken|secret|secret_access_key|secretAccessKey|session_token|sessionToken|set-cookie|setCookie|token)["']?)\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;]+)/gi, '$1«REDACTED»')
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function safeObject(value, depth = 0) {
  if (depth > 4) return '…'
  if (typeof value === 'string') return safeText(value, 900)
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeObject(item, depth + 1))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [key, isSecretKey(key) ? '«REDACTED»' : safeObject(item, depth + 1)]))
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

function fmtToken(value) {
  if (!Number.isFinite(value)) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(Math.round(value))
}

function totalTokens(providerId, usage = {}) {
  const input = Number.isFinite(usage.inputTokens) ? usage.inputTokens : Number.isFinite(usage.input) ? usage.input : null
  const output = Number.isFinite(usage.outputTokens) ? usage.outputTokens : Number.isFinite(usage.output) ? usage.output : null
  if (input == null || output == null) return null
  const cacheRead = Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : Number.isFinite(usage.cacheRead) ? usage.cacheRead : 0
  const cacheWrite = Number.isFinite(usage.cacheCreationTokens) ? usage.cacheCreationTokens : Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : Number.isFinite(usage.cacheWrite) ? usage.cacheWrite : 0
  return input + output + (providerId === 'codex' ? 0 : cacheRead + cacheWrite)
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function asTime(value) {
  if (Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value) return 0
  const parsed = Date.parse(value)
  if (Number.isFinite(parsed)) return parsed
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

function eventTime(item) {
  return asTime(item?.startedAt) || asTime(item?.ts)
}

function archiveDir(session) {
  const cwdKey = session.cwd ? `cwd-${hash(session.cwd)}` : 'unbound'
  return join(userData, 'trace-archive-turns-v1', session.provider_id, cwdKey, `sid-${hash(session.external_session_id)}`)
}

async function trustedDirectory(rootDir, dirPath) {
  try {
    const trustedRoot = resolve(rootDir)
    const trustedDir = resolve(dirPath)
    const relativeDir = relative(trustedRoot, trustedDir)
    if (isAbsolute(relativeDir) || relativeDir === '..' || relativeDir.startsWith(`..${sep}`)) return false
    const rootInfo = await lstat(trustedRoot)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return false
    const realRoot = await realpath(trustedRoot)
    let current = trustedRoot
    for (const part of relativeDir.split(sep).filter(Boolean)) {
      current = join(current, part)
      const currentInfo = await lstat(current)
      if (!currentInfo.isDirectory() || currentInfo.isSymbolicLink()) return false
      const fromRoot = relative(realRoot, await realpath(current))
      if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) return false
    }
    return true
  } catch {
    return false
  }
}

async function trustedRegularFile(rootDir, filePath) {
  try {
    const trustedRoot = resolve(rootDir)
    const trustedFile = resolve(filePath)
    const parent = dirname(trustedFile)
    const relativeParent = relative(trustedRoot, parent)
    if (isAbsolute(relativeParent) || relativeParent === '..' || relativeParent.startsWith(`..${sep}`)) return null

    const rootInfo = await lstat(trustedRoot)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return null
    const realRoot = await realpath(trustedRoot)
    let current = trustedRoot
    for (const part of relativeParent.split(sep).filter(Boolean)) {
      current = join(current, part)
      const currentInfo = await lstat(current)
      if (!currentInfo.isDirectory() || currentInfo.isSymbolicLink()) return null
      const fromRoot = relative(realRoot, await realpath(current))
      if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) return null
    }

    const fileInfo = await lstat(trustedFile)
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) return null
    const fromRoot = relative(realRoot, await realpath(trustedFile))
    return isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) ? null : fileInfo
  } catch {
    return null
  }
}

async function readArchivedTurns(session) {
  const dir = archiveDir(session)
  if (!await trustedDirectory(userData, dir)) return []
  let names
  try { names = await readdir(dir) } catch { return [] }
  const turns = []
  for (const name of names.filter((item) => /^turn-[a-f0-9]{64}\.json$/.test(item))) {
    try {
      const path = join(dir, name)
      if (!await trustedRegularFile(userData, path)) continue
      const archive = JSON.parse(await readFile(path, 'utf8'))
      if (archive.cwd !== session.cwd || archive.sessionId !== session.external_session_id || archive.externalSessionId !== session.external_session_id || archive.providerId !== session.provider_id) continue
      turns.push(...(Array.isArray(archive.turns) ? archive.turns : []))
    } catch { /* a partial archive should not take down the preview */ }
  }
  const unique = new Map()
  for (const turn of turns.sort((a, b) => eventTime(a) - eventTime(b))) {
    unique.set(turn.runId || `${turn.startedAt || turn.ts}:${turn.userText || ''}`, turn)
  }
  return [...unique.values()].slice(-maxTurns)
}

function evidenceValue(evidence, key, fallback) {
  const item = evidence?.[key]
  return item?.status === 'available' || item?.status === 'partial' ? item.value : fallback
}

function traceDetail(item) {
  const input = item.input && typeof item.input === 'object' ? item.input : {}
  return safeText(input.description || input.command || input.file_path || input.path || JSON.stringify(input), 260) || '无参数摘要'
}

function mapTraceItem(item, kind) {
  const status = item.status === 'success' || item.status === 'completed' ? 'passed'
    : item.status === 'cancelled' ? 'warning'
      : item.status === 'failed' || item.status === 'error' || item.isError ? 'failed'
        : item.status === 'started' || item.status === 'running' ? 'running' : 'unknown'
  const name = item.name || item.tool || (kind === 'skill' ? 'Skill' : kind === 'mcp' ? 'MCP' : 'Tool')
  const rawId = item.id || `${item.order || eventTime(item) || 0}-${name}`
  return {
    id: `${kind}:${rawId}`,
    rawId,
    kind,
    label: safeText(name, 90),
    detail: traceDetail(item),
    duration: fmtDuration(item.durationMs),
    status,
    io: name === 'Read' ? 'R' : name === 'Write' ? 'W' : name === 'Edit' || name === 'MultiEdit' ? 'E' : undefined,
    output: safeText(item.outputSummary || item.output || item.text, 650),
    order: item.order ?? (eventTime(item) || Number.MAX_SAFE_INTEGER),
  }
}

function mapOrderedBlocks(turn, tools, skills, mcps, assistantText) {
  const toolById = new Map(tools.map((item) => [item.id, item]))
  const skillById = new Map(skills.map((item) => [item.id, item]))
  const mcpById = new Map(mcps.map((item) => [item.id, item]))
  const toolResults = new Map((turn.items || []).filter((item) => item.kind === 'tool' && item.stage === 'tool_result').map((item) => [item.toolUseId, item]))
  const blocks = []
  const pushText = (kind, item) => {
    const value = safeText(item.text || item.output || '', kind === 'thinking' ? 1400 : 4000)
    if (!value) return
    const previous = blocks.at(-1)
    if (previous?.kind === kind) previous.text = safeText(`${previous.text}\n${value}`, kind === 'thinking' ? 1400 : 4000)
    else blocks.push({ id: `${kind}:${item.id || blocks.length}`, rawId: item.id, kind, text: value, order: asTime(item.ts) || blocks.length })
  }
  for (const item of [...(turn.items || [])].sort((a, b) => eventTime(a) - eventTime(b))) {
    if (item.kind === 'model' && (item.stage === 'text_delta' || item.stage === 'text')) {
      pushText('assistant', item)
      continue
    }
    if (item.kind === 'model' && item.stage === 'thinking') {
      pushText('thinking', item)
      continue
    }
    if (item.kind === 'skill') {
      blocks.push(mapTraceItem(skillById.get(item.toolUseId) || { ...item, id: item.toolUseId }, 'skill'))
      continue
    }
    if (item.kind === 'agent') {
      blocks.push(mapTraceItem({ ...item, id: item.toolUseId || item.id, name: `Agent · ${item.name || item.tool || 'subtask'}` }, 'tool'))
      continue
    }
    if (item.kind !== 'tool' || item.stage === 'tool_result') continue
    const result = toolResults.get(item.toolUseId)
    const isMcp = item.isMcp || String(item.tool || '').startsWith('mcp__')
    const evidence = (isMcp ? mcpById : toolById).get(item.toolUseId) || {
      ...item,
      id: item.toolUseId || item.id,
      startedAt: item.ts,
      completedAt: result?.ts,
      durationMs: result?.durationMs,
      status: result?.isError ? 'error' : result ? 'success' : 'running',
      outputSummary: result?.output,
    }
    blocks.push(mapTraceItem(evidence, isMcp ? 'mcp' : 'tool'))
  }
  if (!blocks.some((block) => block.kind === 'assistant') && assistantText) {
    blocks.push({ id: `${turn.runId}-assistant`, kind: 'assistant', text: assistantText, order: Number.MAX_SAFE_INTEGER })
  }
  if (blocks.length) {
    const visible = blocks.slice(0, maxTraceRows + 8)
    const finalAssistant = [...blocks].reverse().find((block) => block.kind === 'assistant')
    if (finalAssistant && !visible.includes(finalAssistant)) visible[visible.length - 1] = finalAssistant
    return visible
  }
  const fallback = [
    ...tools.map((item) => mapTraceItem(item, 'tool')),
    ...skills.map((item) => mapTraceItem(item, 'skill')),
    ...mcps.map((item) => mapTraceItem(item, 'mcp')),
  ].sort((a, b) => a.order - b.order).slice(0, maxTraceRows)
  if (assistantText) fallback.push({ id: `${turn.runId}-assistant`, kind: 'assistant', text: assistantText })
  return fallback
}

function mapTurn(turn, providerId, index) {
  const evidence = turn.turnEvidence || {}
  const usage = evidenceValue(evidence, 'usage', {}) || {}
  const tools = evidenceValue(evidence, 'tools', []) || []
  const skills = evidenceValue(evidence, 'skills', []) || []
  const mcps = evidenceValue(evidence, 'mcps', []) || []
  const hooks = evidenceValue(evidence, 'hooks', []) || []
  const files = evidenceValue(evidence, 'files', []) || []
  const errors = evidenceValue(evidence, 'errors', []) || []
  const dangers = evidenceValue(evidence, 'dangerousOperations', []) || []
  const assistant = evidenceValue(evidence, 'assistant', {}) || {}
  const user = evidenceValue(evidence, 'user', {}) || {}
  const diffs = evidenceValue(evidence, 'diff', []) || []
  const diff = diffs[diffs.length - 1]
  const assistantText = safeText(assistant.text || assistant.value?.text || '', 4000)
  const blocks = mapOrderedBlocks(turn, tools, skills, mcps, assistantText)
  const tokens = totalTokens(providerId, usage)
  const hookEvidenceState = evidence.hooks?.status === 'available'
    ? 'exact'
    : evidence.hooks?.status === 'partial' ? 'partial' : 'unknown'
  const hookEvidenceKnown = hookEvidenceState !== 'unknown'
  const input = Number.isFinite(usage.inputTokens) ? usage.inputTokens : null
  const output = Number.isFinite(usage.outputTokens) ? usage.outputTokens : null
  const cacheRead = Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : null
  const cacheWrite = Number.isFinite(usage.cacheCreationTokens) ? usage.cacheCreationTokens : Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : null
  return {
    id: `turn-${String(index + 1).padStart(2, '0')}`,
    index: String(index + 1).padStart(2, '0'),
    runId: turn.runId,
    state: turn.done || turn.status === 'completed' ? 'complete' : 'running',
    startedAt: turn.startedAt || turn.ts || null,
    completedAt: turn.completedAt || null,
    durationMs: Number.isFinite(turn.durationMs) ? turn.durationMs : null,
    user: safeText(user.text || user.value?.text || turn.userText || '（用户文本未捕获）', 2200),
    duration: fmtDuration(turn.durationMs),
    tokens: tokens == null ? '未捕获' : `${fmtToken(tokens)} tok`,
    tokenValue: tokens,
    tools: tools.length + skills.length + mcps.length,
    errors: evidence.errors?.status === 'available' || evidence.errors?.status === 'partial' ? errors.length : blocks.filter((item) => item.status === 'failed').length,
    dangers: dangers.length,
    diff: {
      files: Array.isArray(diff?.files) ? diff.files.length : files.length,
      label: '本轮改动',
      detail: diff?.status === 'available' || Array.isArray(diff?.files)
        ? `${Array.isArray(diff.files) ? diff.files.length : 0} files`
        : '未捕获 Git 快照',
      status: diff?.status || evidence.diff?.status || 'unavailable',
    },
    hooks: hooks.slice(0, 8).map((hook) => ({
      label: safeText(hook.event || hook.name, 90),
      detail: `${hook.lifecycleEvents || 1} events · ${fmtDuration(hook.durationMs)}`,
      status: hook.status === 'success' ? 'passed' : hook.status === 'cancelled' ? 'warning' : hook.status === 'failed' || hook.status === 'error' ? 'failed' : 'unknown',
    })),
    hookEvidenceState,
    hookCount: hookEvidenceKnown ? hooks.length : null,
    hookEventCount: hookEvidenceKnown ? hooks.reduce((sum, hook) => sum + (Number.isFinite(hook.lifecycleEvents) ? hook.lifecycleEvents : 1), 0) : null,
    hookSummary: hookEvidenceKnown ? {
      passed: hooks.filter((hook) => hook.status === 'success').length,
      cancelled: hooks.filter((hook) => hook.status === 'cancelled').length,
      failed: hooks.filter((hook) => hook.status === 'failed' || hook.status === 'error').length,
      unknown: hooks.filter((hook) => !['success', 'cancelled', 'failed', 'error'].includes(hook.status)).length,
    } : null,
    fileCount: files.length,
    mcpCount: mcps.length + tools.filter((tool) => tool.category === 'mcp' || tool.mcpServer).length,
    skillCount: skills.length + tools.filter((tool) => tool.category === 'skill').length,
    agentCount: tools.filter((tool) => tool.category === 'agent').length,
    blocks,
    footer: {
      input: fmtToken(input),
      output: fmtToken(output),
      cacheRead: fmtToken(cacheRead),
      cacheWrite: fmtToken(cacheWrite),
      api: fmtDuration(usage.apiDurationMs),
      files: files.length,
    },
    usage: safeObject(usage),
    transcriptAvailable: true,
    usageSource: 'trace archive',
    observedSkills: skills.map((item) => safeText(item.name || item.tool || 'Skill', 90)),
    observedMcps: mcps.map((item) => ({ server: safeText(item.mcp?.server || String(item.name || item.tool || '').replace(/^mcp__/, '').split('__')[0] || 'unknown', 90), tool: safeText(item.mcp?.action || item.mcp?.tool || item.name || item.tool || 'MCP', 120) })),
  }
}

function readLedgerTurns(db, session) {
  const results = db.prepare(`SELECT run_id runId, ts_start startedAt, ts_end completedAt,
    duration_ms durationMs, duration_api_ms apiDurationMs, tokens_in inputTokens,
    tokens_out outputTokens, cache_read_tokens cacheReadTokens,
    cache_creation_tokens cacheCreationTokens, model, is_error isError
    FROM spans WHERE session_id=? AND kind='harness' AND stage='result' ORDER BY ts_start`).all(session.scry_session_id)
  const calls = db.prepare(`SELECT id,run_id runId,kind,tool,mcp_server mcpServer,
    input_preview inputPreview,output_preview outputPreview,is_error isError,
    danger_level dangerLevel,duration_ms durationMs,ts_start startedAt
    FROM spans WHERE session_id=? AND kind IN ('tool','skill','agent') ORDER BY ts_start`).all(session.scry_session_id)
  const files = db.prepare(`SELECT s.run_id runId,f.op mode,f.path label FROM file_ops f
    JOIN spans s ON s.id=f.span_id WHERE f.session_id=? ORDER BY s.ts_start,f.id`).all(session.scry_session_id)
  return results.map((row, index) => {
    const runCalls = calls.filter((call) => call.runId === row.runId)
    const runFiles = files.filter((file) => file.runId === row.runId)
    const usage = {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheCreationTokens: row.cacheCreationTokens,
      apiDurationMs: row.apiDurationMs,
      model: row.model,
    }
    const tokens = totalTokens(session.provider_id, usage)
    const blocks = runCalls.slice(0, maxTraceRows).map((call) => mapTraceItem({
      id: call.id,
      name: call.kind === 'agent' ? `Agent · ${call.tool || 'subtask'}` : call.tool || call.kind,
      input: { preview: call.inputPreview },
      outputSummary: call.outputPreview,
      status: call.isError ? 'failed' : 'success',
      isError: Boolean(call.isError),
      durationMs: call.durationMs,
      startedAt: call.startedAt,
    }, call.mcpServer ? 'mcp' : call.kind === 'skill' ? 'skill' : 'tool'))
    const firstPreview = index === 0 && session.preview ? `首轮预览（非完整 transcript）：${safeText(session.preview, 900)}` : '（完整用户文本未归档；SQLite 仅保存结构化 result）'
    return {
      id: `turn-${String(index + 1).padStart(2, '0')}`,
      index: String(index + 1).padStart(2, '0'),
      runId: row.runId,
      state: 'complete',
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      durationMs: row.durationMs,
      user: firstPreview,
      duration: fmtDuration(row.durationMs),
      tokens: tokens == null ? '未捕获' : `${fmtToken(tokens)} tok`,
      tokenValue: tokens,
      tools: runCalls.length,
      errors: runCalls.filter((call) => call.isError).length,
      dangers: runCalls.filter((call) => call.dangerLevel).length,
      diff: { files: runFiles.length, label: '本轮改动', detail: '未捕获 Git 快照', status: 'unavailable' },
      hooks: [], hookEvidenceState: 'unknown', hookCount: null, hookEventCount: null,
      hookSummary: null,
      fileCount: runFiles.length,
      mcpCount: runCalls.filter((call) => call.mcpServer).length,
      skillCount: runCalls.filter((call) => call.kind === 'skill').length,
      agentCount: runCalls.filter((call) => call.kind === 'agent').length,
      blocks,
      footer: { input: fmtToken(row.inputTokens), output: fmtToken(row.outputTokens), cacheRead: fmtToken(row.cacheReadTokens), cacheWrite: fmtToken(row.cacheCreationTokens), api: fmtDuration(row.apiDurationMs), files: runFiles.length },
      usage: safeObject(usage),
      transcriptAvailable: false,
      usageSource: 'SQLite result',
      observedSkills: runCalls.filter((call) => call.kind === 'skill').map((call) => safeText(call.tool || 'Skill', 90)),
      observedMcps: runCalls.filter((call) => call.mcpServer).map((call) => ({ server: safeText(call.mcpServer, 90), tool: safeText(call.tool || 'MCP', 120) })),
    }
  })
}

function mergeTurns(archiveTurns, ledgerTurns) {
  const archiveByRun = new Map(archiveTurns.map((turn) => [turn.runId, turn]))
  const merged = ledgerTurns.map((ledger) => {
    const archived = archiveByRun.get(ledger.runId)
    if (!archived) return ledger
    archiveByRun.delete(ledger.runId)
    const ledgerHasTokens = Number.isFinite(ledger.tokenValue)
    return {
      ...archived,
      startedAt: archived.startedAt || ledger.startedAt,
      completedAt: archived.completedAt || ledger.completedAt,
      durationMs: archived.durationMs ?? ledger.durationMs,
      duration: archived.duration === '—' ? ledger.duration : archived.duration,
      tokenValue: Number.isFinite(archived.tokenValue) ? archived.tokenValue : ledger.tokenValue,
      tokens: Number.isFinite(archived.tokenValue) || !ledgerHasTokens ? archived.tokens : ledger.tokens,
      usage: Number.isFinite(archived.tokenValue) || !ledgerHasTokens ? archived.usage : ledger.usage,
      usageSource: Number.isFinite(archived.tokenValue) || !ledgerHasTokens ? archived.usageSource : ledger.usageSource,
      footer: Number.isFinite(archived.tokenValue) || !ledgerHasTokens ? archived.footer : { ...archived.footer, ...ledger.footer },
      fileCount: Math.max(archived.fileCount, ledger.fileCount),
    }
  })
  merged.push(...archiveByRun.values())
  return merged.sort((a, b) => eventTime(a) - eventTime(b)).map((turn, index) => ({ ...turn, id: `turn-${String(index + 1).padStart(2, '0')}`, index: String(index + 1).padStart(2, '0') }))
}

function isoDay(ms) {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function startOfDay(ms) {
  const date = new Date(ms)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function buildAnalytics(db, now) {
  const start30 = startOfDay(now) - 29 * 86_400_000
  const start90 = startOfDay(now) - 89 * 86_400_000
  const results = db.prepare(`SELECT s.ts_start ts, r.provider_id provider, s.tokens_in input, s.tokens_out output,
    s.cache_read_tokens cacheRead, s.cache_creation_tokens cacheWrite
    FROM spans s LEFT JOIN session_refs r ON r.scry_session_id=s.session_id
    WHERE s.kind='harness' AND s.stage='result' AND s.ts_start>=? ORDER BY s.ts_start`).all(start90)
  const tools = db.prepare(`SELECT s.tool label, COALESCE(r.provider_id, 'unknown') provider, COUNT(*) calls, CAST(AVG(s.duration_ms) AS INTEGER) avgMs,
    SUM(CASE WHEN is_error=1 THEN 1 ELSE 0 END) errors FROM spans
    s LEFT JOIN session_refs r ON r.scry_session_id=s.session_id
    WHERE s.kind IN ('tool','skill','agent') AND s.tool IS NOT NULL AND s.ts_start>=?
    GROUP BY s.tool,r.provider_id ORDER BY calls DESC LIMIT 8`).all(start30)
  const dangers = db.prepare(`SELECT s.ts_start ts, s.danger_level level, r.provider_id provider FROM spans s
    LEFT JOIN session_refs r ON r.scry_session_id=s.session_id
    WHERE s.danger_level IS NOT NULL AND s.ts_start>=?`).all(start90)
  const current = results.filter((row) => row.ts >= start30)
  const days = Array.from({ length: 30 }, (_, index) => {
    const start = start30 + index * 86_400_000
    const rows = current.filter((row) => row.ts >= start && row.ts < start + 86_400_000)
    const known = rows.filter((row) => totalTokens(row.provider, row) != null)
    const value = known.reduce((sum, row) => sum + totalTokens(row.provider, row), 0)
    const byProvider = Object.entries(rows.reduce((counts, row) => ({ ...counts, [row.provider || 'unknown']: (counts[row.provider || 'unknown'] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1])
    return { id: `day-${index + 1}`, label: isoDay(start).slice(5), value: Math.round(value / 1000), status: !rows.length ? 'zero' : known.length === rows.length ? 'exact' : 'partial', turns: rows.length, provider: byProvider[0]?.[0] || 'unknown' }
  })
  const riskDays = Array.from({ length: 90 }, (_, index) => {
    const start = start90 + index * 86_400_000
    const rows = dangers.filter((row) => row.ts >= start && row.ts < start + 86_400_000)
    const providerLevels = Object.fromEntries(['claude', 'codex', 'qoder', 'opencode'].map((provider) => {
      const providerRows = rows.filter((row) => row.provider === provider)
      return [provider, providerRows.some((row) => row.level === 'danger') ? 'danger' : providerRows.length ? 'warn' : 'zero']
    }))
    return { id: `risk-${index}`, level: rows.some((row) => row.level === 'danger') ? 'danger' : rows.length ? 'warn' : 'zero', providers: providerLevels }
  })
  const providers = ['claude', 'codex', 'qoder', 'opencode'].map((id) => {
    const rows = current.filter((row) => row.provider === id)
    const known = rows.filter((row) => totalTokens(id, row) != null)
    const input = known.reduce((sum, row) => sum + row.input, 0)
    const cacheRead = rows.reduce((sum, row) => sum + (row.cacheRead || 0), 0)
    const cacheWrite = rows.reduce((sum, row) => sum + (row.cacheWrite || 0), 0)
    const promptTokens = input + (id === 'codex' ? 0 : cacheRead + cacheWrite)
    const classified = id === 'claude' || id === 'qoder'
    const providerDangers = dangers.filter((row) => row.provider === id)
    return { id, name: id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex' : id === 'qoder' ? 'Qoder' : 'OpenCode', short: id.toUpperCase(), status: rows.length ? 'ready' : 'unknown', model: '按轮次上报', turns: rows.length, known: known.length, tokens: known.reduce((sum, row) => sum + totalTokens(id, row), 0), cache: promptTokens ? `${Math.round(cacheRead / promptTokens * 1000) / 10}%` : null, danger: classified ? 'classified' : 'unsupported', dangerText: classified ? `${providerDangers.filter((row) => row.level === 'danger').length} danger · ${providerDangers.filter((row) => row.level !== 'danger').length} warn` : '未支持分类' }
  })
  return {
    providers,
    analytics: {
      totalKnown: providers.reduce((sum, provider) => sum + provider.tokens, 0),
      turns: current.length,
      knownTurns: providers.reduce((sum, provider) => sum + provider.known, 0),
      activeDays: days.filter((day) => day.turns > 0).length,
      days,
      tools: tools.map((tool) => ({ label: tool.label, provider: tool.provider, calls: tool.calls, avg: fmtDuration(tool.avgMs), errors: tool.errors })),
      riskDays,
    },
  }
}

function buildOverview(db, session, turns) {
  const spanRows = db.prepare(`SELECT run_id runId, kind, tool, mcp_server mcpServer, is_error isError,
    danger_level dangerLevel, duration_ms durationMs, duration_api_ms apiMs, tokens_in input,
    tokens_out output, cache_read_tokens cacheRead, cache_creation_tokens cacheWrite, model
    FROM spans WHERE session_id=? ORDER BY ts_start`).all(session.scry_session_id)
  const toolRows = spanRows.filter((row) => ['tool', 'skill', 'agent'].includes(row.kind))
  const resultRows = spanRows.filter((row) => row.kind === 'harness')
  const knownTurns = turns.filter((turn) => Number.isFinite(turn.tokenValue))
  const tokenTotal = knownTurns.reduce((sum, turn) => sum + turn.tokenValue, 0)
  const errors = toolRows.filter((row) => row.isError).length
  const dangers = toolRows.filter((row) => row.dangerLevel)
  const mcpCalls = toolRows.filter((row) => row.mcpServer).length
  const skillCalls = toolRows.filter((row) => row.kind === 'skill').length
  const agentCalls = toolRows.filter((row) => row.kind === 'agent').length
  const contextTurn = [...turns].reverse().find((turn) => Number.isFinite(turn.usage?.contextTokens) && Number.isFinite(turn.usage?.contextWindow))
  const context = contextTurn ? {
    pct: Math.round(contextTurn.usage.contextTokens / contextTurn.usage.contextWindow * 100),
    model: contextTurn.usage.model || resultRows.at(-1)?.model || '未上报',
    used: fmtToken(contextTurn.usage.contextTokens),
    window: fmtToken(contextTurn.usage.contextWindow),
    remaining: fmtToken(Math.max(0, contextTurn.usage.contextWindow - contextTurn.usage.contextTokens)),
    source: '最近一轮完整 prompt÷窗口',
  } : null
  const topTools = db.prepare(`SELECT tool label, COUNT(*) calls,
    SUM(CASE WHEN is_error=1 THEN 1 ELSE 0 END) errors FROM spans
    WHERE session_id=? AND kind IN ('tool','skill','agent') AND tool IS NOT NULL
    GROUP BY tool ORDER BY calls DESC LIMIT 6`).all(session.scry_session_id)
  const maxCalls = Math.max(1, ...topTools.map((tool) => tool.calls))
  const fileRows = db.prepare(`SELECT op mode, path label, COUNT(*) count FROM file_ops
    WHERE session_id=? GROUP BY op,path ORDER BY count DESC LIMIT 12`).all(session.scry_session_id)
  const inputTotal = turns.reduce((sum, turn) => sum + (Number.isFinite(turn.usage?.inputTokens) ? turn.usage.inputTokens : 0), 0)
  const outputTotal = turns.reduce((sum, turn) => sum + (Number.isFinite(turn.usage?.outputTokens) ? turn.usage.outputTokens : 0), 0)
  const cacheReadTotal = turns.reduce((sum, turn) => sum + (Number.isFinite(turn.usage?.cacheReadTokens) ? turn.usage.cacheReadTokens : 0), 0)
  const cacheWriteTotal = turns.reduce((sum, turn) => sum + (Number.isFinite(turn.usage?.cacheCreationTokens) ? turn.usage.cacheCreationTokens : Number.isFinite(turn.usage?.cacheWriteTokens) ? turn.usage.cacheWriteTokens : 0), 0)
  const apiTotal = turns.reduce((sum, turn) => sum + (Number.isFinite(turn.usage?.apiDurationMs) ? turn.usage.apiDurationMs : 0), 0)
  const apiKnownTurns = turns.filter((turn) => Number.isFinite(turn.usage?.apiDurationMs)).length
  const dangerCoverage = session.provider_id === 'claude' || session.provider_id === 'qoder'
  const totalCalls = toolRows.length
  const tokenState = !turns.length ? 'unknown' : knownTurns.length === turns.length ? 'exact' : knownTurns.length ? 'partial' : 'unknown'
  const metrics = [
    { label: '总 TOKEN', value: knownTurns.length ? fmtToken(tokenTotal) : '—', state: tokenState, note: `${knownTurns.length} / ${turns.length} 轮已捕获` },
    { label: '输入 / 输出', value: knownTurns.length ? fmtToken(inputTotal + outputTotal) : '—', state: tokenState, note: knownTurns.length ? `${knownTurns.length === turns.length ? '' : '已知下界 · '}in ${fmtToken(inputTotal)} · out ${fmtToken(outputTotal)}` : '当前会话未捕获输入 / 输出 Token' },
    { label: '调用', value: String(totalCalls), state: 'exact', note: `工具 ${totalCalls - mcpCalls - skillCalls - agentCalls} · MCP ${mcpCalls} · Skill ${skillCalls}` },
    { label: '危险', value: dangerCoverage ? String(dangers.length) : '未支持', state: dangerCoverage ? dangers.length ? 'warning' : 'zero' : 'unsupported', note: dangerCoverage ? '观测标记 · 默认放行' : `${session.provider_id} 能力边界` },
  ]
  const hookKnownTurns = turns.filter((turn) => Number.isFinite(turn.hookCount) && Number.isFinite(turn.hookEventCount))
  const hookEvidenceState = !hookKnownTurns.length
    ? 'unknown'
    : hookKnownTurns.length === turns.length && hookKnownTurns.every((turn) => turn.hookEvidenceState === 'exact') ? 'exact' : 'partial'
  const hookCount = hookKnownTurns.length ? hookKnownTurns.reduce((sum, turn) => sum + turn.hookCount, 0) : null
  const hookEventCount = hookKnownTurns.length ? hookKnownTurns.reduce((sum, turn) => sum + turn.hookEventCount, 0) : null
  const hookSummaryValue = (key) => hookKnownTurns.length
    ? hookKnownTurns.reduce((sum, turn) => sum + (Number.isFinite(turn.hookSummary?.[key]) ? turn.hookSummary[key] : 0), 0)
    : null
  const mappedTurns = turns.map((turn) => ({
    id: turn.id, index: turn.index, user: turn.user, duration: turn.duration,
    groups: { timing: Number.isFinite(turn.durationMs) ? 1 : 0, intervention: 0, mcp: turn.mcpCount, skill: turn.skillCount, agent: turn.agentCount, hooks: turn.hookEvidenceState === 'partial' ? `≥ ${turn.hookCount}` : turn.hookCount, file: turn.fileCount },
    detail: `API ${turn.footer.api} · 工具 ${turn.tools} 次`,
  }))
  const billingTurns = [...turns].filter((turn) => Number.isFinite(turn.tokenValue)).sort((a, b) => b.tokenValue - a.tokenValue).slice(0, 8).map((turn) => ({
    id: turn.id, index: turn.index, total: fmtToken(turn.tokenValue), cache: (() => { const prompt = (turn.usage?.inputTokens || 0) + (session.provider_id === 'codex' ? 0 : (turn.usage?.cacheReadTokens || 0) + (turn.usage?.cacheCreationTokens || turn.usage?.cacheWriteTokens || 0)); return prompt ? `${Math.round((turn.usage.cacheReadTokens || 0) / prompt * 100)}%` : '—' })(), io: `${turn.footer.input} / ${turn.footer.output}`, tools: turn.tools, context: Number.isFinite(turn.usage?.contextTokens) && Number.isFinite(turn.usage?.contextWindow) ? `${Math.round(turn.usage.contextTokens / turn.usage.contextWindow * 100)}%` : '—',
  }))
  const completedTurns = turns.filter((turn) => turn.state === 'complete').length
  const runningTurns = turns.filter((turn) => turn.state === 'running').length
  return {
    context,
    verdict: turns.length ? `${completedTurns} 轮完成${runningTurns ? ` · ${runningTurns} 轮运行中` : ''} · ${errors} 处工具报错` : '暂无已完成轮次；保留已观测调用',
    verdictState: errors ? 'warning' : runningTurns ? 'partial' : turns.length ? 'exact' : 'unknown',
    metrics,
    cache: [{ label: 'CACHE·R', value: knownTurns.length ? fmtToken(cacheReadTotal) : '—' }, { label: 'CACHE·W', value: knownTurns.length ? fmtToken(cacheWriteTotal) : '—' }, { label: 'API', value: apiKnownTurns ? fmtDuration(apiTotal) : '—' }],
    sessionId: session.external_session_id,
    compactions: spanRows.filter((row) => row.kind === 'context_compaction').length,
    turns: mappedTurns,
    tools: topTools.map((tool) => ({ ...tool, score: Math.round(tool.calls / maxCalls * 100) })),
    hooks: { state: hookEvidenceState, coverage: `${hookKnownTurns.length} / ${turns.length} 轮`, runs: hookCount, events: hookEventCount, passed: hookSummaryValue('passed'), cancelled: hookSummaryValue('cancelled'), failed: hookSummaryValue('failed'), unknown: hookSummaryValue('unknown') },
    segments: [{ label: 'SQLite span ledger', value: `${totalCalls} calls`, note: '当前 session' }],
    calls: [{ label: '工具', value: String(totalCalls - mcpCalls - skillCalls - agentCalls), note: '结构化 spans' }, { label: 'MCP', value: String(mcpCalls), note: '不拆分 Token' }, { label: 'Skill', value: String(skillCalls), note: '调用次数' }, { label: '子 Agent', value: String(agentCalls), note: '无独立 usage' }],
    files: fileRows.map((file) => ({ ...file, label: safeText(file.label, 150) })),
    billing: {
      status: turns.length && knownTurns.length === turns.length ? 'Token 统计' : knownTurns.length ? '部分 Token' : 'Token 未捕获',
      source: '本会话可验证 token', policy: '仅看 token，不算金额',
      metrics: [{ label: '总 TOKEN', value: knownTurns.length ? fmtToken(tokenTotal) : '—' }, { label: '输入 / 输出', value: knownTurns.length ? `${fmtToken(inputTotal)} / ${fmtToken(outputTotal)}` : '—' }, { label: '缓存读 / 写', value: knownTurns.length ? `${fmtToken(cacheReadTotal)} / ${fmtToken(cacheWriteTotal)}` : '—' }, { label: 'API 耗时', value: apiKnownTurns ? fmtDuration(apiTotal) : '—' }],
      coverage: [`轮次覆盖 ${knownTurns.length}/${turns.length} · ${turns.length ? Math.round(knownTurns.length / turns.length * 100) : 0}%`, '模型明细按 Provider 上报', '工具拆分 暂无独立 token'],
      signals: errors ? [{ severity: 'warning', title: `${errors} 处工具错误需要复核`, detail: '规则提示 · 不是模型结论' }] : [],
      turns: billingTurns,
    },
    trust: { provider: session.provider_id, status: '运行时状态不在 SQLite', reason: 'SQLite 只记录实际 MCP 调用；live 授权与 MCP Guard 报告需由运行时提供。', live: [] },
  }
}

function clock(value) {
  if (!value) return '—'
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function buildDiagnosticIssues(session, turns, archivedTurnCount, providers, analytics, schemaVersion) {
  const missing = Math.max(0, analytics.turns - analytics.knownTurns)
  const unsupported = providers.filter((provider) => provider.danger === 'unsupported')
  const archivedTurns = archivedTurnCount
  return [
    {
      id: 'coverage', severity: missing ? 'warn' : 'clear', title: missing ? `${missing} 个轮次缺少完整 Token 字段` : 'Token 覆盖完整',
      summary: missing ? '汇总仅展示已知下界；缺字段不替换为 0。' : '近 30 天所有 result 轮次均有 input/output。',
      verdict: missing ? 'partial' : 'exact', value: `${analytics.knownTurns} / ${analytics.turns}`,
      evidence: [['SQLite v' + schemaVersion, 'result spans', `${analytics.knownTurns} 轮字段完整`, analytics.knownTurns ? 'exact' : 'unknown'], ['近 30 天', 'coverage', `${missing} 轮缺字段`, missing ? 'partial' : 'trueZero']],
      action: missing ? '按 Provider 原始 result 核验；汇总继续保留覆盖分母。' : '无需处置。',
    },
    {
      id: 'danger', severity: unsupported.length ? 'unknown' : 'clear', title: unsupported.length ? `${unsupported.length} 个 Provider 不支持危险操作分类` : '危险分类能力完整',
      summary: unsupported.length ? `${unsupported.map((provider) => provider.name).join('、')} 的空白不能解释为“零危险”。` : '四个 Provider 均能输出分类。',
      verdict: unsupported.length ? 'unsupported' : 'exact', value: `${4 - unsupported.length} / 4`,
      evidence: providers.map((provider) => ['能力矩阵', provider.name, provider.danger === 'unsupported' ? 'danger verdict：unsupported' : provider.dangerText, provider.danger]),
      action: unsupported.length ? '保持能力盲区标签；不纳入跨 Provider 安全排名。' : '无需处置。',
    },
    {
      id: 'archive', severity: archivedTurns ? 'clear' : 'warn', title: archivedTurns ? '当前会话 archive 可读' : '当前会话缺少 trace archive',
      summary: archivedTurns ? `${archivedTurns} 轮正文与结构化 evidence 已通过身份校验。` : 'SQLite 可读，但无法恢复完整用户/助手正文。',
      verdict: archivedTurns ? 'exact' : 'partial', value: `${archivedTurns} turns`,
      evidence: [['trace archive', session.provider_id, archivedTurns ? `${archivedTurns} 轮已加载` : '未找到匹配目录', archivedTurns ? 'exact' : 'partial'], ['身份校验', 'external session', 'provider / cwd / session id 一致', archivedTurns ? 'exact' : 'unknown']],
      action: archivedTurns ? '无需处置。' : '继续显示 SQLite 摘要；不要伪造 transcript。',
    },
    {
      id: 'sqlite', severity: 'clear', title: `SQLite schema v${schemaVersion} 只读快照正常`,
      summary: '查询在 query_only 事务中完成，并读取当前 WAL。', verdict: 'exact', value: 'READY',
      evidence: [['本机数据库', 'scry.db', 'readOnly + query_only', 'exact'], ['事务', 'snapshot', '同一只读 BEGIN / COMMIT', 'exact']], action: '无需处置。',
    },
  ]
}

function buildGraphSessions(session, turns) {
  return turns.slice(-6).map((turn) => {
    const nodes = [{ id: `${turn.id}-prompt`, kind: 'prompt', label: '用户提示', detail: turn.user, duration: '不适用', status: turn.transcriptAvailable ? 'exact' : 'partial', tokens: '—', source: turn.transcriptAvailable ? 'trace archive · user evidence' : 'SQLite · first preview / unavailable' }]
    for (const block of turn.blocks.slice(0, 6)) {
      const model = block.kind === 'assistant' || block.kind === 'thinking'
      nodes.push({
        id: `${turn.id}-${block.id}`, kind: model ? 'model' : 'tool',
        label: model ? (block.kind === 'thinking' ? 'Thinking' : 'Assistant text') : `${block.kind.toUpperCase()} · ${block.label}`,
        detail: model ? block.text : block.detail, duration: model ? '—' : block.duration, status: model ? 'partial' : block.status,
        tokens: '不适用', source: model ? `trace archive · ${block.kind} preview` : `trace archive · ${block.kind}`,
      })
    }
    nodes.push({ id: `${turn.id}-result`, kind: 'result', label: 'Turn result', detail: `${turn.tools} calls · ${turn.errors} errors`, duration: turn.duration, status: Number.isFinite(turn.tokenValue) ? 'exact' : 'partial', tokens: turn.tokens, source: `${turn.usageSource || 'unknown'} usage evidence` })
    return { id: turn.id, label: `${session.provider_id} · T${turn.index}`, provider: session.provider_id, time: `${clock(turn.startedAt)}—${clock(turn.completedAt)}`, nodes }
  })
}

function buildSegments(session, turns) {
  return turns.slice(-12).map((turn) => ({
    id: turn.id, index: turn.index, label: safeText(turn.user, 34), kind: 'model', provider: session.provider_id,
    start: clock(turn.startedAt), durationMs: Number.isFinite(turn.durationMs) ? turn.durationMs : null, token: Number.isFinite(turn.tokenValue) ? fmtToken(turn.tokenValue) : '—',
    status: Number.isFinite(turn.tokenValue) ? 'exact' : 'partial', tools: turn.tools, failures: turn.errors,
    note: turn.hookEvidenceState === 'unknown'
      ? `真实 Turn · Hook evidence 未捕获 · ${turn.fileCount} 条结构化文件证据。`
      : `真实 Turn · ${turn.hookEvidenceState === 'partial' ? '≥ ' : ''}${turn.hookCount} logical hook runs / ${turn.hookEventCount} events · ${turn.fileCount} 条结构化文件证据。`,
  }))
}

function buildInventory(session, turns) {
  const skills = new Map()
  const mcps = new Map()
  for (const turn of turns) {
    for (const name of turn.observedSkills || []) {
      const current = skills.get(name) || { count: 0 }
      skills.set(name, { ...current, count: current.count + 1 })
    }
    for (const call of turn.observedMcps || []) {
      const server = call.server || 'unknown'
      const current = mcps.get(server) || { tools: new Set(), count: 0 }
      current.tools.add(call.tool || 'MCP')
      current.count += 1
      mcps.set(server, current)
    }
  }
  return {
    context: { provider: session.provider_id, cwd: session.cwd || '不绑定项目', capturedAt: `只读快照 · ${clock(Date.now())}` },
    skills: [...skills].map(([name, value]) => ({ id: name, name, description: `当前会话观测到 ${value.count} 次调用；配置开关与 scope 不在账本中。`, scope: 'unknown', source: 'trace archive / SQLite · observed invocation', enabled: false, state: 'unsupported', reason: '只读账本不能判断是否启用', manageable: false })),
    mcps: [...mcps].map(([name, value]) => ({ id: name, name, transport: '未知', scope: 'unknown', source: 'trace archive / SQLite · observed calls', config: { state: 'unknown', manageable: false, detail: 'SQLite 不保存配置开关' }, runtime: { state: 'unknown', detail: `本会话观测到 ${value.count} 次调用；不代表当前仍连接` }, test: { state: 'unknown', detail: '未执行 live tools/list' }, auth: { state: 'unknown', detail: '认证状态不在账本中' }, tools: [...value.tools] })),
  }
}

function buildLiveProjection(session, turns, archivedTurnCount, providers, analytics, schemaVersion) {
  const diagnostics = buildDiagnosticIssues(session, turns, archivedTurnCount, providers, analytics, schemaVersion)
  return {
    diagnostics,
    dataSurfaces: {
      analyticsDays: analytics.days.map((day) => ({ day: day.label, amount: day.value, status: day.status === 'partial' ? 'lowerBound' : day.status, provider: day.provider })),
      providers: providers.map((provider) => ({ id: provider.id, label: provider.name, short: provider.short, turns: provider.turns, known: provider.known, tokens: Math.round(provider.tokens / 1000), cache: provider.cache, danger: provider.danger, dangerText: provider.dangerText })),
      tools: analytics.tools.map((tool) => ({ name: tool.label, provider: tool.provider, calls: tool.calls, avg: tool.avg, failures: tool.errors })),
      riskDays: analytics.riskDays,
      diagnostics,
      graphSessions: buildGraphSessions(session, turns),
      segments: buildSegments(session, turns),
    },
    inventory: buildInventory(session, turns),
  }
}

async function snapshot(selectedSessionId) {
  if (!existsSync(dbPath)) throw new Error(`SQLite 不存在：${dbPath}`)
  const db = new DatabaseSync(dbPath, { readOnly: true })
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN')
  try {
    const sessions = db.prepare(`SELECT r.scry_session_id, r.provider_id, r.runtime_provider, r.cwd,
      r.external_session_id, r.preview, r.created_ts, r.updated_ts,
      COUNT(DISTINCT s.run_id) turns,
      SUM(CASE WHEN s.kind IN ('tool','skill','agent') THEN 1 ELSE 0 END) calls,
      SUM(CASE WHEN s.is_error=1 THEN 1 ELSE 0 END) errors
      FROM session_refs r LEFT JOIN spans s ON s.session_id=r.scry_session_id
      GROUP BY r.scry_session_id ORDER BY r.updated_ts DESC LIMIT 24`).all()
    const session = sessions.find((item) => item.scry_session_id === selectedSessionId) || sessions.find((item) => item.turns > 0) || sessions[0]
    if (!session) throw new Error('SQLite 中还没有 session_refs')
    const archived = await readArchivedTurns(session)
    const archiveTurns = archived.map((turn, index) => mapTurn(turn, session.provider_id, index))
    const ledgerTurns = readLedgerTurns(db, session)
    const turns = mergeTurns(archiveTurns, ledgerTurns)
    const overview = buildOverview(db, session, turns)
    const { providers, analytics } = buildAnalytics(db, Date.now())
    const schemaVersion = db.prepare('PRAGMA user_version').get().user_version
    db.exec('COMMIT')
    const source = `LIVE · SQLite v${schemaVersion} + trace archive · 只读`
    const projection = buildLiveProjection(session, turns, archiveTurns.length, providers, analytics, schemaVersion)
    return {
      meta: { snapshot: new Date().toLocaleString('zh-CN', { hour12: false }), source, sampleLabel: '本机真实数据', workspace: basename(session.cwd) || '不绑定项目', branch: '只读数据桥', scope: `${session.provider_id} · 当前 session`, providerId: session.provider_id, live: true, db: '~/Library/Application Support/scry/scry.db', transcriptSource: archived.length ? 'trace archive' : 'unavailable', selectedSessionId: session.scry_session_id },
      sessionOptions: sessions.map((item) => ({ id: item.scry_session_id, provider: item.provider_id, cwd: item.cwd, label: `${item.provider_id} · ${basename(item.cwd) || '不绑定项目'} · ${safeText(item.preview, 54)}`, turns: item.turns, updatedAt: item.updated_ts })),
      providers,
      recent: sessions.slice(0, 8).map((item) => ({ title: safeText(item.preview, 54) || '无标题会话', project: basename(item.cwd) || '不绑定项目', provider: item.provider_id, time: new Date(item.updated_ts).toLocaleDateString('zh-CN'), state: item.errors ? 'warning' : 'complete' })),
      chat: { sessionId: session.external_session_id, cwd: session.cwd || null, provider: session.provider_id === 'claude' ? 'Claude Code' : session.provider_id === 'codex' ? 'Codex' : session.provider_id === 'qoder' ? 'Qoder' : 'OpenCode', model: turns.at(-1)?.usage?.model || '按 Provider 上报', turns },
      overview,
      analytics,
      diagnostics: { verdict: `SQLite v${schemaVersion} 可读；当前 session ${turns.length} 轮，${overview.metrics[2].value} 次结构化调用。`, issues: projection.diagnostics.map((issue) => ({ id: issue.id, severity: issue.severity, title: issue.title, detail: issue.summary, action: issue.action })) },
      dataSurfaces: projection.dataSurfaces,
      inventory: projection.inventory,
    }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* nothing to roll back */ }
    throw error
  } finally {
    db.close()
  }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(value))
}

async function serveStatic(pathname, res) {
  try {
    const target = resolve(root, `.${decodeURIComponent(pathname)}`)
    if (target !== root && !target.startsWith(`${root}${sep}`)) return json(res, 403, { error: 'path rejected' })
    if (!await trustedRegularFile(root, target)) return json(res, 404, { error: 'not found' })
    res.writeHead(200, { 'Content-Type': contentTypes[extname(target).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' })
    res.end(await readFile(target))
  } catch (error) { json(res, error instanceof URIError ? 400 : 404, { error: error instanceof URIError ? 'bad path encoding' : 'not found' }) }
}

const server = createServer(async (req, res) => {
  try {
    const expectedHosts = new Set([`${host}:${port}`, `localhost:${port}`])
    if (!expectedHosts.has(req.headers.host || '')) return json(res, 421, { error: 'host rejected' })
    const url = new URL(req.url || '/', `http://${host}:${port}`)
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    if (url.pathname === '/') {
      res.writeHead(302, { Location: '/scry-evidence-system/Scry%20Evidence%20System.html', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      res.end()
      return
    }
    if (url.pathname === '/api/health') {
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true })
        db.exec('PRAGMA query_only=ON')
        const schemaVersion = db.prepare('PRAGMA user_version').get().user_version
        db.close()
        return json(res, 200, { ok: true, host, db: '~/Library/Application Support/scry/scry.db', schemaVersion, mode: 'read-only', snapshotAt: Date.now() })
      } catch (error) { return json(res, 503, { ok: false, error: safeText(error?.message || error) }) }
    }
    if (url.pathname === '/api/snapshot') {
      try { return json(res, 200, await snapshot(url.searchParams.get('session'))) }
      catch (error) { return json(res, 503, { error: safeText(error?.message || error) }) }
    }
    return await serveStatic(url.pathname, res)
  } catch (error) {
    return json(res, 400, { error: safeText(error?.message || error) || 'bad request' })
  }
})

if (process.argv.includes('--check')) {
  const data = await snapshot(null)
  if (!data.meta.live || !Array.isArray(data.sessionOptions) || !Array.isArray(data.chat.turns)) throw new Error('snapshot self-check failed')
  const redactionProbe = JSON.stringify(safeObject({ password: 'unsafe-password-value', databaseUrl: 'postgres://user:unsafe-db-secret@localhost/db', openaiApiKey: 'unsafe-openai-key-value', OPENAI_API_KEY: 'unsafe-openai-env-value', nested: 'Authorization: Bearer unsafe-bearer-token-value-1234567890' }))
  const textRedactionProbe = safeText(JSON.stringify({ apiKey: 'unsafe-api-key-value', clientSecret: 'unsafe-client-secret-value', refreshToken: 'unsafe-refresh-token-value', raw: 'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890' }))
  if (['unsafe-password-value', 'unsafe-db-secret', 'unsafe-openai-key-value', 'unsafe-openai-env-value', 'unsafe-bearer-token-value', 'unsafe-api-key-value', 'unsafe-client-secret-value', 'unsafe-refresh-token-value', 'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890'].some((secret) => redactionProbe.includes(secret) || textRedactionProbe.includes(secret))) throw new Error('redaction self-check failed')
  console.log(JSON.stringify({ ok: true, sessions: data.sessionOptions.length, turns: data.chat.turns.length, source: data.meta.source, redaction: true }))
} else {
  server.listen(port, host, () => console.log(`Scry live preview: http://${host}:${port}/scry-evidence-system/Scry%20Evidence%20System.html (db=${relative(homedir(), dbPath)}, read-only)`))
}
