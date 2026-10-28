import { copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { createGunzip } from 'node:zlib'
import { join } from 'node:path'

// Active file, pre-archive rotated files ([1-3]) and timestamped archives (gzip once finished).
const PERFORMANCE_FILE_RE = /^performance-(?:[0-3]|\d{8}T\d{9}Z-[0-9a-f]{8})\.jsonl(?:\.gz)?$/
// One 5 MiB active file plus the journal's 64 MiB compressed-archive cap, with room for one
// archive that is still being compressed.
const MAX_SNAPSHOT_FILE_BYTES = 6 * 1024 * 1024
const MAX_SNAPSHOT_BYTES = 80 * 1024 * 1024
// Oldest first: timestamped archives by stamp, then legacy 3..1, then the active file.
const journalOrder = name => {
  const legacy = /^performance-([0-3])\.jsonl$/.exec(name)
  return legacy ? `~${3 - Number(legacy[1])}` : name
}
const byJournalOrder = (left, right) => journalOrder(left) < journalOrder(right) ? -1 : 1

export function snapshotPerformanceDirectory(source, target) {
  if (!source || !target) throw new Error('Usage: snapshot <performance-directory> <new-output-directory>')
  if (!existsSync(source)) throw new Error(`Performance directory does not exist: ${source}`)
  if (existsSync(target)) throw new Error(`Refusing to overwrite existing snapshot directory: ${target}`)
  const files = readdirSync(source).filter(name => PERFORMANCE_FILE_RE.test(name)).sort(byJournalOrder)
  if (!files.length) throw new Error('No retained performance journal files to snapshot')
  let total = 0
  // Cleanup is authorized only after this invocation successfully creates the directory.
  mkdirSync(target, { recursive: false })
  try {
    const copied = files.map(name => {
      const from = join(source, name)
      const info = lstatSync(from)
      if (!info.isFile()) throw new Error(`Snapshot source is not a regular file: ${name}`)
      if (info.size > MAX_SNAPSHOT_FILE_BYTES) throw new Error(`Snapshot file exceeds 6 MiB bound: ${name}`)
      total += info.size
      if (total > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot exceeds 80 MiB bound')
      copyFileSync(from, join(target, name))
      const after = lstatSync(from)
      if (after.ino !== info.ino || after.dev !== info.dev || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error(`Snapshot source changed while copying: ${name}`)
      const copied = readFileSync(join(target, name))
      if (copied.length !== info.size) throw new Error(`Snapshot size changed while copying: ${name}`)
      return { name, bytes: copied.length, sha256: createHash('sha256').update(copied).digest('hex') }
    })
    writeFileSync(join(target, 'snapshot-manifest.json'), JSON.stringify({ schema: 1, files: copied, totalBytes: total }, null, 2))
    return { target, files: copied, totalBytes: total, immutable: false, consistency: 'per-file-checked; not an atomic multi-file capture' }
  } catch (error) {
    rmSync(target, { recursive: true, force: true })
    throw error
  }
}

export async function readRecords(directory) {
  const records = []
  const issues = []
  const files = readdirSync(directory).filter(name => PERFORMANCE_FILE_RE.test(name)).sort(byJournalOrder)
  const manifestPath = join(directory, 'snapshot-manifest.json')
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null
  if (manifest && JSON.stringify([...manifest.files.map(file => file.name)].sort()) !== JSON.stringify([...files].sort())) {
    issues.push({ file: 'snapshot-manifest.json', reason: 'snapshot-file-set-mismatch' })
  }
  for (const name of files) {
    const input = createReadStream(join(directory, name))
    const hash = createHash('sha256')
    // The manifest hashes the file bytes as copied; gzip archives are decoded only for parsing.
    input.on('data', chunk => hash.update(chunk))
    const lines = createInterface({ input: name.endsWith('.gz') ? input.pipe(createGunzip()) : input, crlfDelay: Infinity })
    let pending
    for await (const line of lines) {
      if (pending?.trim()) {
        try { records.push(JSON.parse(pending)) }
        catch { issues.push({ file: name, reason: 'invalid-line; retained remaining journal for provisional reporting' }) }
      }
      pending = line
    }
    if (pending?.trim()) {
      try { records.push(JSON.parse(pending)) }
      catch { issues.push({ file: name, reason: 'invalid-last-record; retained, comparison incomplete' }) }
    }
    const digest = hash.digest('hex')
    if (manifest && manifest.files.find(file => file.name === name)?.sha256 !== digest) {
      issues.push({ file: name, reason: 'snapshot-hash-mismatch-or-unverified' })
    }
  }
  if (!records.length) throw new Error('No performance records. Enable local recording, use the app, then close it or wait for a flush.')
  return { records, issues }
}
