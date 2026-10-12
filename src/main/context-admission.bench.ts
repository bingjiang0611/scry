import { afterAll, beforeAll, bench, describe } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAppSessionStore } from './app-store'
import { expectedSessionMatches } from './context-admission'

const sessionCount = 10_000
let userDataDir = ''
let store: ReturnType<typeof createAppSessionStore>

beforeAll(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'scry-admission-bench-'))
  store = createAppSessionStore(userDataDir)
  store.save(Array.from({ length: sessionCount }, (_, index) => ({
    sessionId: `session-${index}`, externalSessionId: `session-${index}`, runId: `run-${index}`,
    providerId: 'pi', cwd: '/benchmark', preview: `Request ${index}`, ts: index
  })))
  store.load()
})

afterAll(() => rmSync(userDataDir, { recursive: true, force: true }))

const catalogAliases = () => store.load()
  .filter((session) => session.providerId === 'pi' && session.cwd === '/benchmark' && session.runId)
  .map((session) => ({ runId: session.runId!, externalSessionId: session.externalSessionId, sessionId: session.sessionId }))

// Isolate the three session checks in agent:start. This is not an end-to-end TTFT benchmark.
describe(`session admission (${sessionCount} cached catalog entries, three checks)`, () => {
  bench('before: eagerly load aliases for a native session id', () => {
    for (let check = 0; check < 3; check++) {
      const aliases = catalogAliases()
      if (!expectedSessionMatches('session-9999', 'session-9999', () => aliases)) throw new Error('admission failed')
    }
  })

  bench('after: do not load aliases for a native session id', () => {
    for (let check = 0; check < 3; check++) {
      if (!expectedSessionMatches('session-9999', 'session-9999', catalogAliases)) throw new Error('admission failed')
    }
  })

  bench('alias resolution still reads the current catalog', () => {
    for (let check = 0; check < 3; check++) {
      if (!expectedSessionMatches('run-9999', 'session-9999', catalogAliases)) throw new Error('admission failed')
    }
  })
})
