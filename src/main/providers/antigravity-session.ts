import type { ChildProcess } from 'node:child_process'
import type { AcpInitializeResult, AcpJsonRpcId } from './acp-client'
import { AcpClient, AcpRpcError } from './acp-client'
import { spawnAntigravityAcp, type AntigravityStderrTail } from './antigravity-launch'

/** Per-turn ACP handlers. A reused process keeps one client and swaps these per turn. */
export interface AntigravityTurnHandlers {
  onRawMessage: (direction: 'in' | 'out', line: string) => void
  onNotification: (method: string, params: unknown) => void
  onRequest: (method: string, params: unknown, id: AcpJsonRpcId) => Promise<unknown>
  onProtocolError: () => void
}

export interface AntigravityProcessSession {
  client: AcpClient
  child: ChildProcess
  init: AcpInitializeResult
  identityPromise: ReturnType<typeof spawnAntigravityAcp>['identityPromise']
  stderrTail: AntigravityStderrTail
  /** Native session id this process owns; `undefined` until a turn established one. */
  sessionId: string | undefined
  attach(handlers: AntigravityTurnHandlers): void
  detach(): void
  isClosed(): boolean
  close(): void
}

/** C1: build the long-lived ACP process once and route every turn through swapped handlers. */
export async function openAntigravityProcessSession(args: {
  cwd: string
  permissionMode: string
  baseEnv: Record<string, string>
  extraEnv?: Record<string, string>
  clientVersion: string
  stderrTail: AntigravityStderrTail
  /** Runs immediately after spawn so an interrupt during `initialize` can still signal by identity. */
  onSpawn?: (spawned: { child: ChildProcess; identityPromise: AntigravityProcessSession['identityPromise'] }) => void
}): Promise<AntigravityProcessSession> {
  const spawned = spawnAntigravityAcp({
    cwd: args.cwd,
    permissionMode: args.permissionMode as 'default' | 'auto_accept_edits' | 'full_access',
    baseEnv: args.baseEnv,
    extraEnv: args.extraEnv,
    stderrTail: args.stderrTail
  })
  args.onSpawn?.({ child: spawned.child, identityPromise: spawned.identityPromise })
  let active: AntigravityTurnHandlers | undefined
  const client = new AcpClient(spawned.child, {
    onRawMessage: (direction, rawLine) => active?.onRawMessage(direction, rawLine),
    onNotification: (method, params) => active?.onNotification(method, params),
    onRequest: async (method, params, id) => (active ? active.onRequest(method, params, id) : undefined),
    onProtocolError: () => active?.onProtocolError()
  })
  const init = await client.initialize(args.clientVersion)
  const session: AntigravityProcessSession = {
    client,
    child: spawned.child,
    init,
    identityPromise: spawned.identityPromise,
    stderrTail: args.stderrTail,
    sessionId: undefined,
    attach: (handlers) => {
      active = handlers
    },
    detach: () => {
      active = undefined
    },
    isClosed: () => client.isClosed,
    close: () => client.closeStdin()
  }
  return session
}

/**
 * `session/resume` → `session/load` → `session/new`, preserving the P7 §3 replay suppression and
 * the non-browser `authenticate` fallback that only runs for explicitly allowed env credentials.
 */
export async function openAntigravityNativeSession(args: {
  session: AntigravityProcessSession
  cwd: string
  resume?: string
  mcpServers: Array<Record<string, unknown>>
  allowedEnv: Set<string>
  rawEnv: Record<string, string | undefined>
  translator: { suppressReplay: boolean }
  isAuthFailure: (error: unknown) => boolean
}): Promise<string> {
  const { session, cwd, mcpServers } = args
  const open = async (): Promise<string> => {
    if (args.resume) {
      try {
        const resumed = await session.client.request<{ sessionId?: string }>('session/resume', {
          sessionId: args.resume,
          cwd,
          mcpServers
        })
        return resumed?.sessionId || args.resume
      } catch (resumeErr) {
        if (args.isAuthFailure(resumeErr)) throw resumeErr
        args.translator.suppressReplay = true
        try {
          const loaded = await session.client.request<{ sessionId?: string }>('session/load', {
            sessionId: args.resume,
            cwd,
            mcpServers
          })
          return loaded?.sessionId || args.resume
        } finally {
          args.translator.suppressReplay = false
        }
      }
    }
    const created = await session.client.request<{ sessionId: string }>('session/new', { cwd, mcpServers })
    if (!created?.sessionId) throw new Error('Antigravity ACP session/new 未返回 sessionId')
    return created.sessionId
  }
  try {
    return await open()
  } catch (err) {
    if (!(err instanceof AcpRpcError) || err.code !== -32000 || session.client.loginPromptDetected) throw err
    if (args.allowedEnv.has('GEMINI_API_KEY') && args.rawEnv.GEMINI_API_KEY) {
      await session.client.request('authenticate', { methodId: 'gemini-api-key' })
      return open()
    }
    if (
      args.allowedEnv.has('AGY_ADC_AUTH') && args.rawEnv.AGY_ADC_AUTH &&
      (args.rawEnv.GOOGLE_CLOUD_PROJECT || args.rawEnv.GCLOUD_PROJECT)
    ) {
      await session.client.request('authenticate', { methodId: 'agent-platform' })
      return open()
    }
    throw err
  }
}
