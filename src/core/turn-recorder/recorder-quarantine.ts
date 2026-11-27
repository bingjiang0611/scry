import { access, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { readJson, withDirectoryLock, writeJsonAtomic } from './io.js'
import type { RecorderOpenTurnState } from './runtime-state.js'

export function recorderQuarantineIndexPath(root: string): string {
  return join(dirname(dirname(dirname(root))), 'quarantine-index', basename(dirname(root)), `${basename(root)}.json`)
}

async function quarantineGenerations(root: string, reconcile = false): Promise<string[]> {
  const indexed = await readJson<string[]>(recorderQuarantineIndexPath(root))
  if (!reconcile && Array.isArray(indexed) && indexed.every(value =>
    typeof value === 'string' && basename(value) === value && value !== '.' && value !== '..'
  )) return indexed
  const generations: string[] = []
  const entries = await readdir(join(root, 'turns'), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const exists = await stat(join(root, 'turns', entry.name, 'pending-open.json')).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    if (exists) generations.push(entry.name)
  }
  await writeJsonAtomic(recorderQuarantineIndexPath(root), generations)
  return generations
}

export async function publishQuarantinedOpenTurn(
  root: string, open: RecorderOpenTurnState & { quarantinedAt: string; reason: string }
): Promise<void> {
  await withDirectoryLock(`${recorderQuarantineIndexPath(root)}.lock`, async () => {
    const generations = await quarantineGenerations(root)
    const generation = String(open.generation).padStart(8, '0')
    if (!generations.includes(generation)) {
      await writeJsonAtomic(recorderQuarantineIndexPath(root), [...generations, generation])
    }
    await writeJsonAtomic(join(root, 'turns', generation, 'pending-open.json'), open, { sync: false })
  })
}

export async function recorderQuarantinedOpenTurns(
  root: string, options: { reconcile?: boolean } = {}
): Promise<RecorderOpenTurnState[]> {
  return withDirectoryLock(`${recorderQuarantineIndexPath(root)}.lock`, async () => {
    const generations = await quarantineGenerations(root, options.reconcile)
    const result: RecorderOpenTurnState[] = []
    const retained: string[] = []
    for (const generation of generations) {
      const path = join(root, 'turns', generation, 'pending-open.json')
      const open = await readJson<RecorderOpenTurnState>(path)
      if (open) result.push(open)
      if (open || await pathExists(path)) retained.push(generation)
    }
    if (retained.length !== generations.length) await writeJsonAtomic(recorderQuarantineIndexPath(root), retained)
    return result
  })
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}
