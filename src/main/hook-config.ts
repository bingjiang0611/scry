import { readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { HookConfiguredCommand, TraceEvent } from '../shared/trace'

type SettingSource = 'user' | 'project' | 'local'

interface HookRule {
  matcher?: unknown
  hooks?: unknown
}

interface LoadedSettings {
  source: SettingSource
  path: string
  value: Record<string, unknown>
}

interface InstalledPlugin {
  scope?: unknown
  installPath?: unknown
}

interface ConfiguredRule extends HookConfiguredCommand {
  event: string
}

export interface ClaudeHookConfig {
  rules: ConfiguredRule[]
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function enabledSettingSources(): Set<SettingSource> {
  const configured = process.env.SCRY_CLAUDE_SETTING_SOURCES?.trim()
  if (!configured) return new Set(['user', 'project', 'local'])
  const allowed = new Set<SettingSource>(['user', 'project', 'local'])
  return new Set(
    configured
      .split(',')
      .map((source) => source.trim())
      .filter((source): source is SettingSource => allowed.has(source as SettingSource))
  )
}

function matcherMatches(matcher: string | undefined, subject: string): boolean {
  if (!matcher) return true
  try {
    return new RegExp(matcher).test(subject)
  } catch {
    return matcher === subject
  }
}

function hookSubject(event: TraceEvent): string {
  const trigger = event.hookName ?? event.tool ?? ''
  const prefix = `${event.hookEvent ?? event.name ?? ''}:`
  return trigger.startsWith(prefix) ? trigger.slice(prefix.length) : trigger
}

function addHookRules(
  root: Record<string, unknown>,
  source: HookConfiguredCommand['source'],
  sourcePath: string,
  result: ConfiguredRule[],
  seen: Set<string>,
  pluginId?: string,
  pluginRoot?: string
): void {
  const hooks = (isRecord(root.hooks) ? root.hooks : root) as Record<string, unknown>
  for (const [event, rawRules] of Object.entries(hooks)) {
    if (!Array.isArray(rawRules)) continue
    for (const rawRule of rawRules) {
      if (!isRecord(rawRule)) continue
      const rule = rawRule as HookRule
      const matcher = typeof rule.matcher === 'string' ? rule.matcher : undefined
      if (!Array.isArray(rule.hooks)) continue
      for (const rawHook of rule.hooks) {
        if (!isRecord(rawHook)) continue
        if (rawHook.type !== 'command' || typeof rawHook.command !== 'string' || !rawHook.command.trim()) continue
        const command = pluginRoot
          ? rawHook.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT\b/g, pluginRoot)
          : rawHook.command
        const timeoutSeconds =
          typeof rawHook.timeout === 'number' && Number.isFinite(rawHook.timeout) && rawHook.timeout > 0
            ? rawHook.timeout
            : undefined
        const key = `${event}\0${matcher ?? ''}\0${command}`
        if (seen.has(key)) continue
        seen.add(key)
        result.push({
          event,
          command,
          source,
          sourcePath,
          matcher,
          pluginId,
          ...(timeoutSeconds != null ? { timeoutSeconds } : {})
        })
      }
    }
  }
}

function pluginHookPaths(manifest: Record<string, unknown> | null): unknown[] {
  const configured = manifest?.hooks
  if (configured == null) return ['hooks/hooks.json']
  return Array.isArray(configured) ? configured : [configured]
}

function safePluginPath(pluginRoot: string, configuredPath: string): string | null {
  if (isAbsolute(configuredPath)) return null
  const root = resolve(pluginRoot)
  const candidate = resolve(root, configuredPath)
  const rel = relative(root, candidate)
  return rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)
    ? null
    : candidate
}

function installedPluginPath(
  pluginId: string,
  enabledAt: SettingSource,
  registry: Record<string, unknown> | null
): string | null {
  const plugins = registry?.plugins
  if (!isRecord(plugins)) return null
  const installs = plugins[pluginId]
  if (!Array.isArray(installs)) return null
  const valid = installs.filter((entry): entry is InstalledPlugin => isRecord(entry) && typeof entry.installPath === 'string')
  const selected = valid.find((entry) => entry.scope === enabledAt) ?? valid.find((entry) => entry.scope === 'user') ?? valid[0]
  return typeof selected?.installPath === 'string' ? selected.installPath : null
}

