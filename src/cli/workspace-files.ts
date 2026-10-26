import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { stat, access, readFile, mkdir, writeFile, chmod, rename } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, resolve } from 'node:path'


export const execFileAsync = promisify(execFile)

export function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function writeAtomic(path: string, source: string, mode = 0o600): Promise<boolean> {
  const current = await readOptional(path)
  if (current === source) return false
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, source, { mode })
  await chmod(temporary, mode)
  await rename(temporary, path)
  return true
}

export async function gitExcludePath(workspace: string): Promise<string> {
  const result = await execFileAsync('git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' })
  const value = result.stdout.trim()
  return value.startsWith('/') ? value : resolve(workspace, value)
}
