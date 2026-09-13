// Prove the host-side readHistory read path (the SAME code index.ts wires for
// the phone's "open session" op) produces real conversation turns from an
// existing on-disk trace archive. Uses a REAL local qoder session; passes the
// real userData dir directly (no Electron). Read-only.
import { readFile } from 'node:fs/promises'
import { readTraceArchiveAsync } from '../../src/main/transcript-archive'
import { mergeSessionTurns } from '../../src/main/session-history'
import { parseTranscriptToTurns } from '../../src/main/normalize'
import { flattenTraceItems } from '../../src/main/remote/trace-output'

const userDataDir = process.env.HOME + '/Library/Application Support/scry'
const sessions = JSON.parse(await readFile(userDataDir + '/app-sessions.json', 'utf8'))
const candidates = sessions.filter((s) => s.providerId === 'qoder' && s.externalSessionId && s.cwd)
if (candidates.length === 0) { console.log('[check] no qoder session with ext+cwd on disk'); process.exit(1) }

// Mirror index.ts readHistory (non-claude branch: archive-only). Scan for the
// first session that produced renderable content - many are errored turns
// (e.g. login EPERM) that honestly have no assistant content.
let target, turns
for (const s of candidates) {
  const archived = await readTraceArchiveAsync({ cwd: s.cwd, sessionId: s.externalSessionId, providerId: 'qoder', userDataDir })
  if (!archived) continue
  const merged = mergeSessionTurns([], archived, { userDataDir })
  const t = merged.map((m) => ({ userText: m.userText, items: flattenTraceItems(m.items) }))
  if (t.reduce((n, x) => n + x.items.length, 0) > 0) { target = s; turns = t; break }
}
if (!target) { console.log('[check] \u2717 no qoder session yielded renderable content (all errored/empty)'); process.exit(1) }
console.log(`[check] session ext=${target.externalSessionId.slice(0, 12)} cwd=${target.cwd}`)

const totalItems = turns.reduce((n, t) => n + t.items.length, 0)
console.log(`[check] \u2705 readHistory produced ${turns.length} turn(s), ${totalItems} content chunk(s)`)
for (const [i, t] of turns.slice(0, 2).entries()) {
  console.log(`  turn ${i}: user="${(t.userText || '').slice(0, 30)}" items=${t.items.length} kinds=${JSON.stringify([...new Set(t.items.map((x) => x.kind))])}`)
  const firstText = t.items.find((x) => x.kind === 'output')
  if (firstText) console.log(`    output: ${firstText.text.slice(0, 60).replace(/\n/g, ' ')}`)
}
console.log('[check] parseTranscriptToTurns available for claude branch:', typeof parseTranscriptToTurns === 'function')
