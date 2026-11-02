import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative } from 'node:path'
import { UploadError } from './errors.js'
import { ensurePrivateDirectory, readJson } from './util.js'

export function dataRoot(workspace: string): string {
  const config = JSON.parse(readFileSync(join(workspace, 'scry.config.json'), 'utf8'))
  if (config?.schemaVersion !== 1 || typeof config.workspaceId !== 'string' || !config.workspaceId.trim()) {
    throw new UploadError('scry_config_invalid', 'invalid scry.config.json')
  }
  const value = typeof config.dataDir === 'string' && config.dataDir.trim() ? config.dataDir : '.scry'
  const normalized = normalize(value)
  if (isAbsolute(value) || normalized === '.' || normalized.startsWith('..')) {
    throw new UploadError('scry_data_dir_invalid', 'dataDir must stay inside the workspace')
  }
  let current = workspace
  for (const component of value.split('/')) {
    if (!component || component === '.') continue
    current = join(current, component)
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new UploadError('scry_data_dir_symlink', 'dataDir must not contain a symlink')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return join(workspace, normalized)
}

export function uploadRoot(workspace: string): string {
  return join(dataRoot(workspace), 'upload')
}
export function recordFilename(sequence: number, recordId: string): string {
  return `${String(sequence).padStart(20, '0')}-${recordId}.json`
}
export function receiptPath(base: string, recordId: string): string {
  return join(base, 'receipts', `${recordId}.json`)
}
export function committedPath(base: string, sequence: number, recordId: string): string {
  return join(base, 'outbox', 'committed', recordFilename(sequence, recordId))
}
export function digest(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function prepareUploadRoot(workspace: string): Promise<string> {
  const data = dataRoot(workspace)
  let current = workspace
  // Repeat ancestor barriers on retries: an existing directory is not evidence
  // that an earlier mkdir/rename reached stable storage.
  for (const component of relative(workspace, data).split('/')) {
    current = join(current, component)
    await ensurePrivateDirectory(current, false)
  }
  const base = join(data, 'upload')
  for (const name of [
    '',
    'outbox',
    'outbox/committed',
    'outbox/committed/legacy',
    'receipts',
    'dead-letter',
    'jobs',
    'jobs/dead-letter'
  ]) {
    await ensurePrivateDirectory(join(base, name), false)
  }
  return base
}

export async function assertLegacyLocksMigrated(base: string): Promise<void> {
  const marker = await readJson<{ legacyLocksConfirmed?: boolean }>(join(base, 'migration.json'))
  if (marker?.legacyLocksConfirmed === true) return
  let legacyMain = false
  try {
    await stat(join(base, 'lock'))
    legacyMain = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const names = await readdir(join(base, 'receipts'))
  if (legacyMain || names.some((name) => /^\.[a-f0-9]{32,64}\.lock$/.test(name))) {
    throw new UploadError(
      'legacy_store_requires_migration',
      'legacy upload locks exist; stop old workers, then run scry-upload migrate',
      true
    )
  }
}
