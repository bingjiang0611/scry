import { type InitProvider, HANDLER_ID, CONFIG_PATHS, providerEvents, PROVIDERS, EVENTS, openCodePluginSource, mergeProviderSettings, providerHookSource } from './workspace-hook-sources.js'
import { object, readOptional, exists, gitExcludePath, writeAtomic, executable } from './workspace-files.js'
import { join, resolve, dirname } from 'node:path'
import { providerHookScriptState } from './workspace-provider-detection.js'
import { piIntegrationStatus } from './pi-integration.js'
import { stat, rm, realpath, mkdir } from 'node:fs/promises'


export interface ProviderIntegrationDiff {
  provider: InitProvider
  path: string
  present: boolean
  /** Lifecycle events that carry a managed entry, identified by handler id. */
  managedEvents: string[]
  missingEvents: string[]
  /** Events whose managed entry appears more than once (drift from command reshapes). */
  duplicateEvents: string[]
  /** Entries written by someone else; uninstall must preserve them. */
  foreignEntries: number
  detail?: string
}

export interface ArtifactDiff {
  path: string
  kind: 'opencode-plugin' | 'hook-script' | 'cli-path' | 'node-bin-dir' | 'git-exclude' | 'config' | 'records'
  status: 'managed' | 'current' | 'outdated' | 'present' | 'absent' | 'unmanaged'
  detail?: string
}

export interface IntegrationsDiffResult {
  workspace: string
  providers: ProviderIntegrationDiff[]
  artifacts: ArtifactDiff[]
  pi: { installed: boolean; scope: 'user-global'; detail: string }
}

export function managedCommand(value: unknown): boolean {
  const entry = object(value)
  return typeof entry?.command === 'string' && entry.command.includes(`SCRY_HANDLER_ID=${HANDLER_ID}`)
}

export async function providerDiff(workspace: string, provider: Exclude<InitProvider, 'opencode'>): Promise<ProviderIntegrationDiff> {
  const path = join(workspace, CONFIG_PATHS[provider])
  const source = await readOptional(path)
  if (source == null) {
    return {
      provider,
      path,
      present: false,
      managedEvents: [],
      missingEvents: [...providerEvents(provider)],
      duplicateEvents: [],
      foreignEntries: 0
    }
  }
  let hooks: Record<string, unknown> | null
  try {
    hooks = object(object(JSON.parse(source))?.hooks)
  } catch (error) {
    return {
      provider,
      path,
      present: true,
      managedEvents: [],
      missingEvents: [...providerEvents(provider)],
      duplicateEvents: [],
      foreignEntries: 0,
      detail: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
    }
  }
  const managedEvents: string[] = []
  const duplicateEvents: string[] = []
  let foreignEntries = 0
  for (const event of providerEvents(provider)) {
    const groups = hooks?.[event]
    if (!Array.isArray(groups)) continue
    let managed = 0
    for (const group of groups) {
      const entries = object(group)?.hooks
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        if (managedCommand(entry)) managed++
        else foreignEntries++
      }
    }
    if (managed > 0) managedEvents.push(event)
    if (managed > 1) duplicateEvents.push(event)
  }
  return {
    provider,
    path,
    present: true,
    managedEvents,
    missingEvents: providerEvents(provider).filter((event) => !managedEvents.includes(event)),
    duplicateEvents,
    foreignEntries
  }
}

