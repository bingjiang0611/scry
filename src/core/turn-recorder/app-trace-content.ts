import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const APP_TRACE_CONTENT_DIR = 'trace-content-v1'

export function appTraceContentRoot(userDataDir: string, cwd: string): string {
  return join(userDataDir, APP_TRACE_CONTENT_DIR, createHash('sha256').update(cwd).digest('hex'))
}

export async function appTraceContentRoots(appDataDir: string): Promise<string[]> {
  const base = join(appDataDir, APP_TRACE_CONTENT_DIR)
  let entries
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const roots: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const root = join(base, entry.name)
    try {
      if (!(await stat(join(root, 'content', 'sha256'))).isDirectory()) continue
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    roots.push(root)
  }
  return roots.sort()
}
