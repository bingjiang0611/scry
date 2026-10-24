import { open, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { appendRotatingLog, withDirectoryLock } from './io.js'
import { hasSymlinkComponent } from './config.js'

const MAX_LOG_BYTES = 1024 * 1024

export interface HookSkipSummary {
  count: number
  lastAt: string | null
  scope: 'retained_log_window'
  truncated: boolean
}

// This fixed bootstrap location is usable even when config/dataDir cannot be trusted.
export async function recordInvalidHookConfig(workspace: string, provider: string, event: string): Promise<void> {
  // A rejected dataDir may itself be a symlink. Diagnostics must not write through it.
  if (await hasSymlinkComponent(workspace, '.scry/logs/hook-skip.log')) return
  const safeEvent = /^[A-Za-z0-9_.:-]{1,128}$/.test(event) ? event : 'unknown'
  await appendRotatingLog(join(workspace, '.scry/logs/hook-skip.log'),
    `${new Date().toISOString()}\t${provider}\t${safeEvent}\tinvalid_config\t0`)
}

async function logTail(path: string): Promise<{ text: string; truncated: boolean }> {
  let file
  try { file = await open(path, 'r') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', truncated: false }
    throw error
  }
  try {
    const { size } = await file.stat()
    const offset = Math.max(0, size - MAX_LOG_BYTES)
    const buffer = Buffer.alloc(Math.min(size, MAX_LOG_BYTES))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    return { text: offset ? text.slice(text.indexOf('\n') + 1) : text, truncated: offset > 0 }
  } finally {
    await file.close()
  }
}

export async function readHookSkips(workspace: string): Promise<HookSkipSummary> {
  if (await hasSymlinkComponent(workspace, '.scry/logs/hook-skip.log') ||
    await hasSymlinkComponent(workspace, '.scry/logs/hook-skip.log.1')) {
    throw new Error('hook diagnostics unavailable: symbolic link')
  }
  const path = join(workspace, '.scry/logs/hook-skip.log')
  const size = await stat(path).then(value => value.size).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return 0
    throw error
  })
  // Shell only appends. CLI diagnostics rotate one generation; a machine running only failed
  // shell hooks can exceed this soft threshold until the next CLI diagnostic invocation.
  if (size > MAX_LOG_BYTES) {
    await withDirectoryLock(join(workspace, '.scry/locks/hook-skip.lock'), async () => {
      try {
        if ((await stat(path)).size > MAX_LOG_BYTES) await rename(path, `${path}.1`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    })
  }
  const tails = await Promise.all([logTail(`${path}.1`), logTail(path)])
  let count = 0
  let lastAt: string | null = null
  for (const { text } of tails) {
    for (const line of text.split('\n')) {
      const [at, provider, event, reason, code] = line.split('\t')
      if (!provider || !event || !reason || !/^\d+$/.test(code ?? '')) continue
      count++
      // Do not export arbitrary log text in the sanitized support bundle.
      if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(at) && (!lastAt || Date.parse(at) > Date.parse(lastAt))) lastAt = at
    }
  }
  return { count, lastAt, scope: 'retained_log_window', truncated: tails.some(tail => tail.truncated) }
}
