import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderDescriptor } from '../../shared/provider'
import { compareSemver, normalizeProviderVersion, parseSemver } from '../../shared/provider-compatibility'
import type { AgentPermissionMode } from '../../shared/runtime'
import { maskSecrets } from '../../shared/trace'
import { probeCliVersion, resolveRuntimeCliBin, runtimeCliEnv } from '../claude-locate'
import {
  canSignalCategory,
  captureProcessIdentity,
  readProcessSnapshot,
  signalProcessTreeWithIdentity,
  type ProcessIdentity,
  type ProcessTreeNode
} from '../process-diagnostics'

export const ANTIGRAVITY_MIN_VERSION = '1.5.1'
export const ANTIGRAVITY_TRANSPORT = 'ACP (stdio)'

const STDERR_KEPT_CHARS = 8_192
const STDERR_REPORTED_CHARS = 4_096

/**
 * Bounded stderr tail for UI/remote failure diagnostics only.
 * Masks secrets on attach; never feeds into native evidence sinks.
 */
export class AntigravityStderrTail {
  #text = ''
  #truncated = false

  push(chunk: string): void {
    this.#text += chunk
    if (this.#text.length <= STDERR_KEPT_CHARS) return
    this.#text = this.#text.slice(-STDERR_KEPT_CHARS)
    this.#truncated = true
  }

  maskedTail(): string {
    const kept = this.#truncated ? this.#text.slice(this.#text.indexOf('\n') + 1) : this.#text
    return (maskSecrets(kept.trim()) ?? '').slice(-STDERR_REPORTED_CHARS)
  }

  attach(error: unknown): unknown {
    const tail = this.maskedTail()
    if (!tail || !(error instanceof Error) || error.message.includes(tail)) return error
    error.message = `${error.message}\nAntigravity CLI stderr (last ${tail.length} chars, secrets masked):\n${tail}`
    return error
  }
}

let cachedNoopBrowser: string | undefined

/**
 * Exit-0 command assigned to `BROWSER` so `agy acp` can never fall back to opening a system browser.
 * Non-zero exit codes trigger a fallback browser launch, so exit 0 is mandatory (P7 §2.2).
 */
export function noopBrowserCommand(): string {
  if (cachedNoopBrowser && existsSync(cachedNoopBrowser)) return cachedNoopBrowser
  if (existsSync('/usr/bin/true')) return (cachedNoopBrowser = '/usr/bin/true')
  if (existsSync('/bin/true')) return (cachedNoopBrowser = '/bin/true')
  const script = join(tmpdir(), `scry-noop-browser-${process.getuid?.() ?? 'user'}.sh`)
  if (!existsSync(script)) {
    writeFileSync(script, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    chmodSync(script, 0o700)
  }
  return (cachedNoopBrowser = script)
}

export function antigravityExecutable(): string | undefined {
  const configured = process.env.SCRY_AGY_PATH?.trim()
  const found = (configured && existsSync(configured) ? configured : undefined) ?? resolveRuntimeCliBin('antigravity')
  if (!found) return undefined
  try {
    return realpathSync(found)
  } catch {
    return found
  }
}

export function buildAntigravityLaunchEnv(
  baseEnv?: Record<string, string>,
  extraEnv?: Record<string, string>
): Record<string, string> {
  const env = runtimeCliEnv(baseEnv, { providerId: 'antigravity' })
  // Do not inject T3 managed-runtime vars or let `agy` open a real browser.
  delete env.PYTHONUNBUFFERED
  delete env.ELECTRON_RUN_AS_NODE
  delete env.SCRY_MANAGED_RUN_ID
  delete env.SCRY_MANAGED_PROMPT_HASH
  return {
    ...env,
    ...(extraEnv ?? {}),
    BROWSER: noopBrowserCommand()
  }
}

export function antigravityVersionSupported(rawVersion: string | undefined): boolean {
  const normalized = normalizeProviderVersion(rawVersion)
  if (!normalized) return false
  const parsed = parseSemver(normalized)
  const floor = parseSemver(ANTIGRAVITY_MIN_VERSION)
  return Boolean(parsed && floor && compareSemver(parsed, floor) >= 0)
}

export async function describeAntigravity(options: {
  platform?: NodeJS.Platform
  executable?: string
} = {}): Promise<ProviderDescriptor> {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    return {
      id: 'antigravity',
      label: 'Antigravity',
      runtimeProvider: 'antigravity_acp',
      transport: ANTIGRAVITY_TRANSPORT,
      available: false,
      unavailableReason: 'unsupported_platform: Antigravity Provider 暂不支持 Windows',
      capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' },
      health: {
        state: 'unavailable',
        transport: ANTIGRAVITY_TRANSPORT,
        lastError: 'unsupported_platform: Antigravity Provider 暂不支持 Windows',
        lastErrorAt: Date.now()
      }
    }
  }
  const path = options.executable ?? antigravityExecutable()
  if (!path) {
    return {
      id: 'antigravity',
      label: 'Antigravity',
      runtimeProvider: 'antigravity_acp',
      transport: ANTIGRAVITY_TRANSPORT,
      available: false,
      unavailableReason: '未找到 agy 可执行文件；请安装 Antigravity CLI 或设置 SCRY_AGY_PATH',
      capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' },
      health: {
        state: 'unavailable',
        transport: ANTIGRAVITY_TRANSPORT,
        lastError: '未找到 agy 可执行文件',
        lastErrorAt: Date.now()
      }
    }
  }
  const probe = await probeCliVersion(path, ['--version'], {
    env: buildAntigravityLaunchEnv(),
    timeout: 5_000
  })
  if (probe.health.state !== 'ready' || !probe.version) {
    const reason = probe.health.lastError ?? 'agy --version 探测失败'
    return {
      id: 'antigravity',
      label: 'Antigravity',
      runtimeProvider: 'antigravity_acp',
      transport: ANTIGRAVITY_TRANSPORT,
      available: false,
      path,
      unavailableReason: reason,
      capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' },
      health: { state: 'unavailable', transport: ANTIGRAVITY_TRANSPORT, lastError: reason, lastErrorAt: Date.now() }
    }
  }
  if (!antigravityVersionSupported(probe.version)) {
    const reason = `Antigravity CLI 版本过低（检测到 ${probe.version}，最低要求 >= ${ANTIGRAVITY_MIN_VERSION}）`
    return {
      id: 'antigravity',
      label: 'Antigravity',
      runtimeProvider: 'antigravity_acp',
      transport: ANTIGRAVITY_TRANSPORT,
      available: false,
      path,
      version: probe.version,
      unavailableReason: reason,
      capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' },
      health: { state: 'unavailable', transport: ANTIGRAVITY_TRANSPORT, lastError: reason, lastErrorAt: Date.now() }
    }
  }
  return {
    id: 'antigravity',
    label: 'Antigravity',
    runtimeProvider: 'antigravity_acp',
    transport: ANTIGRAVITY_TRANSPORT,
    available: true,
    path,
    version: probe.version,
    capabilities: { skills: 'read', mcp: 'read', commands: 'read', account: 'none' },
    // Login status is verified on first catalog read or send, never claimed ready from binary alone.
    health: { state: 'unknown', transport: ANTIGRAVITY_TRANSPORT }
  }
}

export interface SpawnedAntigravityProcess {
  child: ChildProcess
  executable: string
  argv: string[]
  identityPromise: Promise<ProcessIdentity | undefined>
  stderrTail: AntigravityStderrTail
}

export function spawnAntigravityAcp(args: {
  cwd: string
  permissionMode: AgentPermissionMode
  executable?: string
  baseEnv?: Record<string, string>
  extraEnv?: Record<string, string>
  stderrTail?: AntigravityStderrTail
}): SpawnedAntigravityProcess {
  if (process.platform === 'win32') {
    throw new Error('unsupported_platform: Antigravity Provider 暂不支持 Windows')
  }
  const executable = args.executable ?? antigravityExecutable()
  if (!executable) {
    throw new Error('未找到 agy 可执行文件；请安装 Antigravity CLI 或设置 SCRY_AGY_PATH')
  }
  // Fixed argv — never place tokens or config payloads on the command line (P7 §5.3).
  const argv = args.permissionMode === 'full_access' ? ['acp', '--dangerously-skip-permissions'] : ['acp']
  const env = buildAntigravityLaunchEnv(args.baseEnv, args.extraEnv)
  const stderrTail = args.stderrTail ?? new AntigravityStderrTail()
  const child = spawn(executable, argv, {
    cwd: args.cwd,
    env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const identityPromise = captureProcessIdentity(child.pid)
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => stderrTail.push(chunk))
  return { child, executable, argv, identityPromise, stderrTail }
}

function readProcessGroups(pids: number[]): Map<number, number> {
  const result = new Map<number, number>()
  if (pids.length === 0 || process.platform === 'win32') return result
  try {
    const out = execFileSync(
      '/bin/ps',
      ['-o', 'pid=,pgid=', '-p', pids.join(',')],
      { encoding: 'utf8', maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: 'C' } }
    )
    for (const line of out.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/)
      if (match) result.set(Number(match[1]), Number(match[2]))
    }
  } catch {
    // Process may have exited between snapshot and pgid check.
  }
  return result
}

