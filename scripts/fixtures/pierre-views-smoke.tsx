import { useMemo, useState } from 'react'
import type { WorkerResponse } from '@pierre/diffs/worker'
import { createRoot } from 'react-dom/client'
import type { ScDiff } from '../../src/shared/source-control'
import type { ReadOnlyWorkspaceSource } from '../../src/renderer/workbench-api'
import { Patch } from '../../src/renderer/components/SourceControlPatch'
import { DiffFiles } from '../../src/renderer/components/DiffFiles'
import { StackedDiff } from '../../src/renderer/components/StackedDiff'
import type { DiffLayout } from '../../src/renderer/diff-stack'
import '../../src/renderer/components/diff-stack.css'
import { WorkspaceFileTree } from '../../src/renderer/components/WorkspaceFileTree'
import { WorkspacePanel } from '../../src/renderer/components/WorkspacePanel'
import '../../src/renderer/styles.css'

declare global {
  interface Window { __pierreWorkers: { url: string; messages: string[] }[] }
}
// Observe the real native transport. No worker, library response or highlighted output is mocked.
window.__pierreWorkers = []
const NativeWorker = window.Worker
window.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options)
    const evidence = { url: String(url), messages: [] as string[] }
    window.__pierreWorkers.push(evidence)
    this.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      evidence.messages.push(event.data.type === 'success' ? `success:${event.data.requestType}` : 'error')
    })
    this.addEventListener('error', () => evidence.messages.push('error'))
  }
}

const patch = '--- a/example.ts\n+++ b/example.ts\n@@ -4,2 +8,3 @@\n-const before = 1\n-const removed = 2\n+const after = 3\n+const added = 4\n+const final = 5\n'
const capturedFiles = [{ path: '/fixture/captured.ts', added: 1, deleted: 1,
  patch: '@@ -1,61 +1,61 @@\n' + Array.from({ length: 30 }, (_, index) => ` context-${index} ${'x'.repeat(160)}\n`).join('') + '-before\n+after\n' + Array.from({ length: 30 }, (_, index) => ` trailing-${index}\n`).join('') }]
const pressureFiles = Array.from({ length: 1000 }, (_, index) => {
  const count = index === 0 ? 2000 : 1
  return { path: `/fixture/pressure-${String(index).padStart(4, '0')}.txt`, added: count, deleted: 0,
    patch: `@@ -0,0 +1,${count} @@\n` + Array.from({ length: count }, (_, line) => `+${index === 0 ? 'pressure' : `file-${index}`}-line-${String(line).padStart(4, '0')}\n`).join('') }
})
const identityFiles = ['left', 'right'].map(side => ({ path: `/archive/${side}/shared.ts`, added: 1, deleted: 0,
  patch: `@@ -0,0 +1 @@\n+captured-${side}\n` }))
const copy = { identity: 'historical identity', patch: 'patch', truncated: 'truncated', binary: 'binary', raw: 'raw', workspace: 'workspace', stack: 'stack', stress: 'stress', treeEvents: 'tree events', refresh: 'refresh patch', readonly: 'readonly fixture' }

function Fixture() {
  const [mode, setMode] = useState<keyof typeof copy>('patch')
  const [layout, setLayout] = useState<DiffLayout>('unified')
  const [selected, setSelected] = useState(pressureFiles[0].path)
  const [refreshed, setRefreshed] = useState(false)
  const [comments, setComments] = useState<{ side: string; line: number }[]>([])
  const [treeEvents, setTreeEvents] = useState<{ kind: string; path: string }[]>([])
  const [reads, setReads] = useState<{ path: string; cursor?: string }[]>([])
  const source = useMemo<ReadOnlyWorkspaceSource>(() => ({
    workspaceList: async ({ path = '', cursor }) => {
      setReads(previous => [...previous, { path, cursor }])
      if (!path) return { entries: [{ path: 'src', name: 'src', kind: 'directory', mtimeMs: 1 }], truncated: false }
      return {
        entries: Array.from({ length: cursor ? 980 : 20 }, (_, index) => ({
          path: `src/file-${String(index + (cursor ? 20 : 0)).padStart(4, '0')}.ts`,
          name: `file-${String(index + (cursor ? 20 : 0)).padStart(4, '0')}.ts`, kind: 'file', mtimeMs: 1
        })),
        truncated: !cursor, ...(!cursor ? { nextCursor: 'page-2' } : {})
      }
    },
    workspaceReadPage: async ({ path }) => ({ name: path.split('/').at(-1)!, path, content: 'const readonly = true\n',
      offset: 0, nextOffset: 22, totalBytes: 22, hasMore: false, snapshot: 'fixture-snapshot', language: 'typescript' })
  }), [])
  const files = mode === 'identity' ? identityFiles : pressureFiles
  const diff: ScDiff = {
    patch: mode === 'raw' ? '@@ -1,99 +1,99 @@\n-before\n+after\n' : (refreshed ? patch.replace('const after = 3', 'const refreshed = 6') : patch),
    binary: mode === 'binary', truncated: mode === 'truncated'
  }
  return <main style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
    <nav>{(['patch', 'truncated', 'binary', 'raw', 'workspace', 'stack', 'stress', 'treeEvents', 'identity'] as const).map(value =>
      <button id={`mode-${value}`} key={value} onClick={() => { setComments([]); setRefreshed(false); setSelected(value === 'identity' ? identityFiles[0].path : pressureFiles[0].path); setMode(value) }}>{copy[value]}</button>)}<button id="refresh-patch" onClick={() => setRefreshed(true)}>{copy.refresh}</button></nav>
    <output id="comments">{JSON.stringify(comments)}</output>
    <output id="tree-events">{JSON.stringify(treeEvents)}</output>
    <output id="reads">{JSON.stringify(reads)}</output>
    <section style={{ display: 'flex', flex: 1, minHeight: 0, width: '100%' }}>
      {mode === 'treeEvents' ? <WorkspaceFileTree children={{ '': [{ path: 'document.ts', name: 'document.ts', kind: 'file', mtimeMs: 1 }] }}
        expanded={new Set()} query="" loading={new Set()} nextCursors={{}} onExpand={() => undefined} onMore={() => undefined}
        onOpen={entry => setTreeEvents(previous => [...previous, { kind: 'open', path: entry.path }])}
        onRename={entry => setTreeEvents(previous => [...previous, { kind: 'rename', path: entry.path }])}
        onContext={(event, entry) => { event.preventDefault(); setTreeEvents(previous => [...previous, { kind: 'context', path: entry.path }]) }} />
      : mode === 'workspace' ? <WorkspacePanel cwd="/fixture" readOnlySource={source} onClose={() => undefined} onAddReference={() => undefined} />
        : (mode === 'stress' || mode === 'identity') ? <>
          <DiffFiles files={files} selectedPath={selected} select={setSelected} scope="workspace" repoRoot={mode === 'identity' ? undefined : '/fixture'} />
          <StackedDiff key={mode} files={files} path={selected} jump={0} scope="workspace" layout={layout} setLayout={setLayout} />
        </> : mode === 'stack' ? <StackedDiff key={mode} files={capturedFiles} path="/fixture/captured.ts" jump={0} scope="turn" layout={layout} setLayout={setLayout} />
        : <Patch path="example.ts" diff={diff} onLine={(side, line) => setComments(previous => [...previous, { side, line }])} />}
    </section>
  </main>
}

document.documentElement.dataset.theme = 'dark'
createRoot(document.getElementById('root')!).render(<Fixture />)
