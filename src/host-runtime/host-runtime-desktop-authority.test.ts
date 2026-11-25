import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// `authorizeSession` is optional on `createDesktopHostReader`, and the desktop lane
// throws `history_session_authority_unavailable` for *every* session-scoped read when
// it is missing — sends still work, history never displays. Nothing else in the unit
// suite mounts this assembly (the host smoke hardcodes its history claim), so guard the
// one wiring that must supply it.
const SOURCE = resolve(__dirname, 'host-runtime.ts')

function desktopReaderWiring(): string {
  const source = readFileSync(SOURCE, 'utf8')
  const start = source.indexOf('readDesktop: createDesktopHostReader({')
  if (start < 0) throw new Error('host runtime no longer wires the desktop reader')
  const end = source.indexOf('getRun:', start)
  if (end < 0) throw new Error('desktop reader wiring shape changed')
  return source.slice(start, end)
}

describe('host runtime desktop reads', () => {
  it('gives the desktop reader a catalog session authority', () => {
    const wiring = desktopReaderWiring()
    expect(wiring).toContain('authorizeSession:')
    expect(wiring).toContain('bindRemoteHistoryContext(')
    // Same catalog the history handlers bind: sessions plus canonical project roots.
    expect(wiring).toContain('runtime.appSessionStore().load()')
    expect(wiring).toContain('runtime.resolveRemoteProjectDirectory')
  })
})
