import { app } from 'electron'
import { homedir } from 'node:os'
import { packagedRecorderCliPath, shellEnv } from '../claude-locate'
import { AgentRuntimeError } from '../run-outcome'
import { codexHookFingerprint, hooksRequiringBypass, type CodexHookInspection, type CodexHookTrustGrant, createCodexHookGrantStore } from '../codex-hook-trust'
import { createOpenCodePluginGrantStore, type OpenCodeProjectPluginAuthorization } from '../opencode-plugin-trust'
import { readOpenCodeProjectProjection } from '../providers/opencode-server'
import { inspectCommitHookBundle, resolveGrantedCommitHookCapability, createCommitHookTrustStore } from '../commit-hook-trust'
import { resolveRecorderEnablement } from '../../core/turn-recorder/config'
import { buildMcpExecutionSnapshot, type McpExecutionOperation, type McpExecutionSnapshot, McpExecutionTrust } from '../mcp-execution-trust'
import type { ProviderRegistry } from '../providers/registry'
import type { ProviderContext } from '../../shared/provider'
import type { AuthorizedMcpExecution } from '../providers/types'

const homeDir = homedir()
const mcpExecutionTrust = new McpExecutionTrust()

export function codexHookInspectionError(cwd: string, message: string, nextAction: string): AgentRuntimeError {
  return new AgentRuntimeError(message, {
    provider: 'codex_cli',
    stage: 'capability',
    cwd,
    nextAction
  })
}

export async function resolveCodexHookTrust(cwd: string, providerRegistry: ProviderRegistry): Promise<CodexHookTrustGrant[]> {
  let inspection: CodexHookInspection
  try {
    inspection = await providerRegistry.inspectHookTrust({ providerId: 'codex', cwd })
  } catch (error) {
    throw codexHookInspectionError(
      cwd,
      `Codex Hook 预检失败：${String((error as Error).message)}`,
      '确认 Codex CLI 可用并重试；Scry 不会在无法校验 Hook 指纹时自动绕过信任'
    )
  }
  if (inspection.errors.length > 0) {
    throw codexHookInspectionError(
      cwd,
      `Codex Hook 配置读取失败：${inspection.errors.join('；')}`,
      '修复 Codex hooks/list 报告的配置错误后重试'
    )
  }

  const pending = hooksRequiringBypass(inspection.hooks)
  if (pending.length === 0) return []

  const trust = pending.map(({ key, currentHash }) => ({ key, currentHash }))
  const fingerprint = codexHookFingerprint(inspection.hooks)
  const store = createCodexHookGrantStore(app.getPath('userData'))
  if (!store.isGranted(cwd, fingerprint)) {
    const enabledCount = inspection.hooks.filter((hook) => hook.enabled).length
    try {
      store.grant(cwd, fingerprint, enabledCount)
    } catch (error) {
      throw codexHookInspectionError(
        cwd,
        `Codex Hook 授权保存失败：${String((error as Error).message)}`,
        '检查 Scry userData 目录写权限后重试'
      )
    }
  }
  return trust
}

export async function resolveOpenCodePluginTrust(cwd: string): Promise<OpenCodeProjectPluginAuthorization | undefined> {
  let projection
  try {
    projection = await readOpenCodeProjectProjection(cwd)
  } catch (error) {
    throw new AgentRuntimeError(`OpenCode 项目 plugin 预检失败：${String((error as Error).message)}`, {
      provider: 'opencode_server',
      stage: 'capability',
      cwd,
      nextAction: '修复 opencode.json plugin 声明；Scry 仅允许本仓内 ./ 相对普通文件'
    })
  }
  if (projection.plugins.length === 0) return undefined

  const store = createOpenCodePluginGrantStore(app.getPath('userData'))
  if (!store.isGranted(projection.cwd, projection.pluginFingerprint)) {
    try {
      store.grant(projection.cwd, projection.pluginFingerprint, projection.plugins.length)
    } catch (error) {
      throw new AgentRuntimeError(`OpenCode 项目 plugin 授权保存失败：${String((error as Error).message)}`, {
        provider: 'opencode_server',
        stage: 'capability',
        cwd,
        nextAction: '检查 Scry userData 目录写权限后重试'
      })
    }
  }
  return {
    cwd: projection.cwd,
    fingerprint: projection.pluginFingerprint,
    plugins: projection.plugins
  }
}

export function withoutCommitHookCapability(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env }
  delete copy.SCRY_RECORDER_COMMIT_HOOK
  delete copy.SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT
  return copy
}

