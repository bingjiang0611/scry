import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const MAIN = 'scripts/fixtures/concurrency-trace-live-electron.ts'

async function mainSource(): Promise<string> {
  return readFile(join(root, MAIN), 'utf8')
}

/** Body of `case '<name>': {`, up to the next case/default label. */
function caseBody(source: string, name: string): string {
  const start = source.indexOf(`    case '${name}': {`)
  expect(start).toBeGreaterThan(-1)
  const ends = [source.indexOf('\n    case ', start + 1), source.indexOf('\n    default:', start + 1)].filter((index) => index !== -1)
  return source.slice(start, ends.length > 0 ? Math.min(...ends) : source.length)
}

// Source contract only: these assertions cannot observe Electron's real lifetime, so they pin
// the shutdown ownership rule and nothing more. The runtime proof is the launcher's owner
// verdict (owned stop after the windows are gone) on a real run.
describe('concurrency trace live client main shutdown ownership', () => {
  it('keeps the process alive when the last window closes', async () => {
    // Both 'abandon' and 'close' destroy the last window, and Electron's default is to quit
    // then. Without this listener the owner captured no tree and reported "test App exited
    // before ownership capture" on a clean run.
    const source = await mainSource()
    const listener = /app\.on\('window-all-closed', \(\) => \{([\s\S]*?)\n\}\)/.exec(source)
    expect(listener).not.toBeNull()
    expect(listener?.[1] ?? '').not.toMatch(/app\.(quit|exit)\(/)
  })

  it('destroys peer windows without quitting in abandon and close', async () => {
    const source = await mainSource()
    const abandon = caseBody(source, 'abandon')
    const close = caseBody(source, 'close')
    expect(abandon).toMatch(/window\.destroy\(\)/)
    expect(close).toMatch(/window\.destroy\(\)/)
    expect(abandon).not.toMatch(/app\.(quit|exit)\(/)
    expect(close).not.toMatch(/app\.(quit|exit)\(/)
  })

  it('exits only through the owner SIGTERM handler', async () => {
    const source = await mainSource()
    expect(source.match(/app\.quit\(\)/g) ?? []).toHaveLength(1)
    expect(source).toMatch(/process\.on\('SIGTERM', \(\) => \{ app\.quit\(\) \}\)/)
  })
})
