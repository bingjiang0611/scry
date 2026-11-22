import { readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { writeJsonAtomic, writeTextAtomic } from './io.js'
import { resolveRecorderLocation, type RecorderConfig } from './config.js'
import { gitCommand } from './git-command.js'
import { CaptureRequestError } from './session-capture-contract.js'

async function canonicalPath(path: string): Promise<string> {
  const resolved = resolve(path)
  return realpath(resolved).catch(async () =>
    join(await realpath(dirname(resolved)).catch(() => dirname(resolved)), basename(resolved)))
}

export async function canonicalWorkspaceRoot(workspace: string): Promise<string> {
  return canonicalPath(workspace)
}

export async function canonicalDataRoot(workspaceRoot: string, dataDir: string): Promise<string> {
  const root = await canonicalPath(workspaceRoot)
  const real = await canonicalPath(dataDir)
  if (real !== root && !real.startsWith(`${root}/`)) {
    throw new CaptureRequestError('invalid_request', '--data-dir must be a subdirectory of the workspace')
  }
  return real
}

async function enableOptIn(workspaceRoot: string, fromRoot: string): Promise<void> {
  const path = join(workspaceRoot, 'scry.config.json')
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  const capture = raw.capture && typeof raw.capture === 'object' && !Array.isArray(raw.capture)
    ? raw.capture as Record<string, unknown>
    : {}
  await writeJsonAtomic(path, { ...raw, capture: { ...capture, sessions: 'opt-in' } })
  await excludeFromStatus(workspaceRoot, ['scry.config.json', `${fromRoot}/`])
}

function workspaceIdFor(workspaceRoot: string): string {
  return workspaceRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'
}

export async function ensureWorkspaceConfig(workspaceRoot: string, dataDir: string): Promise<RecorderConfig> {
  const dataRoot = dataDir
  const fromRoot = relative(workspaceRoot, dataRoot)
  if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new CaptureRequestError('invalid_request', '--data-dir must be a subdirectory of the workspace')
  }
  const location = await resolveRecorderLocation(workspaceRoot)
  if (location.valid) {
    if (resolve(location.dataRoot) !== dataRoot) {
      throw new CaptureRequestError('invalid_request', 'scry.config.json dataDir does not match --data-dir')
    }
    if (!location.config.enabled) throw new CaptureRequestError('recorder_unavailable', 'this workspace config disables the recorder')
    if (location.config.capture.sessions === 'opt-in') return location.config
    await enableOptIn(location.workspaceRoot, fromRoot)
    const updated = await resolveRecorderLocation(workspaceRoot)
    if (!updated.valid) throw new CaptureRequestError('recorder_unavailable', 'scry.config.json could not be read back')
    return updated.config
  }
  if (location.reason === 'invalid_config') {
    throw new CaptureRequestError('recorder_unavailable', `scry.config.json is invalid: ${location.detail ?? 'unknown reason'}`)
  }
  await writeJsonAtomic(join(workspaceRoot, 'scry.config.json'), {
    schemaVersion: 1,
    enabled: true,
    workspaceId: workspaceIdFor(workspaceRoot),
    dataDir: fromRoot,
    repositories: { mode: 'discover-nested-git', maxDepth: 2 },
    capture: { prompt: true, assistant: true, toolOutput: 'full', diff: true, hooks: true, sessions: 'opt-in' }
  })
  await excludeFromStatus(workspaceRoot, ['scry.config.json', `${fromRoot}/`])
  const written = await resolveRecorderLocation(workspaceRoot)
  if (!written.valid) throw new CaptureRequestError('recorder_unavailable', 'scry.config.json could not be read back')
  return written.config
}

async function excludeFromStatus(workspaceRoot: string, entries: string[]): Promise<void> {
  try {
    const configured = await gitCommand(['rev-parse', '--git-path', 'info/exclude'], {
      cwd: workspaceRoot, deadline: Date.now() + 2_000
    })
    const value = configured.trim()
    if (!value) return
    const path = value.startsWith('/') ? value : resolve(workspaceRoot, value)
    const existing = await readFile(path, 'utf8').catch(() => '')
    const lines = existing.split(/\r?\n/)
    const missing = entries.filter((entry) => !lines.includes(entry))
    if (missing.length === 0) return
    const source = `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`
    await writeTextAtomic(path, source, { sync: false })
  } catch {
  }
}
