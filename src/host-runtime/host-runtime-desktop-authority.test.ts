import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Guard the desktop reader's session authority binding at host assembly.
// This is a source-wiring check, not an end-to-end behavior test.
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
