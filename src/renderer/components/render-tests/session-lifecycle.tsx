import * as shared from './shared'
const { describe, it, expect, attachmentsAfterSuccessfulSubmit, adoptLocalStartSessionId, attachmentsAfterFailedSubmit, buildForkSessionRequest, applyNewConversationEffects, applyProviderCatalogRefresh, applySessionArchiveEffects, commitDraftOnDispatch, dequeueStartedPrompt, enqueuePrompt, inputAfterFailedSubmit, inputAfterSuccessfulSubmit, migrateSessionPromptQueue, sessionComposerDraftKey, scrollChatTargetIntoView, shouldQueuePrompt, nextDrainableQueuedPrompt, chatBottomDistance, chatBottomStickinessAfterScroll, isChatNearBottom, scrollChatToBottomIfNeeded, imageFilesFromClipboardData } = shared

describe('AssistantTurn 渲染：trace 树 / footer / 文件足迹', () => {
  it('Provider 捕获真实 sessionId 时迁移队列且保持 FIFO', () => {
    const provisionalKey = sessionComposerDraftKey({ providerId: 'pi', cwd: '/repo', sessionId: 'run-1' })
    const capturedKey = sessionComposerDraftKey({ providerId: 'pi', cwd: '/repo', sessionId: 'session-1' })
    const provisional = enqueuePrompt([], '先排入', [], { providerId: 'pi' })[0]
    const existing = enqueuePrompt([], '目标会话已有', [], { providerId: 'pi' })[0]
    const queues = new Map([[provisionalKey, [provisional]], [capturedKey, [existing]]])
    const migrated = migrateSessionPromptQueue(queues, provisionalKey, capturedKey)

    expect(migrated.has(provisionalKey)).toBe(false)
    expect(migrated.get(capturedKey)?.map((prompt) => prompt.text)).toEqual(['先排入', '目标会话已有'])
  })
it('Pi 分支请求保留当前 profile', () => {
    expect(buildForkSessionRequest({
      providerId: 'pi',
      sourceSessionId: 'session-1',
      sourceRunId: 'run-1',
      sourceProviderTurnId: 'turn-1',
      sourceForkTurnId: 'fork-1',
      permissionMode: 'default'
    }, 'pi:rotom')).toMatchObject({ providerId: 'pi', agentProfileId: 'pi:rotom' })
  })
it('运行中发送队列按 FIFO 取出，空消息不入队', () => {
    const image = { kind: 'image' as const, name: 'queued.png', mimeType: 'image/png' as const, dataBase64: 'aQ==' }
    const queue = enqueuePrompt(
      enqueuePrompt([], '  先做 A  ', [], {
        providerId: 'codex',
        model: { id: 'gpt-5.3-codex' },
        effort: 'high',
        permissionMode: 'default'
      }),
      '',
      [image],
      { providerId: 'claude', permissionMode: 'full_access' }
    )
    expect(enqueuePrompt(queue, '   ')).toHaveLength(2)
    expect(queue[0]).toMatchObject({
      text: '先做 A',
      attachments: [],
      request: {
        providerId: 'codex',
        model: { id: 'gpt-5.3-codex' },
        effort: 'high',
        permissionMode: 'default'
      }
    })
    const first = nextDrainableQueuedPrompt(queue, null)
    expect(first?.text).toBe('先做 A')
    expect(queue.slice(1)[0].attachments[0].name).toBe('queued.png')
    expect(dequeueStartedPrompt(queue, first!)).toEqual(queue.slice(1))
    expect(dequeueStartedPrompt(queue, { ...first! })).toBe(queue)
    expect(shouldQueuePrompt(false, queue.length, true)).toBe(true)
    expect(shouldQueuePrompt(false, queue.length, false)).toBe(true)
    expect(shouldQueuePrompt(false, 0, false)).toBe(false)
  })
it('发送一分派就提交草稿，失败时可恢复且不覆盖等待期间新增内容', async () => {
    let settle!: () => void
    const pending = new Promise<void>((resolve) => { settle = resolve })
    let commits = 0
    const dispatched = commitDraftOnDispatch(
      () => pending,
      () => { commits += 1 }
    )
    expect(commits).toBe(1)
    settle()
    await dispatched

    await expect(
      commitDraftOnDispatch(
        () => Promise.reject(new Error('start rejected')),
        () => { commits += 1 }
      )
    ).rejects.toThrow('start rejected')
    expect(commits).toBe(2)
    expect(inputAfterSuccessfulSubmit('原始草稿', '原始草稿')).toBe('')
    expect(inputAfterSuccessfulSubmit('原始草稿\n等待期间新增', '原始草稿')).toBe('等待期间新增')
    expect(inputAfterSuccessfulSubmit('完全改写', '原始草稿')).toBe('完全改写')
    expect(inputAfterFailedSubmit('', '原始草稿')).toBe('原始草稿')
    expect(inputAfterFailedSubmit('等待期间新增', '原始草稿')).toBe('原始草稿\n等待期间新增')

    const submitted = { id: 'sent', kind: 'image' as const, name: 'sent.png', mimeType: 'image/png' as const, dataBase64: 'aQ==', previewUrl: 'blob:sent' }
    const newer = { ...submitted, id: 'new', name: 'new.png', previewUrl: 'blob:new' }
    expect(attachmentsAfterSuccessfulSubmit([submitted, newer], new Set(['sent']))).toEqual([newer])
    expect(attachmentsAfterFailedSubmit([newer], [submitted])).toEqual([submitted, newer])
  })
it('打开会话时不会被历史内容替换产生的中间滚动事件取消粘底', () => {
    const middle = { scrollHeight: 1000, scrollTop: 420, clientHeight: 220 }
    expect(chatBottomDistance(middle)).toBe(360)
    expect(isChatNearBottom(middle)).toBe(false)
    expect(chatBottomStickinessAfterScroll(middle, true)).toBe(true)
    expect(chatBottomStickinessAfterScroll(middle, false)).toBe(false)

    let top = 0
    const scrolled = scrollChatToBottomIfNeeded(
      { ...middle, scrollTo: (options) => (top = options.top) },
      chatBottomStickinessAfterScroll(middle, true)
    )
    expect(scrolled).toBe(true)
    expect(top).toBe(1000)
  })
it('精确跳转把报错事件卡片定位到对话视口中间', () => {
    const calls: Array<{ top: number; behavior?: ScrollBehavior }> = []
    const chat = {
      scrollTop: 320,
      clientHeight: 600,
      getBoundingClientRect: () => ({ top: 100 }),
      scrollTo: (options: { top: number; behavior?: ScrollBehavior }) => calls.push(options)
    }
    const target = { getBoundingClientRect: () => ({ top: 460, height: 80 }) }

    scrollChatTargetIntoView(chat, target, 'smooth', 'center')

    expect(calls).toEqual([{ top: 420, behavior: 'smooth' }])
  })
it('手动刷新按 Provider 失效、Skill 回读、slash 重取的顺序执行', async () => {
    const calls: string[] = []

    await applyProviderCatalogRefresh({
      invalidateProviderContext: async () => { calls.push('invalidate') },
      refreshSkills: async () => { calls.push('skills') },
      retrySlash: () => calls.push('slash')
    })

    expect(calls).toEqual(['invalidate', 'skills', 'slash'])
  })
it('Provider catalog 刷新失败也会清除旧 slash cache，且不会阻塞新会话', async () => {
    const calls: string[] = []

    await expect(applyProviderCatalogRefresh({
      invalidateProviderContext: async () => { throw new Error('main unavailable') },
      refreshSkills: async () => { calls.push('skills'); throw new Error('preload unavailable') },
      retrySlash: () => calls.push('slash')
    })).resolves.toBeUndefined()

    expect(calls).toEqual(['skills', 'slash'])
  })
it('新建会话只脱离正在运行的会话，不调用 stop', async () => {
    const calls: string[] = []

    await applyNewConversationEffects({
      clearTurns: (options) => calls.push(`clear:${String(options?.preserveRunning)}`),
      newSession: async () => {
        calls.push('newSession')
        return true
      },
      refreshProviderCatalogs: async () => { calls.push('refreshCatalogs') },
      setActiveSessionId: (sessionId) => calls.push(`active:${String(sessionId)}`),
      setView: (view) => calls.push(`view:${view}`),
      focusComposer: () => calls.push('focus')
    })

    expect(calls).toEqual(['clear:undefined', 'newSession', 'active:null', 'view:chat', 'focus', 'refreshCatalogs'])
  })
it('只采纳本视图发起那一轮新建的原生 session id', () => {
    const starts = new Map([['run-2', 'run-1']])
    // 本地壳 run-1 上重新发送：run-2 拿到原生 session 后必须把当前会话身份换过去。
    expect(adoptLocalStartSessionId({ runId: 'run-2', sessionId: 'native-1' }, 'run-1', starts)).toBe('native-1')
    // 发送后用户已经切到其他会话：不能劫持当前视图。
    expect(adoptLocalStartSessionId({ runId: 'run-2', sessionId: 'native-1' }, 'other', starts)).toBeNull()
    // 不是本视图发起的轮次，或者身份本来就一致：不动。
    expect(adoptLocalStartSessionId({ runId: 'run-9', sessionId: 'native-9' }, 'run-1', starts)).toBeNull()
    expect(adoptLocalStartSessionId({ runId: 'run-2', sessionId: 'run-1' }, 'run-1', starts)).toBeNull()
    expect(adoptLocalStartSessionId({ runId: 'run-2' }, 'run-1', starts)).toBeNull()
  })
it('归档当前打开的会话后会回到新会话，避免后续发送被会话身份守卫拒绝', async () => {
    const calls: string[] = []

    await applySessionArchiveEffects({
      archive: async () => { calls.push('archive'); return true },
      archivingActiveSession: true,
      rememberUndo: () => calls.push('undo'),
      resetConversation: async () => { calls.push('reset') },
      reloadProjects: () => calls.push('reload')
    })
    expect(calls).toEqual(['archive', 'undo', 'reload', 'reset'])

    calls.length = 0
    await applySessionArchiveEffects({
      archive: async () => { calls.push('archive'); return true },
      archivingActiveSession: false,
      rememberUndo: () => calls.push('undo'),
      resetConversation: async () => { calls.push('reset') },
      reloadProjects: () => calls.push('reload')
    })
    expect(calls).toEqual(['archive', 'undo', 'reload'])

    calls.length = 0
    await applySessionArchiveEffects({
      archive: async () => { calls.push('archive'); return false },
      archivingActiveSession: true,
      rememberUndo: () => calls.push('undo'),
      resetConversation: async () => { calls.push('reset') },
      reloadProjects: () => calls.push('reload')
    })
    expect(calls).toEqual(['archive'])
  })
it('归档正在跑的当前会话也重置视图', async () => {
    const calls: string[] = []

    await applySessionArchiveEffects({
      archive: async () => { calls.push('archive'); return true },
      archivingActiveSession: true,
      rememberUndo: () => calls.push('undo'),
      resetConversation: async () => { calls.push('reset') },
      reloadProjects: () => calls.push('reload')
    })

    expect(calls).toEqual(['archive', 'undo', 'reload', 'reset'])
  })
it('剪贴板图片提取会去重 files/items 里的同一张图', () => {
    const png = { name: 'a.png', size: 1, type: 'image/png' } as File
    const text = { name: 'a.txt', size: 1, type: 'text/plain' } as File
    const files = imageFilesFromClipboardData({
      files: [png, text],
      items: [
        { kind: 'file', type: 'image/png', getAsFile: () => png },
        { kind: 'string', type: 'text/plain', getAsFile: () => text }
      ]
    })
    expect(files).toEqual([png])
  })


})