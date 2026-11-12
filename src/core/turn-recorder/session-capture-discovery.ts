import { stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { appendRotatingLog, readJson } from './io.js'
import { recorderOpenPath, recorderSessionRoot, type RecorderOpenTurnState } from './runtime-state.js'
import type { RecorderEnablement } from './config.js'
import { attachCaptureBaseline, updateCaptureRepositories } from './session-capture-repositories.js'

/**
 * Repositories come from the files the turn itself touches: the nearest `.git` entry at or above the
 * edited file, walking up. A worktree's gitdir pointer is the repository marker, not a path to
 * follow. The set is persisted per session so later turns baseline the same repositories.
 */
export async function recordCaptureRepositories(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  provider: ProviderId,
  sessionId: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (!enablement.config.capture.diff) return
  const files = editedAbsolutePaths(payload)
  if (files.length === 0) return
  const roots: string[] = []
  for (const file of files) {
    const root = await nearestRepositoryRoot(file)
    if (root && !roots.includes(root)) roots.push(root)
  }
  if (roots.length === 0) return
  const root = recorderSessionRoot(enablement.dataRoot, provider, sessionId)
  const added = await updateCaptureRepositories(root, roots)
  if (added.length === 0) return
  const open = await readJson<RecorderOpenTurnState>(recorderOpenPath(root))
  if (!open) return
  await attachCaptureBaseline(enablement, open, added, root)
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

const PATH_KEYS = ['file_path', 'filePath', 'path']

/**
 * Qoder serializes `tool_input` as a dict string with single quotes, so it is neither JSON nor an
 * object. Read the path fields it does carry instead of dropping the event.
 */
function serializedPaths(source: string): string[] {
  const found: string[] = []
  for (const key of PATH_KEYS) {
    for (const match of source.matchAll(new RegExp(`["']${key}["']\\s*:\\s*["']([^"']+)["']`, 'g'))) {
      if (isAbsolute(match[1])) found.push(match[1])
    }
  }
  return found
}

/** Absolute file paths named by Edit/Write `file_path`, or by Codex apply_patch headers. */
export function editedAbsolutePaths(payload: Record<string, unknown>): string[] {
  const raw = payload.tool_input ?? payload.toolInput
  const toolInput = record(raw) ?? {}
  const result: string[] = []
  for (const key of PATH_KEYS) {
    const value = toolInput[key]
    if (typeof value === 'string' && isAbsolute(value)) result.push(value)
  }
  if (typeof raw === 'string') result.push(...serializedPaths(raw))
  const patch = typeof toolInput.command === 'string' ? toolInput.command
    : typeof raw === 'string' ? raw : undefined
  if (patch) {
    for (const line of patch.split(/\r?\n/)) {
      const match = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/.exec(line)
      if (match && isAbsolute(match[1])) result.push(match[1])
    }
  }
  return [...new Set(result)]
}

/** Walk up to the nearest `.git` entry; it may be a directory or a gitdir pointer file. */
export async function nearestRepositoryRoot(file: string): Promise<string | undefined> {
  let current = dirname(resolve(file))
  for (;;) {
    if (await stat(join(current, '.git')).then(() => true).catch(() => false)) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export async function logCapture(dataRoot: string, line: string): Promise<void> {
  await appendRotatingLog(join(dataRoot, 'logs', 'capture.log'), `${new Date().toISOString()} ${line}`).catch(() => undefined)
}
