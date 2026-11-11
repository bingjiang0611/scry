import { realpathSync } from 'node:fs'
import type { SDKUserMessage } from '@qoder-ai/qoder-agent-sdk'
import type { AgentPermissionMode } from '../../shared/runtime'
import { resolveRuntimeCliBin } from '../claude-locate'
import { authorizedMcpServers } from '../mcp-config'
import { signalProcessTreeWithIdentity, type ProcessIdentity } from '../process-diagnostics'
import type { AuthorizedMcpExecution } from './types'

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

/**
 * The exact CLI entry the SDK launches; identity checks must hash this same path.
 * Corporate EDR blocks the qodercli symlink entry from reading ~/.qoder/.auth/user.
 * Resolving the same signed CLI to its JavaScript bundle lets the SDK launch it
 * through Node, preserving the original config/auth/session paths.
 */
export function qoderExecutable(): string | undefined {
  const detected = process.env.SCRY_QODERCLI_PATH?.trim() || resolveRuntimeCliBin('qoder')
  return detected ? resolveQoderSdkExecutable(detected) : undefined
}

/**
 * Session-level options for a query bound to a Scry-owned daemon. Process-level settings
 * (executable, env, auth) belong to the daemon; see `qoder-daemon.ts`.
 */
export function qoderSessionOptions(
  cwd: string | undefined,
  resume?: string,
  permissionMode: AgentPermissionMode = 'default',
  mcpExecution?: AuthorizedMcpExecution
): Record<string, unknown> {
  const permissions = permissionMode === 'full_access'
    ? { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }
    : {
        permissionMode: permissionMode === 'auto_review'
          ? 'auto'
          // Qoder SDK 与 Claude 同源，acceptEdits 是原生档位。
          : permissionMode === 'auto_accept_edits' ? 'acceptEdits' : 'default'
      }
  return {
    cwd,
    resume,
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
    mcpServers: authorizedMcpServers(mcpExecution),
    controlRequestTimeoutMs: 30_000
  }
}