function addPluginRules(
  pluginId: string,
  enabledAt: SettingSource,
  result: ConfiguredRule[],
  seen: Set<string>,
  registry: Record<string, unknown> | null
): void {
  const pluginRoot = installedPluginPath(pluginId, enabledAt, registry)
  if (!pluginRoot) return
  const manifestPath = join(pluginRoot, '.claude-plugin', 'plugin.json')
  const manifest = readJson(manifestPath)
  for (const configured of pluginHookPaths(manifest)) {
    if (typeof configured === 'string') {
      const hookPath = safePluginPath(pluginRoot, configured)
      if (!hookPath) continue
      const hookConfig = readJson(hookPath)
      if (hookConfig) addHookRules(hookConfig, 'plugin', hookPath, result, seen, pluginId, pluginRoot)
    } else if (isRecord(configured)) {
      addHookRules(configured, 'plugin', manifestPath, result, seen, pluginId, pluginRoot)
    }
  }
}

export function loadClaudeHookConfig(
  cwd: string,
  homeDir: string
): ClaudeHookConfig {
  const sources = enabledSettingSources()
  const files: Array<{ source: SettingSource; path: string }> = [
    { source: 'user', path: join(homeDir, '.claude', 'settings.json') },
    { source: 'project', path: join(cwd, '.claude', 'settings.json') },
    { source: 'local', path: join(cwd, '.claude', 'settings.local.json') }
  ]
  const result: ConfiguredRule[] = []
  const seen = new Set<string>()
  const loaded: LoadedSettings[] = []
  for (const file of files) {
    if (!sources.has(file.source)) continue
    const settings = readJson(file.path)
    if (!settings) continue
    loaded.push({ ...file, value: settings })
    if (isRecord(settings.hooks)) addHookRules({ hooks: settings.hooks }, file.source, file.path, result, seen)
  }

  const enabledPlugins = new Map<string, { enabled: boolean; source: SettingSource }>()
  for (const settings of loaded) {
    if (!isRecord(settings.value.enabledPlugins)) continue
    for (const [pluginId, enabled] of Object.entries(settings.value.enabledPlugins)) {
      if (typeof enabled === 'boolean') enabledPlugins.set(pluginId, { enabled, source: settings.source })
    }
  }
  const registry = readJson(join(homeDir, '.claude', 'plugins', 'installed_plugins.json'))
  for (const [pluginId, state] of enabledPlugins) {
    if (state.enabled) addPluginRules(pluginId, state.source, result, seen, registry)
  }
  return { rules: result }
}

export function loadCodexHookConfig(cwd: string, homeDir: string): ClaudeHookConfig {
  const files: Array<{ source: HookConfiguredCommand['source']; path: string }> = [
    { source: 'user', path: join(homeDir, '.codex', 'hooks.json') },
    { source: 'project', path: join(cwd, '.codex', 'hooks.json') }
  ]
  const result: ConfiguredRule[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const settings = readJson(file.path)
    if (settings) addHookRules(settings, file.source, file.path, result, seen)
  }
  return { rules: result }
}

export function configuredHookCommands(event: TraceEvent, config: ClaudeHookConfig): HookConfiguredCommand[] {
  if (event.kind !== 'hook') return []
  const hookEvent = event.hookEvent ?? event.name
  if (!hookEvent) return []
  const subject = hookSubject(event)
  const seen = new Set<string>()
  return config.rules
    .filter((rule) => rule.event === hookEvent && matcherMatches(rule.matcher, subject))
    .filter((rule) => {
      if (seen.has(rule.command)) return false
      seen.add(rule.command)
      return true
    })
    .map(({ event: _event, ...command }) => command)
}

export function attachConfiguredHookCommands(event: TraceEvent, config: ClaudeHookConfig): TraceEvent {
  if (event.kind !== 'hook' || event.hookConfiguredCommands?.length) return event
  const commands = configuredHookCommands(event, config)
  return commands.length > 0 ? { ...event, hookConfiguredCommands: commands } : event
}
