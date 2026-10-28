import { afterAll, describe, expect, it, vi } from 'vitest'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'

const io = vi.hoisted(() => ({ active: false, writes: 0, renames: 0 }))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      if (io.active) io.writes++
      return Reflect.apply(actual.writeFileSync, actual, args)
    }) as typeof actual.writeFileSync,
    renameSync: ((...args: Parameters<typeof actual.renameSync>) => {
      if (io.active) io.renames++
      return Reflect.apply(actual.renameSync, actual, args)
    }) as typeof actual.renameSync
  }
})

async function fixture() {
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { realpathSync } = await import('node:fs')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'scry-workspace-remember-'))
  const userData = join(root, 'user-data')
  const first = join(root, 'first')
  const second = join(root, 'second')
  await Promise.all([mkdir(userData), mkdir(first), mkdir(second)])
  return {
    root,
    userData: realpathSync(userData),
    first: realpathSync(first),
    second: realpathSync(second),
    rm: () => rm(root, { recursive: true, force: true })
  }
}

async function measure(operation: () => void): Promise<{ writes: number; renames: number }> {
  io.writes = 0
  io.renames = 0
  io.active = true
  try { operation() } finally { io.active = false }
  return { writes: io.writes, renames: io.renames }
}

const samples: Array<{ writes: number; renames: number }> = []

describe('consecutive project remember work', () => {
  for (let index = 0; index < defaultRepeats; index++) it(`repeat ${index + 1}`, async () => {
    const { createWorkspaceRuntime } = await import('../../src/main/bootstrap/workspace-runtime')
    const value = await fixture()
    try {
      const runtime = createWorkspaceRuntime({ appUserDataDir: value.userData, loadSessions: () => [] })
      runtime.rememberProject(value.first)
      const counts = await measure(() => runtime.rememberProject(value.first))
      expect(runtime.knownProjectDirectories().has(value.first)).toBe(true)
      samples.push(counts)
    } finally { await value.rm() }
  })

  it('is sensitive to an additional distinct project transition', async () => {
    const { createWorkspaceRuntime } = await import('../../src/main/bootstrap/workspace-runtime')
    const value = await fixture()
    try {
      const runtime = createWorkspaceRuntime({ appUserDataDir: value.userData, loadSessions: () => [] })
      runtime.rememberProject(value.first)
      const one = await measure(() => runtime.rememberProject(value.second))
      const two = await measure(() => {
        runtime.rememberProject(value.first)
        runtime.rememberProject(value.second)
      })
      expect(two.writes + two.renames).toBeGreaterThan(one.writes + one.renames)
    } finally { await value.rm() }
  })

  afterAll(async () => {
    expect(samples).toHaveLength(defaultRepeats)
    const runs = await repeatCounters(defaultRepeats, async index => ({
      'io.write.calls': samples[index].writes,
      'io.rename.calls': samples[index].renames
    }))
    const meta = {
      scenario: 'workspace.remember-consecutive',
      layer: 'main' as const,
      workload: 'same-canonical-project=2',
      source: 'pass-through node:fs counters around production createWorkspaceRuntime.rememberProject'
    }
    writeCollector('workspace-remember', Object.entries(runs).map(([metric, values]) => measured({
      ...meta,
      metric,
      unit: 'count' as const
    }, values)))
  })
})