export async function resolveManagedCommitHookEnv(
  cwd: string,
  knownEnablement?: Awaited<ReturnType<typeof resolveRecorderEnablement>>
): Promise<NodeJS.ProcessEnv> {
  const baseEnv = withoutCommitHookCapability()
  // managedRecorderMode 已在发送前验证过同一份配置时复用结果，避免热路径重复读取、
  // 解析并遍历 .scry 配置。调用方没有快照（例如独立恢复路径）时仍在这里现查。
  const enablement = knownEnablement ?? await resolveRecorderEnablement(cwd)
  if (!enablement.enabled || !enablement.config.commitHook) return baseEnv
  let inspection
  try {
    inspection = await inspectCommitHookBundle(cwd, enablement.config.commitHook)
  } catch (error) {
    console.warn('[scry] recorder commit hook bundle inspection failed:', cwd, error)
    return baseEnv
  }

  const store = createCommitHookTrustStore(app.getPath('userData'))
  let granted = await store.isGranted(inspection.workspace, inspection.fingerprint)
  if (granted) {
    try {
      const capability = await store.materialize(inspection)
      const recorderCli = packagedRecorderCliPath() ?? baseEnv.SCRY_CLI_PATH
      return {
        ...baseEnv,
        ...capability.env,
        ...(recorderCli ? { SCRY_CLI_PATH: recorderCli } : {}),
        SCRY_RECORDER_MANAGED: '1'
      }
    } catch (error) {
      console.warn('[scry] recorder commit hook materialization failed:', cwd, error)
      await store.revoke(inspection.workspace, inspection.fingerprint).catch(() => undefined)
      granted = false
    }
  }
  if (!granted) {
    try {
      await store.grant(inspection.workspace, inspection.fingerprint, 'auto')
    } catch (error) {
      console.warn('[scry] recorder commit hook grant failed:', cwd, error)
      return baseEnv
    }
  }

  try {
    const capability = await store.materialize(inspection)
    const recorderCli = packagedRecorderCliPath() ?? baseEnv.SCRY_CLI_PATH
    return {
      ...baseEnv,
      ...capability.env,
      ...(recorderCli ? { SCRY_CLI_PATH: recorderCli } : {}),
      SCRY_RECORDER_MANAGED: '1'
    }
  } catch (error) {
    console.warn('[scry] recorder commit hook materialization failed:', cwd, error)
    return baseEnv
  }
}

export async function resolveGrantedManagedCommitHookEnv(cwd: string): Promise<NodeJS.ProcessEnv> {
  const baseEnv = withoutCommitHookCapability()
  const enablement = await resolveRecorderEnablement(cwd)
  if (!enablement.enabled || !enablement.config.commitHook) return baseEnv
  try {
    const capability = await resolveGrantedCommitHookCapability(
      cwd,
      enablement.config.commitHook,
      app.getPath('userData'),
      undefined,
      { autoGrant: true }
    )
    if (!capability) return baseEnv
    const recorderCli = packagedRecorderCliPath() ?? baseEnv.SCRY_CLI_PATH
    return {
      ...baseEnv,
      ...capability.env,
      ...(recorderCli ? { SCRY_CLI_PATH: recorderCli } : {}),
      SCRY_RECORDER_MANAGED: '1'
    }
  } catch (error) {
    console.warn('[scry] granted recorder commit hook recovery capability failed:', cwd, error)
    return baseEnv
  }
}

export async function ensureMcpExecutionAuthorized(
  context: ProviderContext,
  operation: McpExecutionOperation,
  targetId?: string
): Promise<McpExecutionSnapshot | null> {
  const build = (): McpExecutionSnapshot => buildMcpExecutionSnapshot({
    providerId: context.providerId,
    cwd: context.cwd,
    homeDir: homeDir,
    settingSources: context.providerId === 'claude' ? process.env.SCRY_CLAUDE_SETTING_SOURCES : undefined,
    env: shellEnv(),
    selectedTargetId: targetId
  })
  const snapshot = build()
  if (snapshot.errors.length > 0) {
    throw new Error(`MCP 配置无法安全执行：${snapshot.errors.join('；')}`)
  }
  const selected = targetId
    ? snapshot.targets.filter((target) => target.targetId === targetId)
    : snapshot.targets.filter((target) => target.enabled)
  if (targetId && selected.length !== 1) throw new Error(`找不到精确 MCP 配置目标：${targetId}`)
  if (selected.length === 0) return operation === 'run' ? null : snapshot

  // 仓库 MCP 默认自动授权全部选中目标；旧的部分授权不会继续限制当前配置。
  // 配置、可执行文件或指纹变化仍会在启动边界重新校验。
  const executionTargetIds = undefined

  const verified = build()
  if (verified.errors.length > 0 || verified.fingerprint !== snapshot.fingerprint) {
    throw new Error('MCP 配置在授权后发生变化，已拒绝执行')
  }
  mcpExecutionTrust.grant(operation, verified, executionTargetIds)
  return executionTargetIds === undefined ? verified : { ...verified, executionTargetIds }
}

export function authorizedMcpExecution(snapshot: McpExecutionSnapshot | null): AuthorizedMcpExecution | undefined {
  if (!snapshot) return undefined
  const verified = buildMcpExecutionSnapshot({
    providerId: snapshot.providerId,
    cwd: snapshot.cwd,
    homeDir: homeDir,
    settingSources: snapshot.settingSources,
    env: shellEnv(),
    selectedTargetId: snapshot.selectedTargetId
  })
  if (verified.errors.length > 0 || verified.fingerprint !== snapshot.fingerprint) {
    throw new Error('MCP 可执行文件或配置在启动边界发生变化，已拒绝执行')
  }
  const executionTargetIds = snapshot.executionTargetIds === undefined
    ? null
    : new Set(snapshot.executionTargetIds)
  return {
    cwd: verified.cwd,
    fingerprint: verified.fingerprint,
    targets: verified.targets
      .filter((target) => executionTargetIds === null || executionTargetIds.has(target.targetId))
      .map(({ targetId, name, enabled, config }) => ({ targetId, name, enabled, config })),
    env: { ...verified.executionEnv }
  }
}
