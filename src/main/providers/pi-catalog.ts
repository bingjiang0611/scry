import { number, record, type JsonRecord } from './pi-shared'
import { PI_RPC_STARTUP_TIMEOUT_MS, PI_RPC_MAX_FRAME_BYTES, piRpcEnvironment } from './pi-runtime'
import { PiRpcProcess, piEvent } from './pi-rpc'
import type { PiAgentProfile } from '../pi-agent-profiles'
import type { ParsedTurn } from '../normalize'
import type { ProviderCommand, ProviderContext, SkillMeta } from '../../shared/provider'
import type { AgentRunControlCatalog } from '../../shared/runtime'
import type { TraceEvent } from '../../shared/trace'
import type { ProviderRunRequest } from './types'
import type { PiProbe } from './pi-types'
import { PerformanceTrace, performanceRecordingEnabled } from '../performance-timing'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { contextUsageEvidence } from '../../shared/trace'
import { effortOption } from './run-controls'
import { questionFromExtension } from './pi-events'

function explicitPiSkill(prompt: string): { command: string; name: string } | null {
  const match = prompt.match(/^\/skill:([A-Za-z0-9._-]+)(?:\s|$)/)
  return match ? { command: `skill:${match[1]}`, name: match[1] } : null
}

async function proveExplicitPiSkill(rpc: PiRpcProcess, request: ProviderRunRequest): Promise<TraceEvent | null> {
  const mention = explicitPiSkill(request.prompt)
  if (!mention) return null
  const rows = record((await rpc.send({ type: 'get_commands' })).data).commands
  const commands = Array.isArray(rows) ? rows.map(record) : []
  const skill = commands.find((command) => command.name === mention.command && command.source === 'skill')
  if (!skill) throw new Error(`Pi 命令目录未证明 /${mention.command} 是可用 Skill`)
  const sourceInfo = record(skill.sourceInfo)
  return piEvent(request.runId, {
    kind: 'skill',
    stage: `skill:${mention.name}`,
    tool: 'Skill',
    name: mention.name,
    input: {
      source: 'explicit_user_input',
      path: sourceInfo.path ?? skill.path ?? null,
      scope: sourceInfo.scope ?? skill.location ?? null
    }
  })
}

async function piExtensionCommand(rpc: PiRpcProcess, prompt: string): Promise<string | undefined> {
  // Match Pi's command parser, not arbitrary slash-looking text or skill/template expansions.
  if (!prompt.startsWith('/') || explicitPiSkill(prompt)) return undefined
  const name = prompt.slice(1).split(' ', 1)[0]
  const rows = record((await rpc.send({ type: 'get_commands' })).data).commands
  return Array.isArray(rows) && rows.some((row) => record(row).name === name && record(row).source === 'extension')
    ? name
    : undefined
}

function piRpcArgs(options: { noSession?: boolean; session?: string; offline?: boolean } = {}): string[] {
  // Pi project trust is independent from Scry's full-access run mode. Do not pass
  // --approve/--no-approve: RPC should honor Pi's saved/default project trust so
  // catalogs and runs agree without silently trusting repository-controlled resources.
  return [
    '--mode', 'rpc',
    ...(options.noSession ? ['--no-session'] : []),
    ...(options.session ? ['--session', options.session] : []),
    ...(options.offline ? ['--offline'] : [])
  ]
}

// A cold `pi --mode rpc` start (Node plus the Pi bootstrap) costs seconds on this machine, while the
// capability reads on a live process cost milliseconds. Park a bounded working set per
// profile+workspace for 60 seconds. Explicit context invalidation closes only the matching child,
// while every read still sends the same four live queries. Nothing is answered from a settled
// snapshot, and the existing idle expiry still bounds how long startup-loaded Pi resources live.
const PI_CATALOG_IDLE_MS = 60_000
const PI_CATALOG_WARM_PROCESS_LIMIT = 8