export async function integrationsDiff(workspace: string, env: NodeJS.ProcessEnv = process.env): Promise<IntegrationsDiffResult> {
  const root = resolve(workspace)
  const providers: ProviderIntegrationDiff[] = []
  for (const provider of PROVIDERS) {
    if (provider === 'opencode') continue
    providers.push(await providerDiff(root, provider))
  }
  const pluginPath = join(root, '.opencode/plugins/scry-recorder.js')
  const plugin = await readOptional(pluginPath)
  providers.push({
    provider: 'opencode',
    path: pluginPath,
    present: plugin != null,
    managedEvents: plugin?.includes(`SCRY_HANDLER_ID=${HANDLER_ID}`) ? [...EVENTS] : [],
    missingEvents: plugin?.includes(`SCRY_HANDLER_ID=${HANDLER_ID}`) ? [] : [...EVENTS],
    duplicateEvents: [],
    foreignEntries: plugin != null && !plugin.includes(`SCRY_HANDLER_ID=${HANDLER_ID}`) ? 1 : 0,
    ...(plugin != null && !plugin.includes(`SCRY_HANDLER_ID=${HANDLER_ID}`)
      ? { detail: '插件已存在但不由 Scry 管理' }
      : {})
  })

  const artifacts: ArtifactDiff[] = []
  const hookScript = join(root, '.scry/provider-hook.sh')
  artifacts.push({
    path: hookScript,
    kind: 'hook-script',
    status: await providerHookScriptState(root)
  })
  for (const [relative, kind] of [['.scry/cli-path', 'cli-path'], ['.scry/node-bin-dir', 'node-bin-dir']] as const) {
    artifacts.push({
      path: join(root, relative),
      kind,
      status: await exists(join(root, relative)) ? 'managed' : 'absent'
    })
  }
  artifacts.push({
    path: join(root, 'scry.config.json'),
    kind: 'config',
    status: await exists(join(root, 'scry.config.json')) ? 'present' : 'absent',
    detail: 'uninstall 保留；删除后 recorder 会 fail closed'
  })
  artifacts.push({
    path: join(root, '.scry/records'),
    kind: 'records',
    status: await exists(join(root, '.scry/records')) ? 'present' : 'absent',
    detail: 'uninstall 保留；轮次记录属于你，不要手删单个文件（会制造 sequence gap）'
  })
  const excludePath = await gitExcludePath(root).catch(() => null)
  if (excludePath) {
    const exclude = await readOptional(excludePath)
    artifacts.push({
      path: excludePath,
      kind: 'git-exclude',
      status: exclude?.includes('.scry/') ? 'managed' : 'absent',
      detail: 'uninstall 保留：记录仍在仓库内，移除忽略会导致误提交'
    })
  }
  const pi = await piIntegrationStatus({ home: env.HOME }).catch(() => null)
  return {
    workspace: root,
    providers,
    artifacts,
    pi: {
      installed: pi?.installed === true,
      scope: 'user-global',
      detail: 'Pi 集成是用户级扩展，不属于本 workspace；需单独处理'
    }
  }
}

export interface IntegrationsUninstallResult {
  workspace: string
  rewritten: string[]
  removed: string[]
  retained: Array<{ path: string; reason: string }>
  skipped: Array<{ path: string; reason: string }>
}

/**
 * Remove only entries carrying our handler id. Foreign hooks in the same group survive, and a
 * group is dropped solely when it becomes empty. Records, config and the Git exclude entry are
 * retained on purpose and reported, so uninstall never silently discards a team's evidence.
 */
