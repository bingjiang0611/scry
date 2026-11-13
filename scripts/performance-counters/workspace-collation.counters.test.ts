import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { populateWorkspaceFixture } from '../performance-baseline-fixture'
import { runWorkspaceFilesWorkload } from '../performance-baseline-scenarios'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'

interface Counts { collationSetups: number; nameComparisons: number }
let workspace: string
const samples: Counts[] = []

// ECMA-402 String.localeCompare with options initializes a collator per request.
// Count that setup and explicit Intl.Collator construction, not just one spelling
// of comparison. Both comparison APIs are counted separately from setup work.
async function countCollation(extraSetup = false): Promise<Counts> {
  const counts = { collationSetups: 0, nameComparisons: 0 }
  const NativeCollator = Intl.Collator
  const nativeCompare = Object.getOwnPropertyDescriptor(NativeCollator.prototype, 'compare')!.get!
  const nativeLocaleCompare = String.prototype.localeCompare
  const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (this: string, other, locales, options) {
    counts.nameComparisons++
    if (options !== undefined) counts.collationSetups++
    return nativeLocaleCompare.call(this, other, locales, options)
  })
  const compare = vi.spyOn(NativeCollator.prototype, 'compare', 'get').mockImplementation(function (this: Intl.Collator) {
    const bound = nativeCompare.call(this) as (left: string, right: string) => number
    return (left: string, right: string) => { counts.nameComparisons++; return bound(left, right) }
  })
  const constructor = vi.spyOn(Intl, 'Collator').mockImplementation(function (locales, options) {
    counts.collationSetups++
    return new NativeCollator(locales, options)
  })
  try {
    // Reuse the entire formal workload and its oracles: directory=122,
    // whole-file read/write=1MiB, page=64KiB. No reduced sorting-only fixture.
    await runWorkspaceFilesWorkload(workspace)
    if (extraSetup) new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
    expect(counts.nameComparisons).toBeGreaterThan(0)
    expect(counts.collationSetups).toBeGreaterThan(0)
    return counts
  } finally { constructor.mockRestore(); compare.mockRestore(); localeCompare.mockRestore() }
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'scry-workspace-collation-'))
  populateWorkspaceFixture(workspace)
})

describe('workspace file collation work counters', () => {
  for (let index = 0; index < defaultRepeats; index++) it(`repeat ${index + 1}`, async () => {
    samples.push(await countCollation())
  })

  it('detects one redundant collation setup without changing the workload or comparisons', async () => {
    const once = await countCollation()
    const extra = await countCollation(true)
    expect(extra.nameComparisons).toBe(once.nameComparisons)
    expect(extra.collationSetups).toBe(once.collationSetups + 1)
  })
})

afterAll(async () => {
  try {
    if (samples.length !== defaultRepeats) return
    const runs = await repeatCounters(defaultRepeats, index => Promise.resolve(samples[index]))
    const meta = {
      scenario: 'workspace.files', layer: 'main' as const, unit: 'count' as const,
      workload: 'directory=122;file=1MiB;page=64KiB;list=1;read=1;page=1;write=1',
      source: 'formal workspace.files production workload; pass-through spies count optioned localeCompare and explicit Intl.Collator setup, plus comparisons through either API'
    }
    writeCollector('workspace-collation', Object.entries(runs).map(([metric, values]) => measured({ ...meta, metric }, values)))
  } finally { if (workspace) rmSync(workspace, { recursive: true, force: true }) }
})
