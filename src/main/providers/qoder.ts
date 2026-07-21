import { qodercliAuth, query, type AccountInfo, type McpServerStatus, type Query, type SlashCommand, type UsageInfo } from '@qoder-ai/qoder-agent-sdk'
import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { capabilityReady, capabilityUnknown, type AccountSnapshot, type McpSnapshot, type ProviderContext, type SkillMeta } from '../../shared/provider'
import type { McpLiveStatus, TraceEvent } from '../../shared/trace'
import { resolveRuntimeCliBin, runtimeCliEnv, shellEnv } from '../claude-locate'
import { normalizeSdkMessage, type NormalizeCtx } from '../normalize'
import type { ProviderAdapter, ProviderRunRequest } from './types'

interface Cached<T> {
  data: T
  observedAt: number
}

interface QoderControlSession {
  query: Query
  releasePrompt: () => void
  ready: Promise<unknown>
  active: number
  idleTimer?: NodeJS.Timeout
}

const PROBE_TTL_MS = 30_000
let counter = 0
const newId = (): string => `qoder-${Date.now().toString(36)}-${(counter++).toString(36)}`

function heldPrompt(): { stream: AsyncIterable<never>; release: () => void } {
  let release = (): void => {}
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    stream: (async function* (): AsyncIterable<never> {
      await wait
    })(),
    release
  }
}

function qoderOptions(cwd: string | undefined, resume?: string, onPid?: (pid: number) => void): Record<string, unknown> {
  const executable = process.env.SCRY_QODERCLI_PATH?.trim() || resolveRuntimeCliBin('qoder')
  if (!executable) throw new Error('Qoder CLI 未找到')
  return {
    auth: qodercliAuth(),
    cwd,
    resume,
    pathToQoderCLIExecutable: executable,
    env: runtimeCliEnv(shellEnv()),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    includeHookEvents: true,
    settingSources: ['user', 'project', 'local'],
    controlRequestTimeoutMs: 30_000,
    ...(onPid
      ? {
          spawnQoderCLIProcess: (options: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal }) => {
            const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] })
            if (child.pid) onPid(child.pid)
            options.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true })
            return child
          }
        }
      : {})
  }
}

function fields(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const pattern = /(\w+)=("(?:\\.|[^"])*"|\S+)/g
  for (const match of text.matchAll(pattern)) {
    const raw = match[2]
    if (raw.startsWith('"')) {
      try { out[match[1]] = JSON.parse(raw) as string } catch { out[match[1]] = raw.slice(1, -1) }
    } else out[match[1]] = raw
  }
  return out
}

export function parseQoderHookLog(runId: string, text: string, sessionId?: string): TraceEvent[] {
  const events: TraceEvent[] = []
  const pending = new Map<string, Array<Record<string, string>>>()
  for (const line of text.split('\n')) {
    const match = line.match(/^(\S+)\s+\S+\s+(?:\[([^\]]+)\]\s+)?hook\.(started|finished)\s+(.+)$/)
    if (!match) continue
    const context = fields(match[2] ?? '')
    const detail = fields(match[4])
    if (sessionId && context.session !== sessionId) continue
    const hookName = detail.hook_name ?? 'hook'
    const hookEvent = detail.hook_event_name ?? 'Hook'
    const key = [context.session ?? '', context.tool ?? '', hookName, hookEvent].join('|')
    if (match[3] === 'started') {
      const queue = pending.get(key) ?? []
      queue.push(detail)
      pending.set(key, queue)
      const hookId = `qoder-log:${key}:${detail.source ?? 'unknown'}:${detail.hook_index ?? queue.length}`
      events.push({
        id: `${hookId}:start`, runId, ts: new Date(match[1]).toISOString(), kind: 'hook', stage: 'hook_started',
        tool: hookName, name: hookEvent, hookId, hookName, hookEvent, hookCommand: detail.display_text,
        hookOutcome: 'started', toolUseId: context.tool,
        input: { sessionId: context.session, turnId: context.turn, source: detail.source, hookIndex: detail.hook_index },
        runtimeMetadata: { source: 'qoder_cli_log', hookSource: detail.source, hookIndex: detail.hook_index }
      })
      continue
    }
    const started = pending.get(key)?.shift() ?? {}
    const hookId = `qoder-log:${key}:${started.source ?? 'unknown'}:${started.hook_index ?? 'unknown'}`
    const success = detail.success === 'true'
    const exitCode = detail.exit_code == null ? undefined : Number(detail.exit_code)
    events.push({
      id: `${hookId}:response`, runId, ts: new Date(match[1]).toISOString(), kind: 'hook', stage: 'hook_response',
      tool: hookName, name: hookEvent, hookId, hookName, hookEvent, hookCommand: started.display_text,
      hookOutcome: success ? 'success' : 'error', hookExitCode: Number.isFinite(exitCode) ? exitCode : undefined,
      toolUseId: context.tool, durationMs: detail.duration_ms == null ? undefined : Number(detail.duration_ms), isError: !success,
      input: { sessionId: context.session, turnId: context.turn, source: started.source, hookIndex: started.hook_index },
      runtimeMetadata: { source: 'qoder_cli_log', hookSource: started.source, hookIndex: started.hook_index }
    })
  }
  return events
}

