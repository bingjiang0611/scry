import { type InitProvider, PROVIDERS, HANDLER_ID, openCodePluginSource, CONFIG_PATHS, mergeProviderSettings, providerHookSource } from './workspace-hook-sources.js'
import { join, basename, resolve, dirname } from 'node:path'
import { detectWorkspaceProviders } from './workspace-provider-detection.js'
import { realpath, mkdir, chmod } from 'node:fs/promises'
import { execFileAsync, executable, readOptional, gitExcludePath, writeAtomic } from './workspace-files.js'
import { resolveRecorderLocation } from '../core/turn-recorder/config.js'

export type { InitProvider } from './workspace-hook-sources.js'
export { detectWorkspaceProviders } from './workspace-provider-detection.js'
export { providerHookInstalled } from './workspace-provider-detection.js'
export { providerHookScriptState } from './workspace-provider-detection.js'
export type { ProviderIntegrationDiff } from './workspace-integrations.js'
export type { ArtifactDiff } from './workspace-integrations.js'
export type { IntegrationsDiffResult } from './workspace-integrations.js'
export { integrationsDiff } from './workspace-integrations.js'
export type { IntegrationsUninstallResult } from './workspace-integrations.js'
export { integrationsUninstall } from './workspace-integrations.js'
export type { IntegrationsRepairResult } from './workspace-integrations.js'
export { integrationsRepair } from './workspace-integrations.js'

export interface WorkspaceInitOptions {
  workspace: string
  providers?: string
  cliPath: string
  nodePath?: string
  env?: NodeJS.ProcessEnv
}

export interface WorkspaceInitResult {
  workspace: string
  providers: InitProvider[]
  changedFiles: string[]
  unchangedFiles: string[]
  codexTrustRequired: boolean
}

function parseProviders(source: string): InitProvider[] {
  const result: InitProvider[] = []
  for (const value of source.split(/[\s,]+/).filter(Boolean)) {
    if (!PROVIDERS.includes(value as InitProvider)) {
      throw new Error(`暂不支持 Provider：${value}（当前支持 ${PROVIDERS.join('、')}；Pi 请使用 scry integrations install-pi）`)
    }
    if (!result.includes(value as InitProvider)) result.push(value as InitProvider)
  }
  if (result.length === 0) throw new Error('--providers 不能为空')
  return result
}

async function detectProviders(workspace: string, env: NodeJS.ProcessEnv): Promise<InitProvider[]> {
  const providers = await detectWorkspaceProviders(workspace, env)
  if (providers.length === 0) {
    throw new Error(`没有检测到 Provider；请显式指定，例如：scry init --providers claude,codex`)
  }
  return providers
}

async function exactGitRoot(workspace: string): Promise<string> {
  let canonical: string
  try {
    canonical = await realpath(workspace)
  } catch {
    throw new Error(`目录不存在：${workspace}`)
  }
  let root: string
  try {
    const result = await execFileAsync('git', ['-C', canonical, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })
    root = await realpath(result.stdout.trim())
  } catch {
    throw new Error(`当前目录不是 Git 项目根目录：${canonical}`)
  }
  if (canonical !== root) throw new Error(`请在 Git 项目根目录执行：${root}`)
  return root
}

function workspaceId(workspace: string): string {
  return basename(workspace).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'
}

function defaultConfig(workspace: string): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: workspaceId(workspace),
    dataDir: '.scry',
    repositories: { mode: 'discover-nested-git', maxDepth: 2 },
    capture: { prompt: true, assistant: true, toolOutput: 'full', diff: true, hooks: true }
  }, null, 2)}\n`
}

function mergeExclude(source: string | null): string {
  const lines = source?.split(/\r?\n/) ?? []
  for (const entry of ['.scry/', '.scry-disabled']) {
    if (!lines.includes(entry)) lines.push(entry)
  }
  return `${lines.filter((line, index) => line || index < lines.length - 1).join('\n').replace(/\n+$/, '')}\n`
}

export async function initWorkspace(options: WorkspaceInitOptions): Promise<WorkspaceInitResult> {
  const env = options.env ?? process.env
  const workspace = await exactGitRoot(resolve(options.workspace))
  const providers = options.providers ? parseProviders(options.providers) : await detectProviders(workspace, env)
  const cliPath = await realpath(options.cliPath).catch(() => options.cliPath)
  if (!await executable(cliPath)) throw new Error(`Scry CLI 不可执行：${cliPath}`)
  const nodePath = await realpath(options.nodePath ?? process.execPath).catch(() => options.nodePath ?? process.execPath)

  const planned = new Map<string, { source: string; mode?: number }>()
  const configPath = join(workspace, 'scry.config.json')
  const existingConfig = await readOptional(configPath)
  if (existingConfig == null) {
    planned.set(configPath, { source: defaultConfig(workspace) })
  } else {
    const location = await resolveRecorderLocation(workspace)
    if (!location.valid) throw new Error(`${configPath} 无效：${location.detail ?? location.reason}`)
  }

  for (const provider of providers) {
    if (provider === 'opencode') {
      const path = join(workspace, '.opencode/plugins/scry-recorder.js')
      const current = await readOptional(path)
      if (current != null && !current.includes(`SCRY_HANDLER_ID=${HANDLER_ID}`)) {
        throw new Error(`${path} 已存在且不由 Scry 管理，请先改名或移除`)
      }
      planned.set(path, { source: openCodePluginSource() })
      continue
    }
    const path = join(workspace, CONFIG_PATHS[provider])
    planned.set(path, { source: mergeProviderSettings(await readOptional(path), path, provider) })
  }

  planned.set(join(workspace, '.scry/cli-path'), { source: `${cliPath}\n` })
  planned.set(join(workspace, '.scry/node-bin-dir'), { source: `${dirname(nodePath)}\n` })
  planned.set(join(workspace, '.scry/provider-hook.sh'), { source: providerHookSource(), mode: 0o700 })
  const excludePath = await gitExcludePath(workspace)
  planned.set(excludePath, { source: mergeExclude(await readOptional(excludePath)) })

  const changedFiles: string[] = []
  const unchangedFiles: string[] = []
  await mkdir(join(workspace, '.scry'), { recursive: true, mode: 0o700 })
  await chmod(join(workspace, '.scry'), 0o700)
  for (const [path, value] of planned) {
    const changed = await writeAtomic(path, value.source, value.mode)
    ;(changed ? changedFiles : unchangedFiles).push(path)
  }

  return {
    workspace,
    providers,
    changedFiles,
    unchangedFiles,
    codexTrustRequired: providers.includes('codex')
  }
}