interface IndependentDescendant {
  pid: number
  pgid?: number
  startedAt: string
  command: string
}

function signalIndependentPgidDescendants(
  rootPid: number,
  nodes: readonly ProcessTreeNode[],
  signal: NodeJS.Signals
): IndependentDescendant[] {
  const descendants = nodes.filter(
    (node) => node.pid !== rootPid && node.pid > 1 && node.pid !== process.pid && canSignalCategory(node.category)
  )
  if (descendants.length === 0) return []
  const pgids = readProcessGroups(descendants.map((node) => node.pid))
  const signalledGroups = new Set<number>([rootPid, process.pid])
  const tracked: IndependentDescendant[] = []
  for (const node of descendants) {
    const pgid = pgids.get(node.pid)
    if (pgid && pgid > 1 && !signalledGroups.has(pgid)) {
      signalledGroups.add(pgid)
      try { process.kill(-pgid, signal) } catch { /* ESRCH / EPERM */ }
    }
    if (!pgid || pgid !== rootPid) {
      tracked.push({ pid: node.pid, pgid, startedAt: node.startedAt, command: node.command })
      try { process.kill(node.pid, signal) } catch { /* ESRCH / EPERM */ }
    }
  }
  return tracked
}

function killVerifiedDescendants(descendants: readonly IndependentDescendant[], signal: NodeJS.Signals): void {
  if (descendants.length === 0 || process.platform === 'win32') return
  let snapshot: ReturnType<typeof readProcessSnapshot>
  try {
    snapshot = readProcessSnapshot()
  } catch {
    return
  }
  const signalledGroups = new Set<number>([process.pid])
  for (const target of descendants) {
    const live = snapshot.get(target.pid)
    if (!live || live.status.startsWith('Z')) continue
    if (live.startedAt !== target.startedAt || live.command !== target.command) continue
    if (target.pgid && target.pgid > 1 && !signalledGroups.has(target.pgid)) {
      signalledGroups.add(target.pgid)
      try { process.kill(-target.pgid, signal) } catch { /* ESRCH / EPERM */ }
    }
    try { process.kill(target.pid, signal) } catch { /* ESRCH / EPERM */ }
  }
}