export async function integrationsUninstall(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<IntegrationsUninstallResult> {
  const root = resolve(workspace)
  const rewritten: string[] = []
  const removed: string[] = []
  const retained: Array<{ path: string; reason: string }> = []
  const skipped: Array<{ path: string; reason: string }> = []

  for (const provider of PROVIDERS) {
    if (provider === 'opencode') continue
    const path = join(root, CONFIG_PATHS[provider])
    const source = await readOptional(path)
    if (source == null) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch {
      skipped.push({ path, reason: '不是合法 JSON，未修改' })
      continue
    }
    const settings = object(parsed)
    const hooks = object(settings?.hooks)
    if (!settings || !hooks) continue
    let changed = false
    for (const event of providerEvents(provider)) {
      const groups = hooks[event]
      if (!Array.isArray(groups)) continue
      const keptGroups: unknown[] = []
      for (const group of groups) {
        const record = object(group)
        const entries = record?.hooks
        if (!Array.isArray(entries)) {
          keptGroups.push(group)
          continue
        }
        const keptEntries = entries.filter((entry) => !managedCommand(entry))
        if (keptEntries.length !== entries.length) changed = true
        if (keptEntries.length === 0) continue
        keptGroups.push(keptEntries.length === entries.length ? group : { ...record, hooks: keptEntries })
      }
      if (keptGroups.length === 0) delete hooks[event]
      else hooks[event] = keptGroups
    }
    if (Object.keys(hooks).length === 0) delete settings.hooks
    if (!changed) continue
    const mode = await stat(path).then((info) => info.mode & 0o777).catch(() => 0o600)
    await writeAtomic(path, `${JSON.stringify(settings, null, 2)}\n`, mode)
    rewritten.push(path)
  }

  const pluginPath = join(root, '.opencode/plugins/scry-recorder.js')
  const plugin = await readOptional(pluginPath)
  if (plugin != null) {
    if (plugin.includes(`SCRY_HANDLER_ID=${HANDLER_ID}`)) {
      await rm(pluginPath, { force: true })
      removed.push(pluginPath)
    } else {
      skipped.push({ path: pluginPath, reason: '不由 Scry 管理，未删除' })
    }
  }

  for (const relative of ['.scry/provider-hook.sh', '.scry/cli-path', '.scry/node-bin-dir']) {
    const path = join(root, relative)
    if (!await exists(path)) continue
    await rm(path, { force: true })
    removed.push(path)
  }

  if (await exists(join(root, '.scry/records'))) {
    retained.push({ path: join(root, '.scry/records'), reason: '轮次记录归你所有，不自动删除' })
  }
  if (await exists(join(root, 'scry.config.json'))) {
    retained.push({ path: join(root, 'scry.config.json'), reason: '保留以便重新 init；删除后 recorder fail closed' })
  }
  const excludePath = await gitExcludePath(root).catch(() => null)
  if (excludePath && (await readOptional(excludePath))?.includes('.scry/')) {
    retained.push({ path: excludePath, reason: '保留 .scry/ 忽略，避免记录被误提交' })
  }
  const pi = await piIntegrationStatus({ home: env.HOME }).catch(() => null)
  if (pi?.installed) {
    retained.push({ path: pi.target, reason: 'Pi 用户级扩展，不属于本 workspace；需手动移除' })
  }
  return { workspace: root, rewritten, removed, retained, skipped }
}

export interface IntegrationsRepairResult {
  workspace: string
  providers: InitProvider[]
  rewritten: string[]
  unchanged: string[]
}

/**
 * Re-apply managed hooks for providers that are already installed. Managed entries are stripped
 * by handler id and rewritten in canonical form, which repairs duplicates left by an earlier
 * command reshape; foreign hooks and providers that were never installed are left alone.
 */
export async function integrationsRepair(options: {
  workspace: string
  cliPath: string
  nodePath?: string
  env?: NodeJS.ProcessEnv
}): Promise<IntegrationsRepairResult> {
  const env = options.env ?? process.env
  const root = resolve(options.workspace)
  const cliPath = await realpath(options.cliPath).catch(() => options.cliPath)
  if (!await executable(cliPath)) throw new Error(`Scry CLI 不可执行：${cliPath}`)
  const nodePath = await realpath(options.nodePath ?? process.execPath).catch(() => options.nodePath ?? process.execPath)

  const diff = await integrationsDiff(root, env)
  const installed = diff.providers
    .filter((row) => row.present && row.managedEvents.length > 0)
    .map((row) => row.provider)
  if (installed.length === 0) {
    return { workspace: root, providers: [], rewritten: [], unchanged: [] }
  }

  const planned = new Map<string, { source: string; mode?: number }>()
  for (const provider of installed) {
    if (provider === 'opencode') {
      planned.set(join(root, '.opencode/plugins/scry-recorder.js'), { source: openCodePluginSource() })
      continue
    }
    const path = join(root, CONFIG_PATHS[provider])
    const stripped = stripManagedHooks(await readOptional(path), path, provider)
    planned.set(path, { source: mergeProviderSettings(stripped, path, provider) })
  }
  planned.set(join(root, '.scry/cli-path'), { source: `${cliPath}\n` })
  planned.set(join(root, '.scry/node-bin-dir'), { source: `${dirname(nodePath)}\n` })
  planned.set(join(root, '.scry/provider-hook.sh'), { source: providerHookSource(), mode: 0o700 })

  const rewritten: string[] = []
  const unchanged: string[] = []
  await mkdir(join(root, '.scry'), { recursive: true, mode: 0o700 })
  for (const [path, value] of planned) {
    const mode = value.mode ?? await stat(path).then((info) => info.mode & 0o777).catch(() => 0o600)
    ;(await writeAtomic(path, value.source, mode) ? rewritten : unchanged).push(path)
  }
  return { workspace: root, providers: installed, rewritten, unchanged }
}

/** Drop every managed entry so the canonical merge cannot append a duplicate. */
export function stripManagedHooks(source: string | null, path: string, provider: Exclude<InitProvider, 'opencode'>): string | null {
  if (source == null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new Error(`${path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  const settings = object(parsed)
  const hooks = object(settings?.hooks)
  if (!settings || !hooks) return source
  for (const event of providerEvents(provider)) {
    const groups = hooks[event]
    if (!Array.isArray(groups)) continue
    const kept: unknown[] = []
    for (const group of groups) {
      const record = object(group)
      const entries = record?.hooks
      if (!Array.isArray(entries)) {
        kept.push(group)
        continue
      }
      const keptEntries = entries.filter((entry) => !managedCommand(entry))
      if (keptEntries.length > 0) kept.push(keptEntries.length === entries.length ? group : { ...record, hooks: keptEntries })
    }
    if (kept.length === 0) delete hooks[event]
    else hooks[event] = kept
  }
  return `${JSON.stringify(settings, null, 2)}\n`
}
