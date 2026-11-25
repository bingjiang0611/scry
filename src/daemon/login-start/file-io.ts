import { randomUUID } from 'node:crypto'
import {
  closeSync, constants, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'


export type ServiceFileRead =
  | { kind: 'missing' }
  | { kind: 'symlink' }
  | { kind: 'error'; code: string }
  | { kind: 'file'; content: string }

export function readRegularServiceFile(path: string): ServiceFileRead {
  let info
  try { info = lstatSync(path) } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'error', code: code ?? 'unknown' }
  }
  if (!info.isFile() || info.isSymbolicLink()) return { kind: 'symlink' }
  try {
    return { kind: 'file', content: readFileSync(path, 'utf8') }
  } catch (error) {
    return { kind: 'error', code: (error as NodeJS.ErrnoException).code ?? 'unknown' }
  }
}

export function writeFileAtomicPrivate(filePath: string, content: string): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const temp = join(dir, `.scry-login-start-${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    writeFileSync(fd, content, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, filePath)
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
    try { unlinkSync(temp) } catch {}
    throw error
  }
}

export function parseSystemdShowProperties(stdout: string): { active: boolean; mainPid: number | null } {
  const map = new Map<string, string>()
  for (const rawLine of stdout.split(/\r?\n/)) {
    const eq = rawLine.indexOf('=')
    if (eq <= 0) continue
    map.set(rawLine.slice(0, eq).trim(), rawLine.slice(eq + 1).trim())
  }
  const active = map.get('ActiveState') === 'active'
  const parsedPid = Number(map.get('MainPID'))
  const mainPid = active && Number.isSafeInteger(parsedPid) && parsedPid > 1 ? parsedPid : null
  return { active, mainPid }
}

export interface LaunchctlPrintInfo {
  runState: 'idle' | 'running' | 'unknown'
  userDataDir: string | null
}

export function parseLaunchctlPrint(stdout: string): LaunchctlPrintInfo {
  let depth = 0
  let inJobEnv = false
  let topState: string | null = null
  let hasPid = false
  let userDataDir: string | null = null

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const openMatch = line.match(/^\s*([A-Za-z0-9_.\-/ ]+?)\s*=\s*\{\s*$/)
    if (openMatch) {
      depth += 1
      if (depth === 2 && openMatch[1].trim() === 'environment') inJobEnv = true
      continue
    }
    if (/^\s*\}\s*$/.test(line)) {
      if (depth === 2) inJobEnv = false
      if (depth > 0) depth -= 1
      continue
    }
    if (depth === 1) {
      const stateMatch = line.match(/^\s+state\s*=\s*(.+)$/)
      if (stateMatch) { topState = stateMatch[1].trim(); continue }
      if (/^\s+pid\s*=\s*\d+\s*$/.test(line)) hasPid = true
    } else if (depth === 2 && inJobEnv) {
      const envMatch = line.match(/^\s+SCRY_DAEMON_USER_DATA_DIR\s*=>\s*(.+)$/)
      if (envMatch) userDataDir = envMatch[1]
    }
  }

  const runState = hasPid || topState === 'running'
    ? 'running'
    : topState === 'not running' ? 'idle' : 'unknown'
  return { runState, userDataDir }
}
