import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { qodercliAuth, type SDKUserMessage } from '@qoder-ai/qoder-agent-sdk'
import type { AgentPermissionMode } from '../../shared/runtime'
import { maskSecrets } from '../../shared/trace'
import { resolveRuntimeCliBin, runtimeCliEnv } from '../claude-locate'
import { authorizedMcpServers } from '../mcp-config'
import { captureProcessIdentity, signalProcessTreeWithIdentity, type ProcessIdentity } from '../process-diagnostics'
import { writePrivateMcpConfig, type PrivateMcpConfig } from './private-mcp-config'
import type { AuthorizedMcpExecution, ProviderRunRequest } from './types'

export function heldPrompt(): { stream: AsyncIterable<never>; release: () => void } {
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

export function livePrompt(
  text: string,
  userMessageUuid: string
): { stream: AsyncIterable<SDKUserMessage>; release: () => void } {
  let release = (): void => {}
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    stream: (async function* (): AsyncIterable<SDKUserMessage> {
      yield {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
        // Scry-owned identity for the one submitted user message: the native
        // transcript must persist this same UUID for an input receipt.
        uuid: userMessageUuid
      } as SDKUserMessage
      await wait
    })(),
    release
  }
}

const STDERR_KEPT_CHARS = 8_192
const STDERR_REPORTED_CHARS = 4_096

/**
 * The end of the CLI's stderr, for a run that fails. The SDK keeps stderr only for a CLI
 * it spawned itself; Scry spawns this one (for its process identity), so without this
 * an exit reads "Qoder CLI process exited with code 1" and nothing says why. A diagnostic,
 * not Provider evidence: bounded and with secrets masked before it reaches any reason.
 */
export class QoderStderrTail {
  #text = ''
  #truncated = false

