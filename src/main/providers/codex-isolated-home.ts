import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const SHARED_STATE = [
  'AGENTS.md',
  'archived_sessions',
  'auth.json',
  'hooks.json',
  'rules',
  'sessions',
  'skills'
] as const

export interface CodexIsolatedHome {
  path: string
  cleanup: () => void
}

/**
 * Codex merges table overrides with user configuration, so `mcp_servers={}` is not an
 * isolation boundary. Give Scry's app-server a home with only the native state it needs;
 * config.toml and plugins are intentionally absent, so no user MCP can start implicitly.
 */
export function createCodexIsolatedHome(sourceHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')): CodexIsolatedHome {
  const path = mkdtempSync(join(tmpdir(), 'scry-codex-home-'))
  try {
    for (const entry of SHARED_STATE) {
      const source = join(sourceHome, entry)
      if (!existsSync(source)) continue
      const type = lstatSync(source).isDirectory() ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'
      symlinkSync(source, join(path, entry), type)
    }
  } catch (error) {
    rmSync(path, { recursive: true, force: true })
    throw error
  }
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true })
  }
}
