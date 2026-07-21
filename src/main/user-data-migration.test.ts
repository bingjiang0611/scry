import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { migrateLegacyUserData } from './user-data-migration'

const legacySlug = (): string => ['agent', 'scope'].join('-')

describe('migrateLegacyUserData', () => {
  it('copies legacy app data byte-for-byte and renames sqlite files without overwriting new data', () => {
    const root = mkdtempSync(join(tmpdir(), 'scry-migration-'))
    const appDataDir = join(root, 'appData')
    const userDataDir = join(appDataDir, 'scry')
    const legacyDir = join(appDataDir, legacySlug())
    const oldCwd = join(root, `customer-${legacySlug()}-tool`)
    const renamedCwd = oldCwd.replace(legacySlug(), 'scry')
    const oldTranscriptDir = oldCwd.replace(/[/._]/g, '-')
    const renamedTranscriptDir = renamedCwd.replace(/[/._]/g, '-')
    const appSessions = JSON.stringify([{ sessionId: 'old', cwd: oldCwd, preview: `opened ${legacySlug()}` }])
    const usage = JSON.stringify({ cwd: oldCwd, project_key: `team-${legacySlug()}`, cost: 1 }) + '\n'
    const transcript = JSON.stringify({ cwd: oldCwd, text: `tool output mentioned ${legacySlug()}` }) + '\n'
    mkdirSync(join(legacyDir, 'transcripts', oldTranscriptDir), { recursive: true })
    mkdirSync(userDataDir, { recursive: true })

    writeFileSync(join(legacyDir, 'app-sessions.json'), appSessions)
    writeFileSync(join(legacyDir, 'recent-folders.json'), JSON.stringify([oldCwd]))
    writeFileSync(join(legacyDir, 'usage.jsonl'), usage)
    writeFileSync(join(legacyDir, `${legacySlug()}.db`), `db with ${legacySlug()} project_key`)
    writeFileSync(join(legacyDir, `${legacySlug()}.db-wal`), 'wal')
    writeFileSync(join(legacyDir, 'transcripts', oldTranscriptDir, 's.jsonl'), transcript)
    writeFileSync(join(userDataDir, 'recent-folders.json'), '["/new"]')

    expect(migrateLegacyUserData(appDataDir, userDataDir)).toBe(true)
    expect(readFileSync(join(userDataDir, 'app-sessions.json'), 'utf8')).toBe(appSessions)
    expect(readFileSync(join(userDataDir, 'recent-folders.json'), 'utf8')).toContain('/new')
    expect(readFileSync(join(userDataDir, 'usage.jsonl'), 'utf8')).toBe(usage)
    expect(readFileSync(join(userDataDir, 'scry.db'), 'utf8')).toBe(`db with ${legacySlug()} project_key`)
    expect(readFileSync(join(userDataDir, 'scry.db-wal'), 'utf8')).toBe('wal')
    expect(readFileSync(join(userDataDir, 'transcripts', oldTranscriptDir, 's.jsonl'), 'utf8')).toBe(transcript)
    expect(existsSync(join(userDataDir, 'transcripts', renamedTranscriptDir, 's.jsonl'))).toBe(false)
    expect(migrateLegacyUserData(appDataDir, userDataDir)).toBe(false)
  })
})
