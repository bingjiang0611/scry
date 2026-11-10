import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Write one archived Scry turn into a temporary userData, the way the App itself stores it,
 * so an App smoke can replay it without any Provider.
 *
 * The archive path, the session row and the recent folder must match production layout;
 * a replay that reads a bespoke location proves nothing about the real one.
 */
export function seedArchivedTurn({ userDataDir, source, preview }) {
  if (source.turns.length !== 1) throw new Error('replay exactly one archived turn')
  const hash = (value) => createHash('sha256').update(value).digest('hex')
  const turn = source.turns[0]
  const archiveDir = join(userDataDir, 'trace-archive-turns-v1', source.providerId,
    `cwd-${hash(source.cwd)}`, `sid-${hash(source.sessionId)}`)
  mkdirSync(archiveDir, { recursive: true })
  const identity = turn.providerTurnId ? `provider\0${turn.providerTurnId}` : `run\0${turn.runId}`
  writeFileSync(join(archiveDir, `turn-${hash(identity)}.json`), JSON.stringify(source))
  writeFileSync(join(userDataDir, 'app-sessions.json'), JSON.stringify([{
    sessionId: source.sessionId,
    externalSessionId: source.externalSessionId,
    runId: turn.runId,
    providerId: source.providerId,
    runtimeProvider: source.runtimeProvider,
    cwd: source.cwd,
    preview,
    ts: Date.now()
  }]))
  writeFileSync(join(userDataDir, 'recent-folders.json'), JSON.stringify([source.cwd]))
}

/**
 * Write the Provider-native transcript rows for the same session, so the replay exercises the
 * production transcript↔archive merge instead of an archive-only shortcut. Claude Code stores
 * one JSONL file per session and the parser only trusts it when every row names the same
 * cwd/session, so each row is stamped.
 */
export function seedNativeTranscript({ home, cwd, sessionId, messages }) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('native transcript needs rows')
  const dir = join(home, '.claude', 'projects', cwd.replace(/[/._]/g, '-'))
  mkdirSync(dir, { recursive: true })
  let parentUuid = null
  const lines = messages.map((message, index) => {
    const uuid = `native-${sessionId}-${index}`
    const row = {
      parentUuid, isSidechain: false, userType: 'external', cwd, sessionId,
      version: '2.1.226', gitBranch: '', type: message.type, message: message.message,
      uuid, timestamp: new Date(Date.UTC(2026, 10, 10, 0, 0, index)).toISOString()
    }
    parentUuid = uuid
    return JSON.stringify(row)
  })
  writeFileSync(join(dir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`)
}
