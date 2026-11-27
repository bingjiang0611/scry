import { readFile, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'

export interface HostProcess {
  pid: number
  token?: string
}

export interface ProcessTableEntry extends HostProcess {
  ppid: number
  command?: string
}

export interface HostProcessChainOptions {
  provider?: ProviderId
  depth?: number
  table?: Map<number, ProcessTableEntry>
  timeoutMs?: number
}

export const MAX_HOST_CHAIN_DEPTH = 8
export const DEFAULT_PROCESS_TABLE_TIMEOUT_MS = 2_000
export const QUEUE_HOST_SAMPLE_TIMEOUT_MS = 300

const C_LSTART = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/
const SCRIPT_RUNTIMES = new Set(['node', 'nodejs', 'bun', 'deno', 'electron', 'python', 'python3'])
const RUNTIME_VALUE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--conditions', '-C', '-m'])
const RUNTIME_INLINE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c'])

const PROVIDER_HOST_NAMES: Record<ProviderId, ReadonlySet<string>> = {
  antigravity: new Set(['antigravity', 'agy']),
  claude: new Set(['claude', 'claude-code']),
  codex: new Set(['codex', 'codex-cli']),
  qoder: new Set(['qoder', 'qodercli', 'qoder-cli', 'qoderwork', 'qoder-work']),
  opencode: new Set(['opencode', 'opencode-cli']),
  pi: new Set(['pi', 'pi-coding-agent'])
}

const PROVIDER_SCRIPT_SEGMENTS: Record<ProviderId, readonly string[]> = {
  antigravity: ['/antigravity/'],
  claude: ['/@anthropic-ai/claude-code/'],
  codex: ['/@openai/codex/'],
  qoder: ['/qoder/', '/qodercli/'],
  opencode: ['/opencode-ai/', '/opencode/'],
  pi: ['/@mariozechner/pi-coding-agent/']
}

function normalizeExeName(raw: string): string {
  const base = basename(raw.replaceAll('\\', '/')).toLowerCase().replace(/^-+/, '')
  return base.endsWith('.exe') ? base.slice(0, -4) : base
}

function normalizeScriptBase(raw: string): string {
  return normalizeExeName(raw).replace(/\.(m?js|cjs|ts|mts|cts|py)$/, '')
}

function executableFromCommand(command: string): { exe: string; restTokens: string[] } {
  const trimmed = command.trim()
  const macosMarker = '/Contents/MacOS/'
  const markerIndex = trimmed.indexOf(macosMarker)
  if (trimmed.startsWith('/') && markerIndex > 0) {
    const afterMarker = trimmed.slice(markerIndex + macosMarker.length)
    const spaceIndex = afterMarker.search(/\s/)
    const exeName = spaceIndex === -1 ? afterMarker : afterMarker.slice(0, spaceIndex)
    const rest = spaceIndex === -1 ? [] : afterMarker.slice(spaceIndex + 1).trim().split(/\s+/).filter(Boolean)
    return { exe: normalizeExeName(exeName), restTokens: rest }
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  if (!tokens.length) return { exe: '', restTokens: [] }
  return { exe: normalizeExeName(tokens[0]), restTokens: tokens.slice(1) }
}

export function isProviderHostCommand(command: string | undefined, provider: ProviderId): boolean {
  if (!command || !command.trim()) return false
  const names = PROVIDER_HOST_NAMES[provider]
  const { exe, restTokens } = executableFromCommand(command)
  if (!exe) return false
  if (names.has(exe)) return true
  if (!SCRIPT_RUNTIMES.has(exe)) return false
  for (let index = 0; index < restTokens.length; index++) {
    const token = restTokens[index]
    if (RUNTIME_INLINE_FLAGS.has(token)) return false
    if (RUNTIME_VALUE_FLAGS.has(token)) {
      index++
      continue
    }
    if (token.startsWith('-')) continue
    if (names.has(normalizeScriptBase(token))) return true
    const normalizedPath = token.replaceAll('\\', '/').toLowerCase()
    return PROVIDER_SCRIPT_SEGMENTS[provider].some((segment) => normalizedPath.includes(segment))
  }
  return false
}

export function validHostChain(value: unknown): HostProcess[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return undefined
  const chain: HostProcess[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined
    const { pid, token } = item as { pid?: unknown; token?: unknown }
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return undefined
    if (token !== undefined && (typeof token !== 'string' || !token.trim() || token.length > 128 || /[\r\n]/.test(token))) return undefined
    chain.push({ pid, ...(typeof token === 'string' ? { token: token.trim() } : {}) })
  }
  return chain
}

async function resolveEntryCommand(entry: ProcessTableEntry, useProcCmdline: boolean): Promise<string | undefined> {
  const command = entry.command
  if (!useProcCmdline || !command || command.includes(' ')) return command
  if (!SCRIPT_RUNTIMES.has(normalizeExeName(command))) return command
  const raw = await readFile(`/proc/${entry.pid}/cmdline`, 'utf8').catch(() => undefined)
  if (!raw) return command
  const joined = raw.split('\0').filter(Boolean).join(' ').trim()
  return joined || command
}

export async function hostProcessChain(
  seed: number,
  options: HostProcessChainOptions = {}
): Promise<HostProcess[]> {
  const depth = options.depth ?? MAX_HOST_CHAIN_DEPTH
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TABLE_TIMEOUT_MS
  const table = options.table ?? await processTable(timeoutMs)
  if (!table) return []
  const chain: HostProcess[] = []
  const seen = new Set<number>()
  let pid = Number.isInteger(seed) && seed > 0 ? seed : undefined
  const useProcCmdline = !options.table
  for (let step = 0; step < depth && pid !== undefined; step++) {
    if (seen.has(pid)) break
    seen.add(pid)
    const entry = table.get(pid)
    if (!entry) break
    if (entry.pid > 1) chain.push({ pid: entry.pid, ...(entry.token ? { token: entry.token } : {}) })
    if (options.provider) {
      const command = await resolveEntryCommand(entry, useProcCmdline && Boolean(entry.token?.startsWith('ticks:')))
      if (isProviderHostCommand(command, options.provider)) return chain
    }
    if (entry.ppid === entry.pid || entry.ppid <= 1) break
    pid = entry.ppid
  }
  return options.provider ? [] : chain
}

export async function liveHostProcesses(
  chain: HostProcess[],
  known?: Map<number, ProcessTableEntry>
): Promise<HostProcess[] | undefined> {
  if (!chain.length) return []
  const table = known ?? await processTable()
  if (!table) return undefined
  const live: HostProcess[] = []
  for (const recorded of chain) {
    const current = table.get(recorded.pid)
    if (!current) continue
    if (recorded.token && current.token && recorded.token !== current.token) {
      if (!/^ticks:\d+$/.test(recorded.token) && !C_LSTART.test(recorded.token)) return undefined
      continue
    }
    live.push(recorded)
  }
  return live
}

export async function processTable(timeoutMs = DEFAULT_PROCESS_TABLE_TIMEOUT_MS): Promise<Map<number, ProcessTableEntry> | undefined> {
  return await procTable(timeoutMs) ?? await psTable(timeoutMs)
}

async function procTable(timeoutMs: number): Promise<Map<number, ProcessTableEntry> | undefined> {
  const deadline = Date.now() + timeoutMs
  let names: string[]
  try {
    names = await readdir('/proc')
  } catch {
    return undefined
  }
  const table = new Map<number, ProcessTableEntry>()
  for (const name of names) {
    if (Date.now() > deadline) return undefined
    if (!/^\d+$/.test(name)) continue
    const stat = await readFile(`/proc/${name}/stat`, 'utf8').catch(() => undefined)
    if (!stat) continue
    const openParen = stat.indexOf('(')
    const closeParen = stat.lastIndexOf(')')
    if (openParen < 0 || closeParen <= openParen) continue
    const command = stat.slice(openParen + 1, closeParen).trim() || undefined
    const fields = stat.slice(closeParen + 2).split(' ')
    const ppid = Number(fields[1])
    const token = fields[19]
    const pid = Number(name)
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    table.set(pid, { pid, ppid, ...(token ? { token: `ticks:${token}` } : {}), ...(command ? { command } : {}) })
  }
  return table.size ? table : undefined
}

async function psTable(timeoutMs: number): Promise<Map<number, ProcessTableEntry> | undefined> {
  let stdout: string | undefined
  try {
    stdout = await new Promise<string | undefined>((resolvePromise) => {
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const finish = (value: string | undefined): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolvePromise(value)
      }
      const child = execFile('ps', ['-axo', 'pid=,ppid=,lstart=,args='], {
        maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs, env: { ...process.env, LC_ALL: 'C' }
      }, (error, out) => finish(error ? undefined : String(out)))
      if (!settled) {
        timer = setTimeout(() => {
          try { child?.kill?.('SIGKILL') } catch {}
          finish(undefined)
        }, timeoutMs)
        timer.unref?.()
      }
    })
  } catch {
    return undefined
  }
  if (!stdout) return undefined
  const table = new Map<number, ProcessTableEntry>()
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})(?:\s+(.*))?$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    const command = match[4]?.trim() || undefined
    table.set(pid, { pid, ppid, token: match[3].trim(), ...(command ? { command } : {}) })
  }
  return table.size ? table : undefined
}

export type HostProcessState = 'running' | 'gone' | 'unknown'

export async function hostProcessState(
  host: HostProcess[] | undefined,
  table?: Map<number, ProcessTableEntry>
): Promise<HostProcessState> {
  if (!host?.length) return 'unknown'
  const live = await liveHostProcesses(host, table)
  if (!live) return 'unknown'
  return live.length ? 'running' : 'gone'
}