interface WarmCatalogProcess {
  rpc: PiRpcProcess
  env: NodeJS.ProcessEnv
  off: () => void
  profileId: string
  cwd: string
  idle?: NodeJS.Timeout
}

const warmCatalogProcesses = new Map<string, WarmCatalogProcess>()

async function closeWarmCatalogProcess(key: string, entry: WarmCatalogProcess): Promise<void> {
  if (warmCatalogProcesses.get(key) === entry) warmCatalogProcesses.delete(key)
  if (entry.idle) clearTimeout(entry.idle)
  entry.off()
  await entry.rpc.close()
}

function parkWarmCatalogProcess(key: string, entry: WarmCatalogProcess): void {
  entry.idle = setTimeout(() => { void closeWarmCatalogProcess(key, entry) }, PI_CATALOG_IDLE_MS)
  entry.idle.unref()
  warmCatalogProcesses.delete(key)
  warmCatalogProcesses.set(key, entry)
  while (warmCatalogProcesses.size > PI_CATALOG_WARM_PROCESS_LIMIT) {
    const oldest = warmCatalogProcesses.entries().next().value as [string, WarmCatalogProcess] | undefined
    if (!oldest) return
    warmCatalogProcesses.delete(oldest[0])
    void closeWarmCatalogProcess(oldest[0], oldest[1]).catch((error: unknown) => {
      console.warn('[scry] failed to close evicted Pi catalog process:', error)
    })
  }
}

/** Close parked probe processes and await their exit. Adapter disposal calls this. */
export async function disposePiCatalog(): Promise<void> {
  const entries = [...warmCatalogProcesses]
  warmCatalogProcesses.clear()
  await Promise.all(entries.map(async ([key, entry]) => closeWarmCatalogProcess(key, entry)))
}

/** Invalidate only the matching catalog generation; unrelated workspaces remain warm. */
export async function invalidatePiCatalog(context: ProviderContext): Promise<void> {
  if (!context.cwd) return disposePiCatalog()
  const entries = [...warmCatalogProcesses].filter(([, entry]) =>
    entry.cwd === context.cwd &&
    (!context.agentProfileId || entry.profileId === context.agentProfileId)
  )
  await Promise.all(entries.map(async ([key, entry]) => closeWarmCatalogProcess(key, entry)))
}

async function withPiRpc<T>(
  profile: PiAgentProfile,
  cwd: string | undefined,
  args: string[],
  operation: (rpc: PiRpcProcess) => Promise<T>,
  catalogTrace?: PerformanceTrace,
  warmKey?: string
): Promise<T> {
  const env = await piRpcEnvironment(profile)
  catalogTrace?.mark('environment_ready')
  const parked = warmKey === undefined ? undefined : warmCatalogProcesses.get(warmKey)
  let rpc: PiRpcProcess
  let off: () => void
  if (parked && parked.rpc.reusable() && isDeepStrictEqual(parked.env, env)) {
    warmCatalogProcesses.delete(warmKey!)
    if (parked.idle) clearTimeout(parked.idle)
    parked.idle = undefined
    rpc = parked.rpc
    off = parked.off
    rpc.attachCatalogTrace(catalogTrace)
  } else {
    // A parked process that cannot be reused (failed, closing, different environment) is dropped
    // before a replacement starts, so a broken child never lingers behind a working one.
    if (parked) await closeWarmCatalogProcess(warmKey!, parked)
    rpc = PiRpcProcess.start(profile, args, env, cwd, PI_RPC_MAX_FRAME_BYTES, catalogTrace)
    off = rpc.onEvent((event) => {
      // Catalog/session operations have no interactive owner. Decline startup dialogs;
      // never select a setup action or approve a permission merely to obtain metadata.
      if (event.type === 'extension_ui_request' && questionFromExtension('pi-noninteractive', event)) {
        rpc.notify({ type: 'extension_ui_response', id: event.id, cancelled: true })
      }
    })
  }
  let completed = false
  try {
    const result = await operation(rpc)
    completed = true
    return result
  } finally {
    // Only a read that actually succeeded is worth keeping warm. A failed read (RPC error, timeout,
    // early exit) closes its child immediately, so the next attempt starts from a clean process
    // instead of reusing one whose RPC surface just failed.
    if (warmKey !== undefined && completed && rpc.reusable()) {
      parkWarmCatalogProcess(warmKey, {
        rpc,
        env,
        off,
        profileId: profile.id,
        cwd: cwd ?? ''
      })
    } else {
      off()
      await rpc.close()
    }
  }
}

