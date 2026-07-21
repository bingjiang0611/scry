import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LEGACY_SLUG = ['agent', 'scope'].join('-')
const SCRY_SLUG = 'scry'
const MIGRATION_MARKER = '.legacy-agent-scope-migration-v1.done'

function copyIfMissing(source: string, target: string): boolean {
  if (!existsSync(source) || existsSync(target)) return false
  mkdirSync(join(target, '..'), { recursive: true })
  copyFileSync(source, target)
  return true
}

function copyTranscripts(sourceDir: string, targetDir: string): boolean {
  if (!existsSync(sourceDir)) return false
  let copied = false
  for (const entry of readdirSync(sourceDir)) {
    const source = join(sourceDir, entry)
    const target = join(targetDir, entry)
    const stat = statSync(source)
    if (stat.isDirectory()) {
      copied = copyTranscripts(source, target) || copied
    } else if (stat.isFile() && !existsSync(target)) {
      mkdirSync(join(target, '..'), { recursive: true })
      copyFileSync(source, target)
      copied = true
    }
  }
  return copied
}

export function migrateLegacyUserData(appDataDir: string, userDataDir: string): boolean {
  const legacyDir = join(appDataDir, LEGACY_SLUG)
  if (!existsSync(legacyDir) || legacyDir === userDataDir) return false
  const marker = join(userDataDir, MIGRATION_MARKER)
  if (existsSync(marker)) return false
  mkdirSync(userDataDir, { recursive: true })
  const currentDataExists = ['app-sessions.json', `${SCRY_SLUG}.db`, 'transcripts'].some((entry) => existsSync(join(userDataDir, entry)))
  if (currentDataExists) {
    writeFileSync(marker, `${new Date().toISOString()}\n`)
    return false
  }

  let copied = false
  for (const file of ['app-sessions.json', 'recent-folders.json', 'usage.jsonl']) {
    copied = copyIfMissing(join(legacyDir, file), join(userDataDir, file)) || copied
  }
  for (const suffix of ['', '-wal', '-shm']) {
    copied = copyIfMissing(join(legacyDir, `${LEGACY_SLUG}.db${suffix}`), join(userDataDir, `${SCRY_SLUG}.db${suffix}`)) || copied
  }

  const transcripts = join(legacyDir, 'transcripts')
  const targetTranscripts = join(userDataDir, 'transcripts')
  copied = copyTranscripts(transcripts, targetTranscripts) || copied
  writeFileSync(marker, `${new Date().toISOString()}\n`)
  return copied
}