/**
 * Identity-verified signal to `agy acp` root PGID plus any verified descendants
 * that moved into an independent PGID (P7 §5.1 A0 empirical finding).
 * Fails closed when identity is missing or changed; never uses `pkill`.
 */
export async function signalAntigravityProcess(
  identityPromise: Promise<ProcessIdentity | undefined> | undefined,
  signal: NodeJS.Signals
): Promise<{ status: 'signalled' | 'already_gone' | 'refused'; independentDescendants: IndependentDescendant[] }> {
  if (!identityPromise || process.platform === 'win32') {
    return { status: 'refused', independentDescendants: [] }
  }
  let identity: ProcessIdentity | undefined
  try {
    identity = await identityPromise
  } catch {
    return { status: 'refused', independentDescendants: [] }
  }
  if (!identity?.startedAt) return { status: 'refused', independentDescendants: [] }
  try {
    const outcome = signalProcessTreeWithIdentity({ identity, signal })
    if (outcome.status === 'signalled') {
      const independentDescendants = signalIndependentPgidDescendants(identity.pid, outcome.nodes, signal)
      return { status: 'signalled', independentDescendants }
    }
    return { status: outcome.status, independentDescendants: [] }
  } catch {
    return { status: 'refused', independentDescendants: [] }
  }
}

/**
 * Run-scoped forceKill (P7 §5.1): identity-verified SIGTERM -> wait up to 2s -> SIGKILL,
 * signalling independent-PGID descendants on both stages (even if root exited after SIGTERM).
 */
export async function forceKillAntigravityProcess(
  identityPromise: Promise<ProcessIdentity | undefined> | undefined,
  options: { sigkillDelayMs?: number } = {}
): Promise<void> {
  const first = await signalAntigravityProcess(identityPromise, 'SIGTERM')
  if (first.status !== 'signalled') return
  const delayMs = options.sigkillDelayMs ?? 2_000
  const deadline = Date.now() + delayMs
  const identity = await identityPromise?.catch(() => undefined)
  while (Date.now() < deadline) {
    let anyAlive = false
    if (identity?.pid) {
      try {
        process.kill(identity.pid, 0)
        anyAlive = true
      } catch { /* exited */ }
    }
    for (const child of first.independentDescendants) {
      try {
        process.kill(child.pid, 0)
        anyAlive = true
      } catch { /* exited */ }
    }
    if (!anyAlive) return
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  const second = await signalAntigravityProcess(identityPromise, 'SIGKILL')
  if (second.status !== 'signalled') {
    killVerifiedDescendants(first.independentDescendants, 'SIGKILL')
  }
}
