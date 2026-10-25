import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, EmptySessionOverview, MAX_SESSION_COMPOSER_DRAFTS, enqueuePrompt, failedSlashCatalog, focusedRunNeedsLoading, hasSessionOverviewContext, migrateSessionComposerDraft, migrateSessionPromptQueue, providerContextCacheKey, sessionComposerDraftKey, updateSessionComposerDraft, CliPicker } = shared
type SessionComposerDraft = shared.SessionComposerDraft

describe('Pi Profile renderer identity', () => {
  it('renders the selected and selectable agent ids into stable DOM attributes', () => {
    const html = renderToStaticMarkup(
      <CliPicker
        agents={[
          { id: 'pi:default', name: 'Pi', bin: 'pi', path: '/usr/local/bin/pi', version: '1.0.0' },
          { id: 'pi:0123456789abcdef', name: 'Pi · custom', bin: 'custom', path: '/opt/custom', version: '2.0.0' }
        ]}
        selectedId="pi:default"
        onSelect={() => undefined}
        onAddPi={() => undefined}
        onRemovePi={() => undefined}
        onRescan={() => undefined}
      />
    )

    expect(html).toContain('class="clibtn" data-agent-id="pi:default"')
  })

  it('isolates slash command caches by Pi profile as well as provider and cwd', () => {
    const native = providerContextCacheKey({ providerId: 'pi', agentProfileId: 'pi:default', cwd: '/repo' })
    const custom = providerContextCacheKey({ providerId: 'pi', agentProfileId: 'pi:0123456789abcdef', cwd: '/repo' })
    expect(native).not.toBe(custom)
    expect(native).toBe('pi\0pi:default\0/repo')
  })

  it('新建空会话不会继续渲染上一会话的 Overview 聚合证据', () => {
    expect(hasSessionOverviewContext(null, 0, false)).toBe(false)
    expect(hasSessionOverviewContext('session-1', 0, false)).toBe(true)
    expect(hasSessionOverviewContext(null, 1, false)).toBe(true)
    expect(hasSessionOverviewContext(null, 0, true)).toBe(true)

    const html = renderToStaticMarkup(<EmptySessionOverview />)
    expect(html).toContain('新会话暂无证据')
    expect(html).toContain('发送第一条消息后')
    expect(html).not.toContain('累计 Token 用量')
    expect(html).not.toContain('工作区未提交改动')
  })

  it('本地发送触发 focusedRun 时不闪现历史会话加载态', () => {
    expect(focusedRunNeedsLoading('run-1', true, new Set())).toBe(false)
    expect(focusedRunNeedsLoading('run-1', false, new Set(['run-1']))).toBe(false)
    expect(focusedRunNeedsLoading('run-1', false, new Set())).toBe(true)
  })

  it('已建立的会话隔离草稿，但新会话切换模型或 Provider 时保留输入', () => {
    const first = sessionComposerDraftKey({ providerId: 'claude', cwd: '/repo', sessionId: 'session-1' })
    const second = sessionComposerDraftKey({ providerId: 'claude', cwd: '/repo', sessionId: 'session-2' })
    let drafts: ReadonlyMap<string, SessionComposerDraft> = new Map()
    drafts = updateSessionComposerDraft(drafts, first, (draft) => ({ ...draft, input: '第一条草稿' }))
    drafts = updateSessionComposerDraft(drafts, second, (draft) => ({ ...draft, input: '第二条草稿' }))

    // A → B → A restores A rather than showing B or an empty composer.
    expect(drafts.get(first)?.input).toBe('第一条草稿')
    expect(drafts.get(second)?.input).toBe('第二条草稿')
    drafts = updateSessionComposerDraft(drafts, first, (draft) => ({ ...draft, input: '' }))
    expect(drafts.has(first)).toBe(false)
    expect(drafts.get(second)?.input).toBe('第二条草稿')
    drafts = updateSessionComposerDraft(drafts, first, (draft) => ({ ...draft, input: '第一条新草稿' }))
    expect(drafts.get(first)?.input).toBe('第一条新草稿')
    expect(drafts.get(second)?.input).toBe('第二条草稿')
    expect(sessionComposerDraftKey({ providerId: 'codex', cwd: '/repo', sessionId: 'session-1' })).not.toBe(first)
    expect(sessionComposerDraftKey({ providerId: 'claude', cwd: '/other', sessionId: 'session-1' })).not.toBe(first)

    const pendingClaude = sessionComposerDraftKey({ providerId: 'claude', cwd: '/repo', sessionId: null })
    const pendingCodex = sessionComposerDraftKey({ providerId: 'codex', cwd: '/repo', sessionId: null })
    const pendingPiProfile = sessionComposerDraftKey({
      providerId: 'pi',
      agentProfileId: 'pi:custom',
      cwd: '/repo',
      sessionId: null
    })
    expect(pendingCodex).toBe(pendingClaude)
    expect(pendingPiProfile).toBe(pendingClaude)
    expect(sessionComposerDraftKey({ providerId: 'claude', cwd: '/other', sessionId: null })).not.toBe(pendingClaude)
  })

  it('bounds session drafts with LRU eviction and releases evicted attachments', () => {
    let drafts: ReadonlyMap<string, SessionComposerDraft> = new Map()
    const evicted: string[] = []
    for (let index = 0; index <= MAX_SESSION_COMPOSER_DRAFTS; index++) {
      drafts = updateSessionComposerDraft(drafts, `session-${index}`, () => ({
        input: `draft-${index}`,
        attachments: [{ id: `attachment-${index}`, kind: 'image', name: 'image.png', mimeType: 'image/png', dataBase64: 'aQ==', previewUrl: `blob:${index}` }]
      }), (draft) => evicted.push(draft.attachments[0].id))
    }
    expect(drafts.size).toBe(MAX_SESSION_COMPOSER_DRAFTS)
    expect(drafts.has('session-0')).toBe(false)
    expect(evicted).toEqual(['attachment-0'])
  })

  it('migrates a provisional draft after switching away without overwriting the visible session', () => {
    const from = sessionComposerDraftKey({ providerId: 'claude', cwd: '/repo', sessionId: 'run-local' })
    const to = sessionComposerDraftKey({ providerId: 'claude', cwd: '/repo', sessionId: 'session-native' })
    const visible = sessionComposerDraftKey({ providerId: 'claude', cwd: '/repo', sessionId: 'session-visible' })
    const attachment = { id: 'draft', kind: 'image' as const, name: 'draft.png', mimeType: 'image/png' as const, dataBase64: 'aQ==', previewUrl: 'blob:draft' }
    const migrated = migrateSessionComposerDraft(new Map([
      [from, { input: 'next prompt', attachments: [attachment] }],
      [to, { input: 'older prompt', attachments: [] }],
      [visible, { input: 'visible draft', attachments: [] }]
    ]), from, to)
    const queued = enqueuePrompt([], 'queued follow-up')
    const visibleQueue = enqueuePrompt([], 'visible follow-up')
    const migratedQueues = migrateSessionPromptQueue(new Map([
      [from, queued],
      [visible, visibleQueue]
    ]), from, to)

    expect(migrated.has(from)).toBe(false)
    expect(migrated.get(to)).toEqual({ input: 'next prompt', attachments: [attachment] })
    expect(migrated.get(visible)?.input).toBe('visible draft')
    expect(migratedQueues.has(from)).toBe(false)
    expect(migratedQueues.get(to)).toEqual(queued)
    expect(migratedQueues.get(visible)).toEqual(visibleQueue)
  })

  it('removes rejected slash catalogs instead of leaving stale commands selectable', () => {
    const cache = new Map([['qoder\0\0/repo', { commands: [{ name: 'old' }], reason: null }]])

    expect(failedSlashCatalog<{ name: string }, { commands: Array<{ name: string }>; reason: null }>(
      cache,
      'qoder\0\0/repo',
      new Error('catalog unavailable')
    )).toEqual({ commands: [], reason: 'catalog unavailable' })
    expect(cache.size).toBe(0)
  })
})