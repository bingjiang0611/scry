import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) }
})
import { defaultCapabilityCampaigns, runCapabilityCampaigns } from './session-capability-campaigns.mjs'

function fixture(failAt: string | null) {
  const directory = mkdtempSync(join(tmpdir(), 'scry capability campaigns '))
  const script = join(directory, 'record argv.mjs')
  const log = join(directory, 'argv.jsonl')
  writeFileSync(script, `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.argv[2] === ${JSON.stringify(failAt)}) process.exit(9)
`)
  return { directory, script, calls: () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) }
}

describe('bounded capability campaigns', () => {
  it('retains every fixture and follow-up from the former monolithic campaign', () => {
    // Summary mode includes workspace diff, summary sampling and the three core checks.
    expect(defaultCapabilityCampaigns).toEqual([
      '--motion-tokens-only', '--sidebar-activity-only', '--cache-only',
      '--meta-prompts-only', '--performance-only', '--summary-only',
      '--pi-commands-only', '--overview-only', '--selection-only',
      '--pi-permission-only', '--models-only', '--terminals-only'
    ])
  })

  it('dispatches every campaign with intact argument boundaries', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const control = fixture(null)
    const spawn = vi.mocked(spawnSync)
    spawn.mockClear()
    spawn.mockReturnValue({ status: 0, signal: null, pid: 1, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })
    try {
      expect(runCapabilityCampaigns(control.script)).toBe(0)
      expect(spawn.mock.calls).toEqual(defaultCapabilityCampaigns.map(mode => [process.execPath, [control.script, mode], { stdio: 'inherit' }]))
    } finally {
      spawn.mockImplementation(actual.spawnSync)
      rmSync(control.directory, { recursive: true, force: true })
    }
  })

  it('propagates a real child failure and does not run later campaigns', () => {
    const control = fixture('--motion-tokens-only')
    try {
      expect(runCapabilityCampaigns(control.script)).toBe(9)
      expect(control.calls()).toEqual([['--motion-tokens-only']])
    } finally { rmSync(control.directory, { recursive: true, force: true }) }
  })
})
