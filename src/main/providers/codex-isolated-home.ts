import { randomUUID } from 'node:crypto'
import {
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const SHARED_STATE = [
  'AGENTS.md',
  'auth.json',
  'hooks.json',
  'rules',
  'skills'
] as const

const EXCLUDED_STATE = ['config.toml', 'plugins'] as const
const LOCAL_STATE = ['archived_sessions', 'sessions'] as const
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROLLOUT_THREAD_ID = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

export interface CodexIsolatedHome {
  path: string
  cleanup: () => void
}

const existingType = (path: string) => {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function ensureLocalDirectory(path: string): void {
  const state = existingType(path)
  if (state && (!state.isDirectory() || state.isSymbolicLink())) {
    throw new Error(`Codex isolated home state must be a local directory: ${path}`)
  }
  mkdirSync(path, { recursive: true, mode: 0o700 })
}

function copyOnce(source: string, target: string): void {
  const current = existingType(target)
  if (current) {
    if (!current.isFile() || current.isSymbolicLink()) {
      throw new Error(`Codex isolated home rollout must be a local file: ${target}`)
    }
    return
  }
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    copyFileSync(source, temporary, constants.COPYFILE_EXCL)
    try {
      linkSync(temporary, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } finally {
    try { unlinkSync(temporary) } catch { /* copy may have failed before creating it */ }
  }
}

const containsPath = (root: string, candidate: string): boolean => {
  const child = relative(root, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function removeAlreadyMigrated(targetHome: string, wanted: Set<string>): void {
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (wanted.size === 0) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) {
        const threadId = ROLLOUT_THREAD_ID.exec(entry.name)?.[1]?.toLowerCase()
        if (threadId) wanted.delete(threadId)
      }
    }
  }
  for (const stateRoot of LOCAL_STATE) {
    if (wanted.size === 0) return
    visit(join(targetHome, stateRoot))
  }
}

function migrateLegacyRollouts(sourceHome: string, targetHome: string, sessionIds: readonly string[]): void {
  const wanted = new Set(sessionIds.filter((id) => THREAD_ID.test(id)).map((id) => id.toLowerCase()))
  if (wanted.size === 0) return
  removeAlreadyMigrated(targetHome, wanted)
  if (wanted.size === 0) return
  for (const stateRoot of LOCAL_STATE) {
    if (wanted.size === 0) return
    const sourceRoot = join(sourceHome, stateRoot)
    const sourceState = existingType(sourceRoot)
    if (!sourceState?.isDirectory() || sourceState.isSymbolicLink()) continue
    const visit = (sourceDir: string): void => {
      for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
        if (wanted.size === 0) return
        const source = join(sourceDir, entry.name)
        if (entry.isDirectory()) {
          visit(source)
          continue
        }
        if (!entry.isFile()) continue
        const threadId = ROLLOUT_THREAD_ID.exec(entry.name)?.[1]?.toLowerCase()
        if (!threadId || !wanted.has(threadId)) continue
        const subdir = relative(sourceRoot, sourceDir)
        const parts = subdir ? subdir.split(/[\\/]/) : []
        if (stateRoot === 'sessions' && (
          parts.length !== 3 || !/^\d{4}$/.test(parts[0]) || !parts.slice(1).every((part) => /^\d{2}$/.test(part))
        )) continue
        if (stateRoot === 'archived_sessions' && parts.length !== 0) continue
        let targetDir = join(targetHome, stateRoot)
        for (const part of parts) {
          targetDir = join(targetDir, part)
          ensureLocalDirectory(targetDir)
        }
        copyOnce(source, join(targetDir, entry.name))
        wanted.delete(threadId)
      }
    }
    visit(sourceRoot)
  }
}

/**
 * Codex merges table overrides with user configuration, so `mcp_servers={}` is not an
 * isolation boundary. Give Scry's app-server a home with only the native state it needs;
 * config.toml and plugins are intentionally absent, so no user MCP can start implicitly.
 */
export function createCodexIsolatedHome(
  sourceHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'),
  persistentPath?: string,
  legacySessionIds: readonly string[] = []
): CodexIsolatedHome {
  const path = persistentPath ?? mkdtempSync(join(tmpdir(), 'scry-codex-home-'))
  const temporary = persistentPath == null
  try {
    const existingRoot = existingType(path)
    if (existingRoot && (!existingRoot.isDirectory() || existingRoot.isSymbolicLink())) {
      throw new Error('Codex isolated home must be a local directory, not a symlink')
    }
    mkdirSync(path, { recursive: true, mode: 0o700 })
    const sourceIdentity = existingType(sourceHome) ? realpathSync(sourceHome) : resolve(sourceHome)
    const targetIdentity = realpathSync(path)
    if (containsPath(sourceIdentity, targetIdentity) || containsPath(targetIdentity, sourceIdentity)) {
      throw new Error('Codex isolated home and native CODEX_HOME must not overlap')
    }
    for (const entry of LOCAL_STATE) {
      const state = existingType(join(path, entry))
      if (state && (!state.isDirectory() || state.isSymbolicLink())) {
        throw new Error(`Codex isolated home ${entry} must be a local directory`)
      }
    }
    for (const entry of [...SHARED_STATE, ...EXCLUDED_STATE]) {
      rmSync(join(path, entry), { recursive: true, force: true })
    }
    for (const entry of SHARED_STATE) {
      const source = join(sourceHome, entry)
      if (!existsSync(source)) continue
      const canonicalSource = realpathSync(source)
      const type = lstatSync(canonicalSource).isDirectory() ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'
      symlinkSync(canonicalSource, join(path, entry), type)
    }
    for (const entry of LOCAL_STATE) ensureLocalDirectory(join(path, entry))
    if (!temporary) migrateLegacyRollouts(sourceHome, path, legacySessionIds)
  } catch (error) {
    if (temporary) rmSync(path, { recursive: true, force: true })
    throw error
  }
  return {
    path,
    cleanup: () => {
      if (temporary) rmSync(path, { recursive: true, force: true })
    }
  }
}
