import { useState } from 'react'
import type { WorkspaceFileSnapshot } from '../../src/shared/workspace'
import { WorkspacePanel } from '../../src/renderer/components/WorkspacePanel'

// In-memory file transport only. No real workspace or preload writes.
const initialContent = '# Preview first\n\nReadable **Markdown**.'
let savedContent = initialContent
const snapshot = (path: string, content: string): WorkspaceFileSnapshot => ({
  name: path, path, content, size: content.length, mtimeMs: 0, revision: content, language: 'markdown'
})
Object.defineProperty(window, 'scry', { value: {
  workspaceList: async () => ({ entries: [], truncated: false }),
  workspaceRead: async ({ path }) => {
    if (path === 'large.md') throw new Error('分页只读视图')
    return snapshot(path, path === 'notes.txt' ? 'Plain text' : savedContent)
  },
  workspaceReadKnown: async ({ path }) => snapshot(path, initialContent),
  workspaceReadPage: async ({ path }) => ({
    name: path, path, content: '# Paged source', offset: 0, nextOffset: 14,
    totalBytes: 14, hasMore: false, snapshot: 'page', language: 'markdown'
  }),
  workspaceWrite: async ({ path, content, expectedRevision }) => {
    if (expectedRevision !== savedContent) throw new Error('Revision mismatch')
    savedContent = content
    return snapshot(path, content)
  }
} satisfies Pick<Window['scry'], 'workspaceList' | 'workspaceRead' | 'workspaceReadKnown' | 'workspaceReadPage' | 'workspaceWrite'> })

export function WorkspacePreviewFixture() {
  const [request, setRequest] = useState({ id: 1, cwd: '/synthetic', path: 'preview.md' })
  const [dirty, setDirty] = useState(false)
  return <section id="workspace-fixture" hidden style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--bg)' }} data-dirty={dirty}>
    <nav style={{ height: 32 }}>
      {['preview.md', 'second.MDX', 'notes.txt', 'readonly.md', 'large.md'].map((path) =>
        <button key={path} data-file={path} onClick={() => setRequest({
          id: request.id + 1, cwd: path === 'readonly.md' ? '/external' : '/synthetic', path
        })}>{path}</button>
      )}
    </nav>
    <div style={{ height: 'calc(100% - 32px)', containerType: 'inline-size' }}>
      <WorkspacePanel cwd="/synthetic" openRequest={request} onClose={() => {}} onAddReference={() => {}} onDirtyChange={setDirty} />
    </div>
  </section>
}
