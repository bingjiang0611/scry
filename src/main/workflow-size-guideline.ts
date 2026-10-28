import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { withDirectoryLock } from '../core/turn-recorder/io'
import { workflowSizeCopy as copy } from '../shared/constants/copy'
import { isWorkflowSizeGuideline, validateWorkflowSizeSnapshot, type WorkflowSizeGuideline, type WorkflowSizeSnapshot } from '../shared/workflow-size'
import type { WorkflowPlanningIntent } from './workflow-store-contracts'
import { absent } from './workflow-store-artifacts'

const MAX_BYTES = 64 * 1024
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
type ConfigurationFile = { value: Record<string, unknown>; fingerprint: string }

/** Missing is not malformed. Unknown preference keys are retained by the shared file. */
function parseFile(text: string, name: string): ConfigurationFile {
  let value: unknown
  try { value = JSON.parse(text) } catch (error) { throw new Error(copy.invalidFile(name), { cause: error }) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(copy.invalidFile(name))
  const record = value as Record<string, unknown>
  if (Object.hasOwn(record, 'workflowSizeGuideline') && !isWorkflowSizeGuideline(record.workflowSizeGuideline)) throw new Error(copy.invalidFile(name))
  return { value: record, fingerprint: digest(text) }
}

export function resolveWorkflowSize(settingsText?: string, preferencesText?: string): { snapshot: WorkflowSizeSnapshot; preferences: Record<string, unknown> } {
  const settings = settingsText === undefined ? undefined : parseFile(settingsText, 'settings.json')
  const preferences = preferencesText === undefined ? undefined : parseFile(preferencesText, 'preferences.json')
  const configured = settings?.value.workflowSizeGuideline
  const preferred = preferences?.value.workflowSizeGuideline
  const value = (configured ?? preferred ?? 'medium') as WorkflowSizeGuideline
  const source = configured !== undefined ? 'file' : preferred !== undefined ? 'preference' : 'default'
  return { snapshot: { value, source, fingerprint: digest(JSON.stringify({ value, source,
    settings: settings?.fingerprint ?? null, preferences: preferences?.fingerprint ?? null })) }, preferences: preferences?.value ?? {} }
}

/** Fixed App-owned directory only; no renderer path or repository configuration. */
async function ownedDirectory(directory: string): Promise<boolean> {
  let stat
  try { stat = await lstat(directory) } catch (error) { if (absent(error)) return false; throw error }
  const parent = await realpath(dirname(directory))
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== join(parent, basename(directory))) throw new Error(copy.unowned)
  return true
}

async function readFile(directory: string, name: string): Promise<string | undefined> {
  const file = join(directory, name)
  let stat
  try { stat = await lstat(file) } catch (error) { if (absent(error)) return undefined; throw error }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(copy.unowned)
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!(await handle.stat()).isFile()) throw new Error(copy.unowned)
    // Bound the actual read, not just a size observed before a possible append.
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > MAX_BYTES) throw new Error(copy.oversized)
    return buffer.subarray(0, length).toString('utf8')
  } finally { await handle.close() }
}

export async function readWorkflowSize(directory: string): Promise<ReturnType<typeof resolveWorkflowSize>> {
  if (!await ownedDirectory(directory)) return resolveWorkflowSize()
  const [settings, preferences] = await Promise.all([readFile(directory, 'settings.json'), readFile(directory, 'preferences.json')])
  return resolveWorkflowSize(settings, preferences)
}

export async function updateWorkflowSize(directory: string, value: WorkflowSizeGuideline | null, write: (text: string) => Promise<void>): Promise<WorkflowSizeSnapshot> {
  if (value !== null && !isWorkflowSizeGuideline(value)) throw new Error(copy.invalidValue)
  await ownedDirectory(directory)
  return withDirectoryLock(join(directory, 'locks', 'preferences.json.lock'), async () => {
    const { snapshot, preferences } = await readWorkflowSize(directory)
    if (snapshot.source === 'file') throw new Error(copy.overridden)
    if (value === null) delete preferences.workflowSizeGuideline
    else preferences.workflowSizeGuideline = value
    const text = JSON.stringify(preferences)
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error(copy.oversized)
    await write(text)
    return (await readWorkflowSize(directory)).snapshot
  }, { requireDeadOwner: true })
}

export function validatePlanningSize(intent: WorkflowPlanningIntent, previous?: WorkflowPlanningIntent): void {
  if (intent.sizeGuideline !== undefined) validateWorkflowSizeSnapshot(intent.sizeGuideline)
  if (intent.sizeOverrideReason !== undefined && (typeof intent.sizeOverrideReason !== 'string' || intent.sizeOverrideReason.length > 4096)) throw new Error(copy.invalidSnapshot)
  if (!previous) return
  const before = previous.sizeGuideline
  const after = intent.sizeGuideline
  if (before?.value !== after?.value || before?.source !== after?.source || before?.fingerprint !== after?.fingerprint ||
    (previous.sizeOverrideReason !== undefined && previous.sizeOverrideReason !== intent.sizeOverrideReason)) throw new Error(copy.immutable)
}
