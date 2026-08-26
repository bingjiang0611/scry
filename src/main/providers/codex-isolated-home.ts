import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync
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

const containsPath = (root: string, candidate: string): boolean => {
  const child = relative(root, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

/**
 * Codex merges table overrides with user configuration, so `mcp_servers={}` is not an
 * isolation boundary. Give Scry's app-server a home with only the native state it needs;
 * config.toml and plugins are intentionally absent, so no user MCP can start implicitly.
 */
export function createCodexIsolatedHome(
  sourceHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'),
  persistentPath?: string
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
