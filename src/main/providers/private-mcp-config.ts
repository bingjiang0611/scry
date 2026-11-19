import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { lstat, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIRECTORY_PREFIX = 'scry-mcp-config-'
const DIRECTORY_NAME = /^scry-mcp-config-(\d+)-[A-Za-z0-9]{6}$/

export interface PrivateMcpConfig {
  /** Passed to the SDK's `extraArgs`; the CLI reads the servers from this path. */
  extraArgs: { 'mcp-config': string }
  /** Idempotent. A leftover from a crash is removed by the next startup sweep. */
  dispose(): void
}

/**
 * Claude and Qoder SDKs serialize non-sdk `mcpServers` into `--mcp-config <json>`,
 * and argv is readable by every local user through `ps`; authorized configs carry
 * headers, stdio env and the history-reader bearer token. Both CLIs also accept a
 * path for that flag (Claude Code `--mcp-config <configs...>`: "JSON files or
 * strings"; qodercli reads any value not starting with `{` as a file), so the same
 * `{ mcpServers }` document goes to a 0600 file in a fresh 0700 directory instead.
 *
 * Synchronous on purpose: the SDK options are built synchronously at launch
 * (`runAgent` returns its handle before any await). The cost is one small file.
 */
export function writePrivateMcpConfig(
  servers: Record<string, unknown>,
  root = tmpdir()
): PrivateMcpConfig | undefined {
  if (Object.keys(servers).length === 0) return undefined
  // mkdtemp creates the directory 0700 with an unpredictable name; the pid lets a
  // later startup tell a crashed owner's leftover from a live instance's file.
  const directory = mkdtempSync(join(root, `${DIRECTORY_PREFIX}${process.pid}-`))
  const path = join(directory, 'mcp.json')
  try {
    writeFileSync(path, JSON.stringify({ mcpServers: servers }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
  let disposed = false
  return {
    extraArgs: { 'mcp-config': path },
    dispose: () => {
      if (disposed) return
      disposed = true
      try {
        rmSync(directory, { recursive: true, force: true })
      } catch (error) {
        console.warn('[scry] private MCP config cleanup failed; the next startup sweep retries:', (error as NodeJS.ErrnoException).code ?? 'unknown')
      }
    }
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Crash recovery: remove directories whose owning process is gone. A live owner,
 * including another Scry instance or a reused pid, keeps its directory; only this
 * user's real directories are touched, never a symlink.
 */
export async function sweepStalePrivateMcpConfigs(
  root = tmpdir(),
  isAlive: (pid: number) => boolean = processAlive
): Promise<number> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  let removed = 0
  for (const name of await readdir(root)) {
    const match = DIRECTORY_NAME.exec(name)
    if (!match) continue
    const pid = Number(match[1])
    if (pid === process.pid || isAlive(pid)) continue
    const path = join(root, name)
    try {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid)) continue
      await rm(path, { recursive: true, force: true })
      removed++
    } catch {
      // Another sweeper or the owner removed it first.
    }
  }
  return removed
}
