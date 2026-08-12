import { lstat, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

export interface RecorderConfig {
  schemaVersion: 1
  enabled: boolean
  workspaceId: string
  dataDir: string
  commitHook?: RecorderCommitHookConfig
  repositories: {
    mode: 'workspace-only' | 'discover-nested-git'
    maxDepth?: number
    exclude?: string[]
  }
  capture: {
    prompt: boolean
    assistant: boolean
    toolOutput: 'none' | 'summary'
    diff: boolean
    hooks: boolean
  }
}

export interface RecorderCommitHookConfig {
  entry: string
  files: string[]
}

export type RecorderEnablement =
  | { enabled: true; workspaceRoot: string; dataRoot: string; config: RecorderConfig }
  | { enabled: false; reason: 'sentinel' | 'environment' | 'missing_config' | 'config_disabled' | 'invalid_config'; detail?: string }

export type RecorderLocation =
  | { valid: true; workspaceRoot: string; dataRoot: string; config: RecorderConfig }
  | { valid: false; reason: 'missing_config' | 'invalid_config'; detail?: string }

const DEFAULT_CAPTURE: RecorderConfig['capture'] = {
  prompt: true,
  assistant: true,
  toolOutput: 'summary',
  diff: true,
  hooks: true
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : []
}

function parseConfig(raw: unknown): RecorderConfig {
  const root = record(raw)
  if (!root || root.schemaVersion !== 1) throw new Error('scry.config.json requires schemaVersion=1')
  if (typeof root.workspaceId !== 'string' || !root.workspaceId.trim()) throw new Error('workspaceId is required')
  const dataDir = typeof root.dataDir === 'string' && root.dataDir.trim() ? root.dataDir : '.scry'
  const relativeDataDir = relative('.', dataDir)
  if (!relativeDataDir || isAbsolute(dataDir) || relativeDataDir.startsWith('..')) {
    throw new Error('dataDir must be a workspace-relative subdirectory')
  }
  const commitHookRaw = record(root.commitHook)
  const commitHook = commitHookRaw && typeof commitHookRaw.entry === 'string'
    ? {
        entry: commitHookRaw.entry.trim(),
        files: [...new Set(stringArray(commitHookRaw.files).map((item) => item.trim()))]
      }
    : undefined
  if (commitHook) {
    const paths = [commitHook.entry, ...commitHook.files]
    if (
      !commitHook.entry || !commitHook.files.includes(commitHook.entry) ||
      paths.some((path) => !path || isAbsolute(path) || relative('.', path).startsWith('..'))
    ) {
      throw new Error('commitHook requires a workspace-relative entry included in files')
    }
  }
  const repositories = record(root.repositories) ?? {}
  const mode = repositories.mode === 'discover-nested-git' ? 'discover-nested-git' : 'workspace-only'
  const maxDepth = typeof repositories.maxDepth === 'number' && Number.isInteger(repositories.maxDepth)
    ? Math.max(0, Math.min(5, repositories.maxDepth))
    : 2
  const captureRaw = record(root.capture) ?? {}
  return {
    schemaVersion: 1,
    enabled: root.enabled !== false,
    workspaceId: root.workspaceId.trim(),
    dataDir,
    ...(commitHook ? { commitHook } : {}),
    repositories: { mode, maxDepth, exclude: stringArray(repositories.exclude) },
    capture: {
      prompt: captureRaw.prompt !== false,
      assistant: captureRaw.assistant !== false,
      toolOutput: captureRaw.toolOutput === 'none' ? 'none' : DEFAULT_CAPTURE.toolOutput,
      diff: captureRaw.diff !== false,
      hooks: captureRaw.hooks !== false
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function hasSymlinkComponent(root: string, relativePath: string): Promise<boolean> {
  let cursor = root
  for (const part of relativePath.split(/[\\/]+/).filter((value) => value && value !== '.')) {
    cursor = join(cursor, part)
    try {
      if ((await lstat(cursor)).isSymbolicLink()) return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  return false
}

export async function resolveRecorderLocation(workspace: string): Promise<RecorderLocation> {
  const workspaceRoot = resolve(workspace)
  const configPath = join(workspaceRoot, 'scry.config.json')
  let source: string
  try {
    source = await readFile(configPath, 'utf8')
  } catch {
    return { valid: false, reason: 'missing_config' }
  }
  try {
    const config = parseConfig(JSON.parse(source))
    const dataRoot = resolve(workspaceRoot, config.dataDir)
    if (relative(workspaceRoot, dataRoot).startsWith('..')) {
      return { valid: false, reason: 'invalid_config', detail: 'dataDir escapes workspace' }
    }
    if (await hasSymlinkComponent(workspaceRoot, config.dataDir)) {
      return { valid: false, reason: 'invalid_config', detail: 'dataDir must not traverse a symbolic link' }
    }
    return { valid: true, workspaceRoot, dataRoot, config }
  } catch (error) {
    return { valid: false, reason: 'invalid_config', detail: error instanceof Error ? error.message : String(error) }
  }
}

export async function resolveRecorderEnablement(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<RecorderEnablement> {
  const workspaceRoot = resolve(workspace)
  if (await exists(join(workspaceRoot, '.scry-disabled'))) return { enabled: false, reason: 'sentinel' }
  if (env.SCRY_RECORDER_ENABLED === '0') return { enabled: false, reason: 'environment' }
  const location = await resolveRecorderLocation(workspaceRoot)
  if (!location.valid) return { enabled: false, reason: location.reason, detail: location.detail }
  if (!location.config.enabled) return { enabled: false, reason: 'config_disabled' }
  return { enabled: true, workspaceRoot: location.workspaceRoot, dataRoot: location.dataRoot, config: location.config }
}

async function isGitRepository(path: string): Promise<boolean> {
  return exists(join(path, '.git'))
}

export async function discoverRepositories(root: string, config: RecorderConfig): Promise<string[]> {
  const repositories = new Set<string>()
  if (await isGitRepository(root)) repositories.add(root)
  if (config.repositories.mode !== 'discover-nested-git') return [...repositories]
  const excluded = new Set(['.git', '.scry', 'node_modules', 'target', 'dist', 'build', ...(config.repositories.exclude ?? [])])
  const maxDepth = config.repositories.maxDepth ?? 2
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink() || excluded.has(entry.name)) return
      const child = join(dir, entry.name)
      if (await isGitRepository(child)) {
        repositories.add(child)
        return
      }
      await walk(child, depth + 1)
    }))
  }
  await walk(root, 1)
  return [...repositories].sort()
}
