import { AgentRuntimeError } from '../run-outcome'
import { sanitizeOpenCodeServerLog, type OpenCodeServerManager } from './opencode-server'
import { record } from './opencode-records'

export function normalizeOpenCodeTool(rawName: string, rawInput: unknown): {
  toolName: string
  input: Record<string, unknown>
} {
  const source = record(rawInput)
  const input = { ...source }
  if (typeof input.filePath === 'string' && input.file_path === undefined) input.file_path = input.filePath
  const aliases: Record<string, string> = {
    bash: 'Bash', edit: 'Edit', glob: 'Glob', grep: 'Grep', read: 'Read', skill: 'Skill', task: 'Task', write: 'Write'
  }
  if (rawName === 'skill' && typeof input.name === 'string') input.skill = input.name
  return { toolName: aliases[rawName] ?? rawName, input }
}

export function errorText(value: unknown): string {
  const item = record(value)
  return String(record(item.data).message ?? item.message ?? JSON.stringify(value))
}

function safeErrorDetail(value: unknown): string | undefined {
  const base = sanitizeOpenCodeServerLog(errorText(value))
  const details: string[] = []
  let current: unknown = value
  for (let depth = 0; depth < 3; depth++) {
    const item = record(current)
    const code = typeof item.code === 'string' ? item.code : undefined
    const message = typeof item.message === 'string' ? item.message : undefined
    const detail = [code, message].filter(Boolean).join(': ')
    if (detail && !details.includes(detail)) details.push(detail)
    current = item.cause
    if (!current) break
  }
  const summary = details.filter((detail) => detail !== base).join(' → ')
  return summary ? sanitizeOpenCodeServerLog(summary).slice(0, 500) : undefined
}

function nestedErrorCode(value: unknown): string | undefined {
  let current: unknown = value
  for (let depth = 0; depth < 3; depth++) {
    const item = record(current)
    if (typeof item.code === 'string' && item.code) return item.code
    current = item.cause
    if (!current) break
  }
  return undefined
}

function requestSummary(result: Record<string, unknown>): { method?: string; path?: string; status?: number } {
  const request = result.request instanceof Request ? result.request : undefined
  const response = result.response instanceof Response ? result.response : undefined
  let path: string | undefined
  if (request) {
    try {
      path = new URL(request.url).pathname.replace(/^(\/session\/)[^/]+/, '$1{sessionId}')
    } catch {
      // The operation name still identifies the request without exposing a malformed raw URL.
    }
  }
  return { method: request?.method, path, status: response?.status }
}

class OpenCodeRequestError extends Error {
  readonly operation: string
  readonly transportFailure: boolean
  readonly transportCode?: string
  readonly method?: string
  readonly path?: string
  readonly status?: number

  constructor(operation: string, result: Record<string, unknown>) {
    const original = result.error
    const base = sanitizeOpenCodeServerLog(errorText(original))
    const cause = safeErrorDetail(original)
    const request = requestSummary(result)
    const requestText = [request.method, request.path].filter(Boolean).join(' ')
    const suffix = [
      cause,
      request.status == null ? requestText : `${requestText} → HTTP ${request.status}`
    ].filter(Boolean).join('；')
    super(`OpenCode ${operation} 请求失败：${base}${suffix ? `（${suffix}）` : ''}`, {
      cause: original instanceof Error ? original : undefined
    })
    this.name = 'OpenCodeRequestError'
    this.operation = operation
    this.transportFailure = result.response == null && original instanceof Error
    this.transportCode = nestedErrorCode(original)
    this.method = request.method
    this.path = request.path
    this.status = request.status
  }
}

export async function unwrap<T>(promise: Promise<unknown>, operation: string): Promise<T> {
  const result = record(await promise)
  if (result.error !== undefined) throw new OpenCodeRequestError(operation, result)
  return (result.data === undefined ? result : result.data) as T
}

export function abortableSseSleep(signal: AbortSignal): (delayMs: number) => Promise<void> {
  return (delayMs) => new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    const done = (): void => {
      if (timeout) clearTimeout(timeout)
      signal.removeEventListener('abort', done)
      resolve()
    }
    timeout = setTimeout(done, delayMs)
    signal.addEventListener('abort', done, { once: true })
  })
}

export function normalizeOpenCodeRunError(
  error: unknown,
  cwd: string | undefined,
  manager: Pick<OpenCodeServerManager, 'diagnostic'> | undefined
): Error {
  if (!(error instanceof OpenCodeRequestError) || !error.transportFailure) {
    return error instanceof Error ? error : new Error(String(error))
  }
  const diagnostic = manager?.diagnostic ?? { running: false }
  const exit = diagnostic.lastExit && !diagnostic.lastExit.expected
    ? diagnostic.lastExit
    : undefined
  const exitText = exit
    ? `；本地 server 已退出（${exit.code ?? exit.signal ?? 'unknown'}）`
    : diagnostic.running
      ? `；本地 server pid=${diagnostic.pid ?? 'unknown'} 仍在运行`
      : '；本地 server 当前不在运行'
  const normalized = new AgentRuntimeError(`${error.message}${exitText}`, {
    provider: 'opencode_server',
    stage: 'protocol',
    commandSummary: error.operation,
    cwd,
    transportCode: error.transportCode,
    requestMethod: error.method,
    requestPath: error.path,
    httpStatus: error.status,
    ...(exit ? { exitCode: exit.code, signal: exit.signal } : {}),
    nextAction: 'Scry 已尝试终止当前 OpenCode 会话；确认没有后台运行后再重试。若重复出现，请查看 Provider 健康状态中的 cause/exit 信息'
  })
  Object.defineProperty(normalized, 'cause', { value: error, configurable: true })
  return normalized
}
