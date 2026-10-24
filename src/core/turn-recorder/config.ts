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
  storage?: {
    /** Soft quota: maintenance reports pressure but never deletes referenced evidence. */
    maxBytes?: number
    retentionDays?: number
    orphanGraceHours: number
  }
  capture: {
    prompt: boolean
    assistant: boolean
    toolOutput: 'none' | 'summary' | 'full'
    toolContentFieldBytes?: number
    toolContentTurnBytes?: number
    diff: boolean
    hooks: boolean
    patchExcludeBasenames?: string[]
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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : []
}

export function parseRecorderConfig(raw: unknown): RecorderConfig {
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
  const storageRaw = record(root.storage)
  const maxBytes = storageRaw ? boundedStorageInteger(storageRaw.maxBytes, 'storage.maxBytes', 1024 * 1024, 1024 ** 5) : undefined
  const retentionDays = storageRaw ? boundedStorageInteger(storageRaw.retentionDays, 'storage.retentionDays', 1, 36_500) : undefined
  const storage = storageRaw ? {
    ...(maxBytes != null ? { maxBytes } : {}),
    ...(retentionDays != null ? { retentionDays } : {}),
    orphanGraceHours: boundedStorageInteger(storageRaw.orphanGraceHours, 'storage.orphanGraceHours', 1, 8_760) ?? 24
  } : undefined
  const patchExcludeBasenames = [...new Set(stringArray(captureRaw.patchExcludeBasenames).map((item) => item.trim()))]
  if (patchExcludeBasenames.some((item) => item.includes('/') || item.includes('\\'))) {
    throw new Error('capture.patchExcludeBasenames entries must be basenames')
  }
  return {
    schemaVersion: 1,
    enabled: root.enabled !== false,
    workspaceId: root.workspaceId.trim(),
    dataDir,
    ...(commitHook ? { commitHook } : {}),
    repositories: { mode, maxDepth, exclude: stringArray(repositories.exclude) },
    ...(storage ? { storage } : {}),
    capture: resolveCapture(captureRaw, patchExcludeBasenames)
  }
}

/**
 * Capture defaults to on with raw tool bodies; explicit none/summary modes remain supported.
 * A disabled section is recorded as `disabled` with a reason, so the record itself explains what
 * was captured — no separate policy field is needed to reconstruct that later.
 */
function resolveCapture(
  raw: Record<string, unknown>,
  patchExcludeBasenames: string[]
): RecorderConfig['capture'] {
  // Existing workspaces used full-redacted; it now selects full raw capture, not redaction.
  const toolOutput = raw.toolOutput === undefined || raw.toolOutput === 'full-redacted' ? 'full' : raw.toolOutput
  if (toolOutput !== 'none' && toolOutput !== 'summary' && toolOutput !== 'full') {
    throw new Error('capture.toolOutput must be none, summary or full')
  }
  return {
    prompt: raw.prompt !== false,
    assistant: raw.assistant !== false,
    toolOutput,
    ...(toolOutput === 'full' ? {
      toolContentFieldBytes: contentBudget(raw.toolContentFieldBytes, 8 * 1024, 64 * 1024),
      toolContentTurnBytes: contentBudget(raw.toolContentTurnBytes, 128 * 1024, 1024 * 1024)
    } : {}),
    diff: raw.diff !== false,
    hooks: raw.hooks !== false,
    patchExcludeBasenames
  }
}

function boundedStorageInteger(value: unknown, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return Number(value)
}

function contentBudget(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`tool content budget must be an integer between 1 and ${maximum}`)
  }
  return Number(value)
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

export async function hasSymlinkComponent(root: string, relativePath: string): Promise<boolean> {
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
    const config = parseRecorderConfig(JSON.parse(source))
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
