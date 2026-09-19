import { afterAll, beforeAll, bench, describe } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TraceArchive } from './transcript-archive'
import { hydrateSessionHistoryPage, mergeSessionTurns, sessionHistoryPage } from './session-history'

const TURN_COUNT = Number(process.env.BENCH_TURNS ?? 4_000)
let userDataDir = ''
let archive: TraceArchive
const transcript = Array.from({ length: TURN_COUNT }, (_, index) => ({
  providerTurnId: `provider-${index}`,
  userText: `request ${index}`,
  items: [{
    id: `message-${index}`,
    ts: new Date(index * 1_000).toISOString(),
    runId: `run-${index}`,
    kind: 'model' as const,
    stage: 'text',
    text: `answer ${index}`
  }]
}))

beforeAll(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'scry-history-bench-'))
  const imageBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(1024, 1)
  ])
  for (let index = 0; index < TURN_COUNT; index++) {
    const directory = join(userDataDir, 'attachments', `run-${index}`)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'image.png'), imageBytes)
  }
  archive = {
    version: 3,
    cwd: '/benchmark',
    sessionId: 'benchmark-session',
    providerId: 'claude',
    turns: transcript.map((turn, index) => ({
      runId: `run-${index}`,
      providerTurnId: turn.providerTurnId,
      userText: `${turn.userText}\n\nScry pasted image attachments:\n1. image.png (image/png, 1 KB) local copy: ${join(userDataDir, 'attachments', `run-${index}`, 'image.png')}`,
      items: [],
      done: true,
      ts: index
    }))
  }
})

afterAll(() => rmSync(userDataDir, { recursive: true, force: true }))

describe(`session history (${TURN_COUNT} turns, 40 visible)`, () => {
  bench('eagerly hydrate the complete history', () => {
    sessionHistoryPage(mergeSessionTurns(transcript, archive, { userDataDir }), { limit: 40 })
  })

  bench('defer attachment hydration until after paging', () => {
    const merged = mergeSessionTurns(transcript, archive, { userDataDir }, { hydrateAttachments: false })
    hydrateSessionHistoryPage(sessionHistoryPage(merged, { limit: 40 }), transcript, archive, { userDataDir })
  })
})