  push(chunk: string): void {
    this.#text += chunk
    if (this.#text.length <= STDERR_KEPT_CHARS) return
    this.#text = this.#text.slice(-STDERR_KEPT_CHARS)
    this.#truncated = true
  }

  /** The error the run fails with, followed by the CLI's own last words when it said any. */
  attach(error: unknown): unknown {
    // A cut buffer starts mid-line, possibly mid-secret: drop that line before masking.
    const kept = this.#truncated ? this.#text.slice(this.#text.indexOf('\n') + 1) : this.#text
    const tail = (maskSecrets(kept.trim()) ?? '').slice(-STDERR_REPORTED_CHARS)
    if (!tail || !(error instanceof Error) || error.message.includes(tail)) return error
    error.message = `${error.message}\nQoder CLI stderr (last ${tail.length} chars, secrets masked):\n${tail}`
    return error
  }
}

/**
 * 按身份给 Qoder CLI 进程树发信号。
 *
 * 这里只有一个裸 PID（SDK 回调给出，不是活的 child 句柄），进程可能已经退出并被
 * 别人复用。所以 spawn 时采集 `(pid, 启动时间, 命令行)`，发信号前重新核对；
 * 核对不上就不发；身份不可用时不发送任何信号。
 */
export function signalProcessTree(identityPromise: Promise<ProcessIdentity | undefined> | undefined, signal: NodeJS.Signals): void {
  if (!identityPromise) return
  void (async () => {
    let identity: ProcessIdentity | undefined
    try {
      identity = await identityPromise
    } catch {
      return
    }
    // 身份未知、超时或采集失败时 fail closed；不走 win32 或句柄直发 fallback。
    if (!identity?.startedAt || process.platform === 'win32') return
    try {
      signalProcessTreeWithIdentity({ identity, signal })
    } catch {
      // 复核失败或 ps 不可用时拒绝发信号。
    }
  })()
}

export function resolveQoderSdkExecutable(executable: string): string {
  try {
    return realpathSync(executable)
  } catch {
    return executable
  }
}

export interface QoderMcpLaunch {
  options: { mcpServers: Record<string, unknown>; extraArgs?: PrivateMcpConfig['extraArgs'] }
  dispose(): void
}

/**
 * The authorized MCP servers for one Qoder launch, kept off the CLI argv. The SDK
 * would serialize them into `--mcp-config <json>`; qodercli reads a value that does
 * not start with `{` as a file path (`resolveMcpConfigEntry`, 1.1.11 and 1.1.92), so
 * they go to a private file instead. The SDK's `buildCliMcpServers` passes a config
 * through unchanged unless it has `tools`, which it rewrites into `toolOverrides` and
 * `--settings` permission rules; Scry cannot reproduce that exactly, so such a launch
 * keeps the SDK's inline form, and its argv exposure, rather than change behaviour.
 */
export function qoderMcpLaunch(execution?: AuthorizedMcpExecution): QoderMcpLaunch {
  const servers = authorizedMcpServers(execution)
  if (Object.values(servers).some((config) => Object.hasOwn(config, 'tools'))) {
    return { options: { mcpServers: servers }, dispose: () => {} }
  }
  const file = writePrivateMcpConfig(servers)
  return file
    ? { options: { mcpServers: {}, extraArgs: file.extraArgs }, dispose: file.dispose }
    : { options: { mcpServers: {} }, dispose: () => {} }
}

/** The exact CLI entry the SDK launches; identity checks must hash this same path. */
export function qoderExecutable(): string | undefined {
  const detected = process.env.SCRY_QODERCLI_PATH?.trim() || resolveRuntimeCliBin('qoder')
  return detected ? resolveQoderSdkExecutable(detected) : undefined
}

export function qoderOptions(
  cwd: string | undefined,
  resume?: string,
  onPid?: (pid: number, identity: Promise<ProcessIdentity | undefined>) => void,
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void,
  permissionMode: AgentPermissionMode = 'default',
  managedRecorder = false,
  mcp: QoderMcpLaunch['options'] = { mcpServers: {} },
  managedIdentity?: ProviderRunRequest['managedRecorderIdentity'],
  stderrTail?: QoderStderrTail
): Record<string, unknown> {
  const executable = qoderExecutable()
  if (!executable) throw new Error('Qoder CLI 未找到')
  // Corporate EDR blocks the qodercli symlink entry from reading ~/.qoder/.auth/user.
  // Resolving the same signed CLI to its JavaScript bundle lets the SDK launch it
  // through Node, preserving the original config/auth/session paths.
  const runtimeEnv = runtimeCliEnv(
    undefined,
    managedRecorder ? { managedRecorder: true, providerId: 'qoder' } : { providerId: 'qoder' }
  )
  delete runtimeEnv.SCRY_MANAGED_RUN_ID
  delete runtimeEnv.SCRY_MANAGED_PROMPT_HASH
  const permissions = permissionMode === 'full_access'
    ? { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }
    : {
        permissionMode: permissionMode === 'auto_review'
          ? 'auto'
          // Qoder SDK 与 Claude 同源，acceptEdits 是原生档位。
          : permissionMode === 'auto_accept_edits' ? 'acceptEdits' : 'default'
      }
  return {
    auth: qodercliAuth(),
    cwd,
    resume,
    pathToQoderCLIExecutable: executable,
    env: {
      ...runtimeEnv,
      ...(managedRecorder && managedIdentity ? {
        SCRY_MANAGED_RUN_ID: managedIdentity.runId,
        SCRY_MANAGED_PROMPT_HASH: managedIdentity.promptHash
      } : {}),
      // Waiting is visible in Scry, with explicit user-controlled cancellation.
      // Silence must not trigger the CLI's destructive background wait ceiling.
      QODERCLI_PRINT_BG_WAIT_CEILING_MS: '0'
    },
    ...permissions,
    includePartialMessages: true,
    includeHookEvents: true,
    settingSources: ['user', 'project', 'local'],
    // Qoder SDK mode disables the cross-agent compatibility directory by default.
    // Enable discovery only; Qoder's native folder trust still gates project skills.
    settings: { skills: { loadFromAgentsDirectory: true } },
    // Qoder must never discover MCP implicitly. Scry injects only the exact
    // fingerprinted configs that passed Scry's Guard and execution checks.
    strictMcpConfig: true,
    ...mcp,
    controlRequestTimeoutMs: 30_000,
    ...(onPid
      ? {
          spawnQoderCLIProcess: (options: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal }) => {
            const child = spawn(options.command, options.args, {
              cwd: options.cwd,
              env: options.env as NodeJS.ProcessEnv,
              detached: process.platform !== 'win32',
              stdio: ['pipe', 'pipe', 'pipe']
            })
            // 立刻发起身份采集；进程还活着时采到的启动时间才能作为后续核对基准。
            const identityPromise = captureProcessIdentity(child.pid)
            if (child.pid) onPid(child.pid, identityPromise)
            child.once('exit', (code, signal) => onExit?.(code, signal))
            // Read even when nobody keeps it: an unread pipe would stall a CLI that writes a lot.
            child.stderr?.setEncoding('utf8')
            child.stderr?.on('data', (chunk: string) => stderrTail?.push(chunk))
            options.signal.addEventListener('abort', () => signalProcessTree(identityPromise, 'SIGTERM'), { once: true })
            return child
          }
        }
      : {})
  }
}