// Share only overlapping reads, never a settled capability snapshot: a later refresh must see
// changed models, extensions and project trust. Profile identity and workspace remain isolated.
const piProbesInFlight = new Map<string, Promise<PiProbe>>()

export function probePiAgent(profile: PiAgentProfile, cwd?: string): Promise<PiProbe> {
  const probeCwd = cwd || homedir()
  const key = JSON.stringify([profile.id, profile.executable, probeCwd])
  const pending = piProbesInFlight.get(key)
  if (pending) return pending
  const trace = performanceRecordingEnabled() ? new PerformanceTrace('pi.catalog.probe', { provider: 'pi' }) : undefined
  const probe = withPiRpc(profile, probeCwd, piRpcArgs({ noSession: true, offline: true }), async (rpc) => {
    const [state, models, levels, commands] = await Promise.all([
      rpc.send({ type: 'get_state' }, PI_RPC_STARTUP_TIMEOUT_MS),
      rpc.send({ type: 'get_available_models' }, PI_RPC_STARTUP_TIMEOUT_MS),
      rpc.send({ type: 'get_available_thinking_levels' }, PI_RPC_STARTUP_TIMEOUT_MS),
      rpc.send({ type: 'get_commands' }, PI_RPC_STARTUP_TIMEOUT_MS)
    ])
    const modelRows = record(models.data).models
    const thinkingLevels = record(levels.data).levels
    const commandRows = record(commands.data).commands
    const snapshot: PiProbe = {
      state: record(state.data),
      models: Array.isArray(modelRows) ? modelRows.map(record) : [],
      levels: Array.isArray(thinkingLevels)
        ? thinkingLevels.filter((level): level is string => typeof level === 'string')
        : [],
      commands: Array.isArray(commandRows) ? commandRows.map(record) : []
    }
    return snapshot
  }, trace, key).then(snapshot => {
    trace?.finish()
    return snapshot
  }, (error: unknown) => {
    trace?.finish(undefined, 'error')
    throw error
  }).finally(() => { piProbesInFlight.delete(key) })
  piProbesInFlight.set(key, probe)
  return probe
}

function commandCatalog(probe: PiProbe): ProviderCommand[] {
  return probe.commands.flatMap((command) => {
    if (typeof command.name !== 'string' || !command.name) return []
    const source = command.source === 'skill'
      ? 'skill' as const
      : command.source === 'prompt'
        ? 'custom' as const
        : 'custom' as const
    return [{
      name: command.name,
      description: typeof command.description === 'string' ? command.description : '',
      source
    }]
  })
}

function skillCatalog(probe: PiProbe): SkillMeta[] {
  return probe.commands.flatMap((command) => {
    if (command.source !== 'skill' || typeof command.name !== 'string' || !command.name) return []
    const sourceInfo = record(command.sourceInfo)
    const path = typeof sourceInfo.path === 'string'
      ? sourceInfo.path
      : typeof command.path === 'string'
        ? command.path
        : ''
    const scope = typeof sourceInfo.scope === 'string'
      ? sourceInfo.scope
      : typeof command.location === 'string'
        ? command.location
        : 'unknown'
    return [{
      name: command.name.replace(/^skill:/, ''),
      dir: path ? dirname(path) : '',
      scope,
      description: typeof command.description === 'string' ? command.description : '',
      enabled: true
    }]
  })
}