function hookFingerprint(event: TraceEvent): string {
  const source = event.runtimeMetadata?.source
  const command = event.hookCommand ?? (source === 'qoder_sdk' ? event.hookName : undefined)
  return [event.stage, event.hookEvent, command, event.toolUseId, event.hookOutcome].join('|')
}

export function qoderHookFallbackOnly(sdkHooks: TraceEvent[], fallback: TraceEvent[]): TraceEvent[] {
  const sdkCounts = new Map<string, number>()
  for (const event of sdkHooks) sdkCounts.set(hookFingerprint(event), (sdkCounts.get(hookFingerprint(event)) ?? 0) + 1)
  return fallback.filter((event) => {
    const key = hookFingerprint(event)
    const remaining = sdkCounts.get(key) ?? 0
    if (remaining === 0) return true
    sdkCounts.set(key, remaining - 1)
    return false
  })
}

async function qoderHookLog(pid: number): Promise<string> {
  const configDir = process.env.QODER_CONFIG_DIR ?? join(process.env.QODER_CLI_HOME ?? homedir(), '.qoder')
  const root = join(configDir, 'logs', 'runs')
  const entries = await readdir(root, { withFileTypes: true })
  const match = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith(`-p${pid}`)).map((entry) => entry.name).sort().at(-1)
  if (!match) throw new Error(`Qoder log for pid ${pid} not found`)
  return readFile(join(root, match, 'qodercli.log'), 'utf8')
}

function qoderMcpSnapshot(statuses: McpServerStatus[]): McpSnapshot {
  const runtime: McpLiveStatus[] = statuses.map((server) => ({
    name: server.name,
    status: server.status,
    serverName: server.serverInfo?.name,
    serverVersion: server.serverInfo?.version,
    tools: server.tools?.length
  }))
  return {
    configured: statuses.map((server) => {
      const config = server.config
      const transport = config && 'type' in config ? config.type ?? 'stdio' : 'stdio'
      const detail = config && 'url' in config ? config.url : config && 'command' in config ? config.command : server.error ?? server.status
      return { name: server.name, scope: server.scope ?? 'qoder', transport, detail, enabled: server.status !== 'disabled' }
    }),
    runtime
  }
}

function qoderTrace(event: TraceEvent): TraceEvent {
  if (event.kind !== 'harness' || event.stage !== 'result') return event
  const reportedTokens = [event.tokensIn, event.tokensOut, event.cacheReadTokens, event.cacheCreationTokens, event.reasoningTokens]
  const reportedZeroUsage = reportedTokens.some((value) => value != null) && reportedTokens.every((value) => value == null || value === 0)
  return {
    ...event,
    tokensIn: reportedZeroUsage ? undefined : event.tokensIn,
    tokensOut: reportedZeroUsage ? undefined : event.tokensOut,
    cacheReadTokens: reportedZeroUsage ? undefined : event.cacheReadTokens,
    cacheCreationTokens: reportedZeroUsage ? undefined : event.cacheCreationTokens,
    reasoningTokens: reportedZeroUsage ? undefined : event.reasoningTokens,
    costUsd: undefined,
    costSource: undefined,
    costConfidence: undefined,
    costUnit: undefined,
    modelUsage: event.modelUsage?.map((usage) => {
      const values = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreationTokens, usage.reasoningTokens]
      const zero = values.some((value) => value != null) && values.every((value) => value == null || value === 0)
      return {
        ...usage,
        inputTokens: zero ? undefined : usage.inputTokens,
        outputTokens: zero ? undefined : usage.outputTokens,
        cacheReadTokens: zero ? undefined : usage.cacheReadTokens,
        cacheCreationTokens: zero ? undefined : usage.cacheCreationTokens,
        reasoningTokens: zero ? undefined : usage.reasoningTokens,
        costUsd: undefined,
        costSource: undefined,
        costConfidence: undefined,
        costUnit: undefined,
        billingProvider: 'qoder',
        upstreamProvider: 'qoder',
        usageSource: 'qoder_sdk'
      }
    }),
    runtimeMetadata: { ...(event.runtimeMetadata ?? {}), source: 'qoder_sdk', billingProvider: 'qoder', reportedZeroUsage },
    billingProvider: 'qoder',
    upstreamProvider: 'qoder',
    usageSource: 'qoder_sdk'
  }
}

