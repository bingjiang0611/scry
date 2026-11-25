import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { transcriptPath } from '../main/transcript-archive'
import { createAppSessionStore } from '../main/app-store'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { createCatalogScanWork } from './orchestration-catalog-scan'
import { createOrchestrationCatalogAccess } from './orchestration-catalog-access'

// R13: the receipt id was keyed on the payload alone, so content that changed A → B → A looked like the
// same command twice and the second change was dropped as a duplicate.
it('records a change even when the content returns to an earlier state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scry-daemon-catalog-scan-aba-'))
  const userDataDir = join(root, 'userData')
  const homeDir = join(root, 'home')
  mkdirSync(join(root, '项目'))
  const cwd = realpathSync(join(root, '项目'))
  const sessionId = '1f9a6c2d-70a8-4b6e-9f3b-77e2c5a41d11'
  const transcript = transcriptPath(cwd, sessionId, homeDir)
  mkdirSync(dirname(transcript), { recursive: true })
  const line = (text: string) => `${JSON.stringify({ cwd, sessionId, type: 'user', message: { role: 'user', content: text } })}\n`
  const a = line('同样的内容')
  const b = line('中间的内容')
  writeFileSync(transcript, a)
  const sink = EventSink.open({ userDataDir, fullfsync: false })
  try {
    const work = createCatalogScanWork({
      sink, homeDir, userDataDir, workspaces: () => [cwd],
      isActive: () => false, log: (message) => { throw new Error(message) }
    })
    const access = createOrchestrationCatalogAccess(() => sink)
    const app = createAppSessionStore(userDataDir, access.beforeMirrorWrite)
    const run = { cwd, providerId: 'claude' as const, runId: 'scry-run', runtimeProvider: 'claude_sdk' as const, prompt: '问题' }
    app.recordPending(run)
    app.record({ ...run, externalSessionId: sessionId })
    await work.scanCatalog()
    const discovered = sink.listEvents().at(-1)!
    await work.scanDetail(discovered.sessionKey!, true)
    const afterA = sink.listEvents().length

    // A → B: a new content, recorded.
    writeFileSync(transcript, b)
    await work.scanDetail(discovered.sessionKey!, false)
    const afterB = sink.listEvents().length
    expect(afterB).toBeGreaterThan(afterA)

    // B → A: back to the first content. It is a new observation, not a duplicate command.
    writeFileSync(transcript, a)
    await work.scanDetail(discovered.sessionKey!, false)
    expect(sink.listEvents().length).toBeGreaterThan(afterB)
  } finally {
    sink.close()
    rmSync(root, { recursive: true, force: true })
  }
})
