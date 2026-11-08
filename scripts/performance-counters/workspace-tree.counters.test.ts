import { afterAll, describe, expect, it } from 'vitest'
import type { WorkspaceEntry } from '../../src/shared/workspace'
import {
  filterWorkspaceTreePaths, workspaceTreeAncestors, workspaceTreeEntries
} from '../../src/renderer/workspace-tree'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'

// Fixed 1,000-file workspace: 40 loaded directories of 25 files. One component update is
// one index for a children change, the initial unfiltered publish, then one keystroke.
// These counts describe Scry's projection only; @pierre/trees row virtualization and mount
// cost are measured by the native fixture (scripts/pierre-views-ui-smoke.mjs --measure).
const directories = Array.from({ length: 40 }, (_, index) => `dir-${String(index).padStart(2, '0')}`)
const files = directories.flatMap((directory, directoryIndex) => Array.from({ length: 25 }, (_, fileIndex) => {
  const name = `file-${String(directoryIndex * 25 + fileIndex).padStart(3, '0')}.ts`
  return { path: `${directory}/${name}`, name, kind: 'file' as const, mtimeMs: 1 }
}))
const children: Record<string, WorkspaceEntry[]> = {
  '': directories.map(path => ({ path, name: path, kind: 'directory' as const, mtimeMs: 1 })),
  ...Object.fromEntries(directories.map((directory, index) => [directory, files.slice(index * 25, index * 25 + 25)]))
}
// 'file-01' matches file-010..file-019 in dir-00, so both the published list and the
// revealed-parent list stay small and exactly predictable.
const query = '  FILE-01 '
const matched = Array.from({ length: 10 }, (_, index) => `dir-00/file-${String(10 + index).padStart(3, '0')}.ts`)

interface Counts { childrenReads: number; entriesIndexed: number; nameReads: number }

function instrument(record: Record<string, WorkspaceEntry[]>, counts: Counts) {
  const instrumentEntry = (entry: WorkspaceEntry): WorkspaceEntry => new Proxy(entry, {
    get(target, property, receiver) {
      if (property === 'name') counts.nameReads += 1
      return Reflect.get(target, property, receiver)
    }
  })
  return new Proxy(record, {
    get(target, property, receiver) {
      counts.childrenReads += 1
      const value = Reflect.get(target, property, receiver) as WorkspaceEntry[] | undefined
      // Count the entries the projection actually walks, not the map's final size:
      // a repeated index pass re-walks every entry and must show up here.
      counts.entriesIndexed += value?.length ?? 0
      return value?.map(instrumentEntry)
    }
  })
}

function update() {
  const counts: Counts = { childrenReads: 0, entriesIndexed: 0, nameReads: 0 }
  const entries = workspaceTreeEntries(instrument(children, counts))
  const initial = filterWorkspaceTreePaths(entries, '')
  const filtered = filterWorkspaceTreePaths(entries, query)
  const ancestors = workspaceTreeAncestors(filtered)
  expect(entries.size).toBe(1_040)
  expect(initial).toHaveLength(1_040)
  expect(filtered).toEqual(matched)
  expect(ancestors).toEqual(Array.from({ length: 10 }, () => 'dir-00/'))
  return {
    childrenReads: counts.childrenReads,
    entriesIndexed: counts.entriesIndexed,
    nameReads: counts.nameReads,
    pathsPublished: initial.length + filtered.length,
    ancestorsRevealed: ancestors.length
  }
}

const samples: Array<ReturnType<typeof update>> = []

describe('workspace tree projection counters', () => {
  for (let index = 0; index < defaultRepeats; index++) it(`repeat ${index + 1}`, () => {
    samples.push(update())
  })

  it('is sensitive to a second unchanged index pass', () => {
    const once = update()
    const counts: Counts = { childrenReads: 0, entriesIndexed: 0, nameReads: 0 }
    workspaceTreeEntries(instrument(children, counts))
    workspaceTreeEntries(instrument(children, counts))
    expect(counts.childrenReads).toBeGreaterThan(2 * once.childrenReads - 1)
    expect(counts.entriesIndexed).toBeGreaterThan(once.entriesIndexed)
  })

  it('is sensitive to a filter that stops filtering', () => {
    const once = update()
    const entries = workspaceTreeEntries(children)
    // The pre-fix behavior: the query is ignored, so every keystroke republishes all paths.
    const unfiltered = filterWorkspaceTreePaths(entries, '').length + filterWorkspaceTreePaths(entries, '').length
    expect(filterWorkspaceTreePaths(entries, '')).toHaveLength(1_040)
    expect(unfiltered).toBeGreaterThan(once.pathsPublished)
  })

  it('reads every entry name exactly once for the keystroke and none for the initial publish', () => {
    const counts: Counts = { childrenReads: 0, entriesIndexed: 0, nameReads: 0 }
    const entries = workspaceTreeEntries(instrument(children, counts))
    filterWorkspaceTreePaths(entries, '')
    expect(counts.nameReads).toBe(0)
    filterWorkspaceTreePaths(entries, query)
    expect(counts.nameReads).toBe(entries.size)
  })

  afterAll(async () => {
    // A focused run (or a failing repeat) must not publish a partial collector artifact.
    if (samples.length !== defaultRepeats) return
    const runs = await repeatCounters(defaultRepeats, index => Promise.resolve(samples[index]))
    const meta = {
      scenario: 'workspace.tree',
      layer: 'ui' as const,
      workload: 'directories=40;files=1000;query=file-01;index=1;filter=2',
      source: 'production workspaceTreeEntries/filterWorkspaceTreePaths/workspaceTreeAncestors with pass-through proxies counting children and name reads'
    }
    writeCollector('workspace-tree', Object.entries(runs).map(([metric, values]) => measured({
      ...meta,
      metric,
      unit: 'count' as const,
      source: metric === 'ancestorsRevealed'
        ? 'expansion paths handed to Pierre resetPaths; one entry per match, as production emits'
        : metric === 'pathsPublished'
          ? 'model paths handed to Pierre resetPaths for the initial publish plus one keystroke'
          : meta.source
    }, values)))
  })
})
