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
  const files = writePrivateFiles([['mcp.json', JSON.stringify({ mcpServers: servers })]], root)
  return { extraArgs: { 'mcp-config': files.paths[0] }, dispose: files.dispose }
}

export interface PrivateMcpEnvFiles {
  /** One file per input, in the same order. */
  paths: string[]
  /** Idempotent. A leftover from a crash is removed by the next startup sweep. */
  dispose(): void
}

/**
 * Codex stdio MCP env files (see codex-stdio-env.ts): same directory, mode and
 * sweep as the config file above, one directory per pooled Codex client.
 */
export function writePrivateMcpEnvFiles(contents: string[], root = tmpdir()): PrivateMcpEnvFiles | undefined {
  if (contents.length === 0) return undefined
  return writePrivateFiles(contents.map((content, index) => [`${index}.env`, content]), root)
}

function writePrivateFiles(files: Array<[name: string, content: string]>, root: string): PrivateMcpEnvFiles {
  // mkdtemp creates the directory 0700 with an unpredictable name; the pid lets a
  // later startup tell a crashed owner's leftover from a live instance's file.
  const directory = mkdtempSync(join(root, `${DIRECTORY_PREFIX}${process.pid}-`))
  const paths = files.map(([name]) => join(directory, name))
  try {
    // `wx` never follows or reuses an existing path.
    files.forEach(([, content], index) => writeFileSync(paths[index], content, { encoding: 'utf8', mode: 0o600, flag: 'wx' }))
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
  let disposed = false
  return {
    paths,
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
 * Best-effort crash recovery for private MCP config directories. Skips live PIDs
 * (including reused PIDs) and symlinks, and checks ownership when a UID is available.
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
      // Cleanup is best effort; the directory may already be gone.
    }
  }
  return removed
}