function piModelContextWindows(models: JsonRecord[]): Map<string, number> {
  const windows = new Map<string, number>()
  for (const model of models) {
    const provider = typeof model.provider === 'string' ? model.provider : undefined
    const id = typeof model.id === 'string' ? model.id : undefined
    const contextWindow = number(model.contextWindow)
    if (provider && id && contextWindow != null && contextWindow > 0) {
      windows.set(`${provider}\0${id}`, contextWindow)
    }
  }
  return windows
}

function piHistoryNeedsModelCatalog(turns: ParsedTurn[]): boolean {
  return turns.some((turn) => turn.items.some((event) => {
    if (event.kind !== 'harness' || event.stage !== 'result' || event.contextTokens == null) return false
    if (contextUsageEvidence(event)) return false
    const model = event.contextModel ?? (event.modelUsage?.length === 1 ? event.modelUsage[0].model : undefined)
    const provider = event.upstreamProvider ?? (typeof event.runtimeMetadata?.provider === 'string' ? event.runtimeMetadata.provider : undefined)
    return Boolean(model && provider)
  }))
}

function enrichPiHistory(turns: ParsedTurn[], windows: ReadonlyMap<string, number>): ParsedTurn[] {
  if (windows.size === 0) return turns
  return turns.map((turn) => ({
    ...turn,
    items: turn.items.map((event) => {
      if (event.kind !== 'harness' || event.stage !== 'result' || event.contextTokens == null) return event
      if (contextUsageEvidence(event)) return event
      const model = event.contextModel ?? (event.modelUsage?.length === 1 ? event.modelUsage[0].model : undefined)
      const provider = event.upstreamProvider ?? (typeof event.runtimeMetadata?.provider === 'string' ? event.runtimeMetadata.provider : undefined)
      if (!model || !provider) return event
      const contextWindow = windows.get(`${provider}\0${model}`)
      if (!contextWindow) return event
      return {
        ...event,
        contextModel: model,
        contextProvider: provider,
        contextUsageSource: 'pi_rpc_archive_usage+current_model_catalog',
        contextUsageQuality: 'inferred',
        modelUsage: (event.modelUsage ?? [{ model, upstreamProvider: provider, usageSource: 'pi_rpc' }]).map((row) =>
          row.model === model && (!row.upstreamProvider || row.upstreamProvider === provider)
            ? { ...row, upstreamProvider: row.upstreamProvider ?? provider, contextWindow }
            : row
        )
      }
    })
  }))
}

function runControlCatalog(probe: PiProbe): AgentRunControlCatalog {
  const current = record(probe.state.model)
  const currentKey = `${String(current.provider ?? '')}\0${String(current.id ?? '')}`
  return {
    models: probe.models.flatMap((model) => {
      if (typeof model.id !== 'string' || typeof model.provider !== 'string') return []
      const key = `${model.provider}\0${model.id}`
      const levelMap = record(model.thinkingLevelMap)
      const levels = key === currentKey
        ? probe.levels
        : model.reasoning === true
          ? [...new Set([
              'off', 'minimal', 'low', 'medium', 'high',
              ...Object.entries(levelMap).filter(([, value]) => value !== null).map(([level]) => level)
            ])]
          : ['off']
      return [{
        model: { id: model.id, providerId: model.provider },
        label: typeof model.name === 'string' ? model.name : model.id,
        ...(key === currentKey ? { isDefault: true } : {}),
        efforts: levels.map((level) => effortOption(level, undefined, level === probe.state.thinkingLevel))
      }]
    }),
    permissions: [{
      id: 'full_access',
      label: '本机完全访问',
      description: 'Pi 没有内置沙箱；launcher、Extension 与工具继承当前本机用户权限'
    }]
  }
}


export { proveExplicitPiSkill, piExtensionCommand, piRpcArgs, withPiRpc, commandCatalog, skillCatalog, piModelContextWindows, piHistoryNeedsModelCatalog, enrichPiHistory, runControlCatalog }
