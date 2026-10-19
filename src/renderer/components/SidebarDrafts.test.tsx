import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionMeta } from '../env'
import { composerDraftKey, createComposerDraftStore, type ComposerDraft } from '../composer-drafts'
import { Sidebar } from './Sidebar'
import { SidebarRemoteProjects } from './SidebarRemoteProjects'
import { remoteDraftKey } from './RemoteChat'

const session: SessionMeta = {
  sessionId: 'local-id', externalSessionId: 'native-id', providerId: 'pi', agentProfileId: 'pi:rotom',
  mtime: 1, preview: 'Existing conversation', count: 1, runId: 'run-1'
}
const key = composerDraftKey({ providerId: 'pi', agentProfileId: 'pi:rotom', cwd: '/repo', sessionId: 'native-id' })
const textDraft: ComposerDraft = { input: 'Continue investigating', attachments: [] }
const imageDraft: ComposerDraft = { input: '', attachments: [{
  id: 'image', kind: 'image', name: 'image.png', mimeType: 'image/png', dataBase64: 'AA==', previewUrl: 'blob:image'
}] }
const noop = () => {}
const sidebar = (drafts: ReadonlyMap<string, ComposerDraft>, row = session, waiting = false) => renderToStaticMarkup(<Sidebar
  projects={[{ cwd: '/repo', name: 'repo', mtime: 1, sessions: [row] }]}
  activeCwd="/repo" activeSessionId="local-id" activeProviderId="pi" activeAgentProfileId="pi:rotom"
  draftStore={createComposerDraftStore(drafts)} runningRunIds={new Set(['run-1'])}
  waitingQuestionRunIds={new Set(waiting ? ['run-1'] : [])}
  onNewChat={noop} onPick={noop} onTogglePin={noop} onArchive={noop}
/>)

const group = {
  key: 'host:/repo', connection: {
    id: 'host', label: 'Host', hostId: 'host-id', anchorSHA256: 'anchor',
    ssh: { hostname: 'example.test', username: 'test', port: 22 }, state: 'connected' as const, expiresAt: 4102444800000
  },
  state: 'connected' as const, cwd: '/repo', name: 'repo', mtime: 1, canManage: true, canDelete: true, needsUpgrade: false,
  sessions: [{ sessionId: 'remote-local-id', externalSessionId: 'native-id', cwd: '/repo', providerId: 'pi' as const, label: 'Remote conversation', ts: 1, isActive: true }]
}
const remoteSidebar = (drafts: ReadonlyMap<string, ComposerDraft>) => renderToStaticMarkup(<SidebarRemoteProjects
  groups={[group]} active={null} collapsed={new Set()} draftStore={createComposerDraftStore(drafts)}
  onToggle={noop} onPickSession={noop} onNewProjectChat={noop}
/>)

describe('sidebar draft indicators', () => {
  it.each([textDraft, imageDraft])('shows text and attachment-only drafts before the native session title', draft => {
    const html = sidebar(new Map([[key, draft]]))
    expect(html).toContain('<span class="sb-draft">草稿</span><span class="sb-sesstext">Existing conversation</span>')
    expect(html).toContain('sb-sesstime')
    expect(html).toContain('sb-running')
  })

  it('does not mark empty or whitespace-only composers', () => {
    expect(sidebar(new Map())).not.toContain('sb-draft')
    expect(sidebar(new Map([[key, { input: ' \n\t', attachments: [] }]]))).not.toContain('sb-draft')
  })

  it('uses the Provider-native id, workspace, Provider and profile boundaries', () => {
    for (const foreignKey of [
      composerDraftKey({ providerId: 'pi', agentProfileId: 'pi:rotom', cwd: '/repo', sessionId: 'local-id' }),
      composerDraftKey({ providerId: 'pi', agentProfileId: 'pi:rotom', cwd: '/other', sessionId: 'native-id' }),
      composerDraftKey({ providerId: 'claude', agentProfileId: 'pi:rotom', cwd: '/repo', sessionId: 'native-id' }),
      composerDraftKey({ providerId: 'pi', agentProfileId: 'pi:other', cwd: '/repo', sessionId: 'native-id' }),
      remoteDraftKey('host', '/repo', 'native-id')
    ]) expect(sidebar(new Map([[foreignKey, textDraft]]))).not.toContain('sb-draft')
  })

  it('retains the draft for pinned and waiting-for-answer rows', () => {
    const html = sidebar(new Map([[key, textDraft]]), { ...session, pinnedAt: 1 }, true)
    expect(html).toContain('sb-draft')
    expect(html).toContain('sb-question-pending')
    expect(html).not.toContain('sb-sesstime')
  })

  it('marks logical conversations using their existing composer scope', () => {
    const draftStore = createComposerDraftStore(new Map([[composerDraftKey({ providerId: 'conversation', cwd: '/repo', sessionId: 'conversation' }), textDraft]]))
    const html = renderToStaticMarkup(<Sidebar projects={[{
      cwd: '/repo', name: 'repo', mtime: 1, sessions: [],
      conversations: [{ id: 'conversation', cwd: '/repo', title: 'Logical conversation', revision: 1, turnCount: 0 }]
    }]} draftStore={draftStore} activeCwd="/repo" onNewChat={noop} onPick={noop} onTogglePin={noop} onArchive={noop} />)
    expect(html).toContain('<span class="sb-draft">草稿</span><span class="sb-sesstext" title="/repo">Logical conversation</span>')
  })

  it('marks remote drafts without mixing another host or a local session', () => {
    expect(remoteSidebar(new Map([[remoteDraftKey('host', '/repo', 'native-id'), textDraft]]))).toContain('sb-draft')
    expect(remoteSidebar(new Map([[remoteDraftKey('other-host', '/repo', 'native-id'), textDraft]]))).not.toContain('sb-draft')
    expect(remoteSidebar(new Map([[key, textDraft]]))).not.toContain('sb-draft')
  })
})