export function createQoderAdapter(): ProviderAdapter {
  const controls = new Map<string, QoderControlSession>()
  const skillCache = new Map<string, Cached<{ data: SkillMeta[]; total: number; included: number }>>()
  const commandCache = new Map<string, Cached<SlashCommand[]>>()
  const mcpCache = new Map<string, Cached<McpServerStatus[]>>()
  const accountCache = new Map<string, Cached<{ usage: UsageInfo | null; account: AccountInfo }>>()
  let lastHookFallbackError: string | undefined
  let hookFallbackObserved = false

  const closeControl = (key: string, session: QoderControlSession): void => {
    if (controls.get(key) !== session) return
    controls.delete(key)
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.releasePrompt()
    void Promise.resolve(session.query.close()).catch(() => {})
  }

  const controlFor = (context: ProviderContext): [string, QoderControlSession] => {
    const key = context.cwd ?? ''
    const existing = controls.get(key)
    if (existing) return [key, existing]
    const prompt = heldPrompt()
    const q = query({ prompt: prompt.stream, options: qoderOptions(context.cwd) as never })
    const session: QoderControlSession = {
      query: q,
      releasePrompt: prompt.release,
      ready: q.initializationResult(),
      active: 0
    }
    controls.set(key, session)
    return [key, session]
  }

  const withControl = async <T>(context: ProviderContext, read: (q: Query) => Promise<T>): Promise<T> => {
    const [key, session] = controlFor(context)
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.active++
    try {
      await session.ready
      return await read(session.query)
    } catch (error) {
      if (/transport|closed|process|broken pipe/i.test(String((error as Error).message))) closeControl(key, session)
      throw error
    } finally {
      session.active--
      if (controls.get(key) === session && session.active === 0) {
        session.idleTimer = setTimeout(() => closeControl(key, session), 5_000)
      }
    }
  }

  return {
    id: 'qoder',
    runtimeProvider: 'qoder_cli',
    describe: async () => {
      const path = process.env.SCRY_QODERCLI_PATH?.trim() || resolveRuntimeCliBin('qoder')
      return {
        id: 'qoder',
        label: 'Qoder',
        runtimeProvider: 'qoder_cli',
        transport: 'Qoder Agent SDK',
        available: !!path,
        path,
        capabilities: { skills: 'read', mcp: 'read', commands: 'read', account: 'read' },
        health: lastHookFallbackError
          ? { state: 'degraded', transport: 'Qoder Agent SDK', lastError: lastHookFallbackError }
          : { state: !path ? 'unavailable' : hookFallbackObserved ? 'ready' : 'unknown', transport: 'Qoder Agent SDK' }
      }
    },
    run: (request: ProviderRunRequest) => {
      const controller = new AbortController()
      let stopped = false
      let externalSessionId = request.resume
      let q: Query | undefined
      let qoderPid: number | undefined
      let streamedText = ''
      const sdkHooks: TraceEvent[] = []
      const ctx: NormalizeCtx = { runId: request.runId, cwd: request.cwd, newId, now: () => new Date().toISOString() }
      const promise = (async () => {
        q = query({
          prompt: request.prompt,
          options: { ...qoderOptions(request.cwd, request.resume, (pid) => { qoderPid = pid }), abortController: controller } as never
        })
        let statuses: McpServerStatus[] | undefined
        try {
          for await (const message of q) {
            const raw = message as unknown as Record<string, unknown>
            if (typeof raw.session_id === 'string' && raw.session_id !== externalSessionId) {
              externalSessionId = raw.session_id
              request.onExternalSessionId?.(raw.session_id)
            }
            if (raw.type === 'system' && raw.subtype === 'init' && Array.isArray(raw.mcp_servers)) {
              statuses = (raw.mcp_servers as Array<{ name: string; status: McpServerStatus['status'] }>).map((server) => ({
                name: server.name,
                status: server.status
              }))
            }
            for (const rawEvent of normalizeSdkMessage(message, ctx)) {
              const event = qoderTrace(rawEvent)
              if (event.kind === 'hook') sdkHooks.push(event)
              if (event.kind === 'model' && event.stage === 'text_delta') {
                streamedText += event.text ?? ''
                request.emit(event)
              } else if (event.kind === 'model' && event.stage === 'text' && streamedText) {
                const full = event.text ?? ''
                const remainder = full.startsWith(streamedText) ? full.slice(streamedText.length) : full
                streamedText = ''
                if (remainder) request.emit({ ...event, text: remainder })
              } else {
                request.emit(event)
              }
            }
          }
        } finally {
          await q.close()
        }
        if (process.env.SCRY_QODER_LOG_HOOKS?.trim() !== '0' && qoderPid) {
          try {
            const fallback = parseQoderHookLog(request.runId, await qoderHookLog(qoderPid), externalSessionId)
            for (const event of qoderHookFallbackOnly(sdkHooks, fallback)) request.emit(event)
            lastHookFallbackError = undefined
            hookFallbackObserved = true
          } catch (error) {
            lastHookFallbackError = String((error as Error).message)
            request.emit({
              id: newId(), runId: request.runId, ts: new Date().toISOString(),
              kind: 'harness', stage: 'runtime:telemetry_degraded', text: lastHookFallbackError,
              runtimeMetadata: { source: 'qoder_cli_log', capability: 'hooks' }
            })
          }
        } else if (process.env.SCRY_QODER_LOG_HOOKS?.trim() !== '0' && !qoderPid) {
          lastHookFallbackError = 'Qoder Hook fallback could not identify the current CLI process'
        }
        return { externalSessionId, stopped, mcp: statuses ? qoderMcpSnapshot(statuses) : undefined }
      })()
      const interrupt = (): void => {
        stopped = true
        controller.abort()
        void q?.interrupt().catch(() => {})
      }
      return { promise, interrupt, getExternalSessionId: () => externalSessionId }
    },
    skills: {
      list: async (context) => {
        try {
          const key = context.cwd ?? ''
          let value = skillCache.get(key)
          if (!value || Date.now() - value.observedAt >= PROBE_TTL_MS) {
            const catalog = await withControl(context, async (q) => {
              const [usage, commands] = await Promise.all([q.getContextUsage(), q.supportedCommands()])
              const descriptions = new Map(commands.map((command) => [command.name, command.description]))
              const skills = usage.skills
              return {
                data: (skills?.skillFrontmatter ?? []).map((skill) => ({
                  name: skill.name,
                  dir: skill.source,
                  scope: skill.source,
                  description: descriptions.get(skill.name) ?? '',
                  enabled: true
                })),
                total: skills?.totalSkills ?? 0,
                included: skills?.includedSkills ?? 0
              }
            })
            value = { data: catalog, observedAt: Date.now() }
            skillCache.set(key, value)
          }
          const ready = capabilityReady(context, 'read', value.data.data, value.observedAt)
          return value.data.included < value.data.total
            ? { ...ready, state: 'degraded' as const, reason: `Qoder 仅返回 ${value.data.included}/${value.data.total} 个已加载 Skill 的元数据` }
            : ready
        } catch (error) {
          return capabilityUnknown<SkillMeta[]>(context, 'read', String((error as Error).message))
        }
      }
    },
    mcp: {
      snapshot: async (context, refresh = false) => {
        try {
          const key = context.cwd ?? ''
          let value = mcpCache.get(key)
          if (refresh || !value || Date.now() - value.observedAt >= PROBE_TTL_MS) {
            value = { data: await withControl(context, (q) => q.mcpServerStatus()), observedAt: Date.now() }
            mcpCache.set(key, value)
          }
          return capabilityReady(context, 'read', qoderMcpSnapshot(value.data), value.observedAt)
        } catch (error) {
          return capabilityUnknown<McpSnapshot>(context, 'read', String((error as Error).message))
        }
      }
    },
    commands: {
      list: async (context) => {
        try {
          const key = context.cwd ?? ''
          let value = commandCache.get(key)
          if (!value || Date.now() - value.observedAt >= PROBE_TTL_MS) {
            value = { data: await withControl(context, (q) => q.supportedCommands()), observedAt: Date.now() }
            commandCache.set(key, value)
          }
          return capabilityReady(
            context,
            'read',
            value.data.map((command) => ({
              name: command.name,
              description: command.description,
              argumentHint: command.argumentHint || undefined,
              source: 'builtin' as const
            })),
            value.observedAt
          )
        } catch (error) {
          return capabilityUnknown(context, 'read', String((error as Error).message))
        }
      }
    },
    account: {
      read: async (context) => {
        try {
          const key = context.cwd ?? ''
          let value = accountCache.get(key)
          if (!value || Date.now() - value.observedAt >= PROBE_TTL_MS) {
            const [usage, account] = await withControl(context, (q) => Promise.all([q.getUsageInfo(), q.accountInfo()]))
            value = { data: { usage, account }, observedAt: Date.now() }
            accountCache.set(key, value)
          }
          const data: AccountSnapshot = {
            accountLabel: value.data.account.email ?? value.data.account.name ?? value.data.account.userId,
            plan: value.data.account.subscriptionType ?? value.data.usage?.userType,
            usage: value.data.usage
          }
          return capabilityReady(context, 'read', data, value.observedAt)
        } catch (error) {
          return capabilityUnknown<AccountSnapshot>(context, 'read', String((error as Error).message))
        }
      }
    },
    dispose: () => {
      for (const [key, session] of controls) closeControl(key, session)
    }
  }
}
