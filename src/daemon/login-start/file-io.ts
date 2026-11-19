import { randomUUID } from 'node:crypto'
import {
  closeSync, constants, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

// Atomic owner-only service file I/O and systemctl show parser (plain Node).

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
      try { closeSync(fd) } catch { /* ignore */ }
    }
    try { unlinkSync(temp) } catch { /* ignore */ }
    throw error
  }
}

/** Parses `systemctl show -p ActiveState,MainPID` (Key=Value lines, order-independent). */
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
