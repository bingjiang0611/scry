import * as shared from './shared'
import { sessionSelectionAfterTurnDone } from '../../session-restore'
const { describe, it, expect, vi, activeRunForSession, sessionEvidenceGapAfterLoad, applySessionCapturedEffects, applyTurnDoneEffects, restoreActiveSessionSelection, restoreFocusedRunSelection } = shared
type ActiveRun = shared.ActiveRun
type AgentQuestionRequest = shared.AgentQuestionRequest
type ParsedTurn = shared.ParsedTurn
type SessionHistoryPage = shared.SessionHistoryPage
type SessionEvidenceGap = shared.SessionEvidenceGap

describe('App turnDone 集成契约：session 完成后刷新派生状态', () => {
  it('捕获新 sessionId 后立即刷新左侧项目树', () => {
    const calls: string[] = []

    applySessionCapturedEffects(
      { runId: 'run-1', sessionId: 'session-1', previousSessionId: 'run-1' },
      {
        activeSessionId: 'run-1',
        setActiveSessionId: (sessionId) => calls.push(`session:${sessionId}`),
        loadProjects: () => calls.push('loadProjects')
      }
    )

    expect(calls).toEqual(['session:session-1', 'loadProjects'])
  })

  it('只把匹配 cwd/provider/profile 与任一会话别名的未完成 run 恢复到所选会话', () => {
    const run = {
      runId: 'run-1',
      sessionId: 'catalog-session',
      externalSessionId: 'provider-session',
      providerId: 'pi' as const,
      agentProfileId: 'pi:default',
      cwd: '/repo/a',
      userText: 'work',
      items: [],
      done: false
    }

    for (const alias of ['run-1', 'catalog-session', 'provider-session']) {
      expect(activeRunForSession(run, '/repo/a', alias, 'pi', 'pi:default')).toBe(run)
    }
    expect(activeRunForSession([{ ...run, runId: 'other', sessionId: 'other', externalSessionId: 'other' }, run], '/repo/a', 'catalog-session', 'pi', 'pi:default')).toBe(run)
    expect(activeRunForSession(run, '/repo/b', 'catalog-session', 'pi', 'pi:default')).toBeNull()
    expect(activeRunForSession(run, '/repo/a', 'catalog-session', 'qoder')).toBeNull()
    expect(activeRunForSession(run, '/repo/a', 'catalog-session', 'pi', 'pi:other')).toBeNull()
    expect(activeRunForSession({ ...run, done: true }, '/repo/a', 'catalog-session', 'pi', 'pi:default')).toBeNull()
    expect(activeRunForSession({ ...run, cwd: undefined }, '', 'catalog-session', 'pi', 'pi:default')).toMatchObject({ runId: 'run-1' })
  })

  it('把一轮真实回合记成恢复点，但不在用户已切走的会话上覆盖', () => {
    const owner = { cwd: '/repo/a', providerId: 'qoder' as const, agentProfileId: undefined }
    const event = { runId: 'run-1', sessionId: 'catalog-1', externalSessionId: 'native-1' }
    // 本轮由当前视图发起（起始会话还停留在空态或同名 run/catalog/native 别名）时才记录。
    for (const previous of [null, 'run-1', 'catalog-1', 'native-1']) {
      expect(sessionSelectionAfterTurnDone(event, previous, owner)).toEqual({
        cwd: '/repo/a',
        sessionId: 'catalog-1',
        providerId: 'qoder',
        externalSessionId: 'native-1',
        agentProfileId: undefined
      })
    }
    // 缺少会话或工作区没有可记录的恢复点；切到别的会话则不得改写。
    expect(sessionSelectionAfterTurnDone({ runId: 'run-1' }, null, owner)).toBeNull()
    expect(sessionSelectionAfterTurnDone(event, null, { ...owner, cwd: null })).toBeNull()
    expect(sessionSelectionAfterTurnDone(event, 'other-session', owner)).toBeNull()
    // 事件里的 provider/profile 优先于发起时的选择，未知 provider 回落到 owner。
    expect(sessionSelectionAfterTurnDone({ ...event, providerId: 'pi', agentProfileId: 'pi:default' }, null, owner))
      .toMatchObject({ providerId: 'pi', agentProfileId: 'pi:default' })
    expect(sessionSelectionAfterTurnDone({ ...event, providerId: 'legacy_unknown' }, null, owner))
      .toMatchObject({ providerId: 'qoder' })
  })

  it('恢复 live run 时先加载同一 session 的已停止历史轮次', async () => {
    const calls: string[] = []
    const archived: ParsedTurn[] = [{ userText: '第一轮（已停止）', items: [] }]
    const archivedPage: SessionHistoryPage = {
      turns: archived,
      offset: 0,
      totalTurns: 1,
      hasOlder: false,
      completeness: 'complete'
    }
    const activeRun: ActiveRun = {
      runId: 'run-2',
      providerId: 'claude' as const,
      cwd: '/repo/a',
      externalSessionId: 'session-1',
      userText: '第二轮（运行中）',
      items: [],
      done: false
    }
    let replacement: { sessionId: string; parsed: ParsedTurn[]; activeRun: ActiveRun } | undefined
    let loadedPage: SessionHistoryPage | null | undefined

    const restored = await restoreActiveSessionSelection(
      {
        runId: activeRun.runId,
        sessionId: 'session-1',
        externalSessionId: 'session-1',
        cwd: '/repo/a',
        providerId: 'claude'
      },
      {
        prepareRunFocus: (runId) => calls.push(`prepare:${runId}`),
        adoptActiveRun: async (runId) => {
          calls.push(`adopt:${runId}`)
          return activeRun
        },
        loadSession: async (context) => {
          calls.push(`load:${context.externalSessionId}`)
          return archivedPage
        },
        replaceWithParsedSession: (sessionId, parsed, options) => {
          replacement = { sessionId, parsed, activeRun: options.activeRun }
        },
        onHistoryLoaded: (page) => { loadedPage = page }
      }
    )

    expect(restored).toBe(true)
    expect(calls).toEqual(['prepare:run-2', 'adopt:run-2', 'load:session-1'])
    expect(replacement).toEqual({ sessionId: 'session-1', parsed: archived, activeRun })
    expect(loadedPage).toBe(archivedPage)
  })

  it('历史加载取消或失败时不发布空历史，也不覆盖已恢复的 live 快照', async () => {
    const activeRun: ActiveRun = {
      runId: 'run-2', providerId: 'pi', cwd: '/repo/a',
      externalSessionId: 'session-1', userText: '正在执行', items: [], done: false
    }
    for (const message of ['session history request superseded', 'archive read failed']) {
      const replacements: ParsedTurn[][] = []
      const loaded: Array<SessionHistoryPage | null> = []
      const effects = {
        prepareRunFocus: () => {},
        adoptActiveRun: async () => activeRun,
        selectContext: () => {},
        loadSession: async (): Promise<SessionHistoryPage | null> => { throw new Error(message) },
        replaceWithParsedSession: (_id: string, turns: ParsedTurn[]) => { replacements.push(turns) },
        onHistoryLoaded: (page: SessionHistoryPage | null) => { loaded.push(page) }
      }
      await expect(restoreActiveSessionSelection({
        runId: activeRun.runId, sessionId: 'session-1', externalSessionId: 'session-1',
        cwd: '/repo/a', providerId: 'pi'
      }, effects)).rejects.toThrow(message)
      expect(replacements).toEqual([])
      expect(loaded).toEqual([])

      await expect(restoreFocusedRunSelection(activeRun, effects)).rejects.toThrow(message)
      // Only the initial live snapshot is applied; failure must not be coerced to a null page.
      expect(replacements).toEqual([[]])
    }
  })

  it('live run 的历史读取为空时仍把缺失状态交给当前会话，不回退成新会话', async () => {
    const activeRun: ActiveRun = {
      runId: 'run-2',
      providerId: 'pi',
      agentProfileId: 'pi:default',
      cwd: '/repo/a',
      externalSessionId: 'session-1',
      userText: '',
      items: [],
      done: false
    }
    let gap: SessionEvidenceGap | null = null

    await restoreActiveSessionSelection(
      {
        runId: activeRun.runId,
        sessionId: 'session-1',
        externalSessionId: 'session-1',
        cwd: '/repo/a',
        providerId: 'pi',
        agentProfileId: 'pi:default'
      },
      {
        prepareRunFocus: () => {},
        adoptActiveRun: async () => activeRun,
        loadSession: async () => null,
        replaceWithParsedSession: () => {},
        onHistoryLoaded: (page, live) => { gap = sessionEvidenceGapAfterLoad('session-1', page, live) }
      }
    )

    expect(gap).toMatchObject({ sessionId: 'session-1', status: 'unavailable' })
  })

  it.each([null, { turns: [], offset: 0, totalTurns: 0, hasOlder: false, completeness: 'complete' as const }])('有可读 live 内容时不把未归档误报成没有本机证据（%j）', async (page) => {
    const activeRun: ActiveRun = {
      runId: 'live-run', providerId: 'pi', cwd: '/repo', externalSessionId: 'live-session',
      userText: '已经提交的任务', items: [], done: false
    }
    let gap: SessionEvidenceGap | null | undefined
    const replace = vi.fn()
    await expect(restoreActiveSessionSelection({
      runId: activeRun.runId, sessionId: 'live-session', externalSessionId: 'live-session', cwd: '/repo', providerId: 'pi'
    }, {
      prepareRunFocus: () => {}, adoptActiveRun: async () => activeRun,
      loadSession: async () => page, replaceWithParsedSession: replace,
      onHistoryLoaded: (loaded, live) => { gap = sessionEvidenceGapAfterLoad('live-session', loaded, live) }
    })).resolves.toBe(true)
    expect(replace).toHaveBeenCalledWith('live-session', [], { activeRun, page })
    expect(gap).toBeNull()
    expect(sessionEvidenceGapAfterLoad('live-session', page, { ...activeRun, done: true })).not.toBeNull()
    expect(sessionEvidenceGapAfterLoad('live-session', page, { ...activeRun, userText: '' })).not.toBeNull()
  })

  it('preload 直接启动的新 focused run 会先绑定焦点，再恢复历史和待回答问题', async () => {
    const pendingQuestion: AgentQuestionRequest = {
      runId: 'run-claude',
      questionId: 'question-1',
      providerId: 'claude',
      questions: [{
        question: '继续执行？',
        header: '确认',
        multiSelect: false,
        options: [{ label: '继续', description: '继续当前任务' }]
      }]
    }
    const activeRun: ActiveRun = {
      runId: 'run-claude',
      providerId: 'claude',
      cwd: '/repo/claude',
      externalSessionId: 'session-claude',
      sessionId: 'session-claude',
      userText: '执行 Claude 任务',
      pendingQuestions: [pendingQuestion],
      items: [],
      done: false
    }
    const archived: ParsedTurn[] = [{ runId: 'older-run', userText: '上一轮', items: [], done: true }]
    const archivedPage: SessionHistoryPage = {
      turns: archived,
      offset: 0,
      totalTurns: 1,
      hasOlder: false,
      completeness: 'complete'
    }
    const calls: string[] = []
    let resolveHistory: ((page: SessionHistoryPage) => void) | undefined
    let replacement: { sessionId: string; parsed: ParsedTurn[]; activeRun: ActiveRun } | undefined

    const restoring = restoreFocusedRunSelection(activeRun, {
      prepareRunFocus: (runId) => calls.push(`prepare:${runId}`),
      selectContext: (context) => calls.push(`select:${context.providerId}:${context.cwd}:${context.sessionId}`),
      loadSession: async () => new Promise<SessionHistoryPage>((resolve) => {
        calls.push('load')
        resolveHistory = resolve
      }),
      replaceWithParsedSession: (sessionId, parsed, options) => {
        calls.push('replace')
        replacement = { sessionId, parsed, activeRun: options.activeRun }
      }
    })

    expect(calls).toEqual([
      'prepare:run-claude',
      'select:claude:/repo/claude:session-claude',
      'replace',
      'load'
    ])
    expect(replacement).toEqual({ sessionId: 'session-claude', parsed: [], activeRun })
    expect(replacement?.activeRun.pendingQuestions).toEqual([pendingQuestion])
    resolveHistory?.(archivedPage)
    await expect(restoring).resolves.toBe(true)
    expect(calls).toEqual([
      'prepare:run-claude',
      'select:claude:/repo/claude:session-claude',
      'replace',
      'load',
      'replace'
    ])
    expect(replacement).toEqual({ sessionId: 'session-claude', parsed: archived, activeRun })
  })

  it('focused run 恢复历史期间发生新的手工选择时，不用旧异步结果覆盖界面', async () => {
    const activeRun: ActiveRun = {
      runId: 'run-claude',
      providerId: 'claude',
      cwd: '/repo/claude',
      externalSessionId: 'session-claude',
      userText: '执行 Claude 任务',
      items: [],
      done: false
    }
    let current = true
    let resolveHistory: ((page: SessionHistoryPage | null) => void) | undefined
    const replacements: string[] = []
    const restoring = restoreFocusedRunSelection(activeRun, {
      prepareRunFocus: () => {},
      selectContext: () => {},
      loadSession: async () => new Promise<SessionHistoryPage | null>((resolve) => { resolveHistory = resolve }),
      replaceWithParsedSession: (sessionId) => replacements.push(sessionId),
      isCurrent: () => current
    })

    current = false
    resolveHistory?.(null)
    await expect(restoring).resolves.toBe(false)
    expect(replacements).toEqual(['session-claude'])
  })

  it('后台会话捕获或完成时只刷新列表，不抢走当前会话高亮', () => {
    const calls: string[] = []
    const effects = {
      activeSessionId: 'visible-session',
      setActiveSessionId: (sessionId: string) => calls.push(`session:${sessionId}`),
      loadProjects: () => calls.push('loadProjects')
    }

    applySessionCapturedEffects({ sessionId: 'background-session' }, effects)
    applyTurnDoneEffects(
      { sessionId: 'background-session' },
      { ...effects, refreshAfterTurn: () => calls.push('refreshAfterTurn') }
    )

    expect(calls).toEqual(['loadProjects', 'refreshAfterTurn', 'loadProjects'])
  })

  it('新建会话脱离后台 run 后，session 捕获和完成都不抢走空白草稿', () => {
    const calls: string[] = []
    const effects = {
      activeSessionId: null,
      setActiveSessionId: (sessionId: string) => calls.push(`session:${sessionId}`),
      loadProjects: () => calls.push('loadProjects')
    }

    applySessionCapturedEffects(
      { runId: 'background-run', sessionId: 'session-1', previousSessionId: 'background-run' },
      effects
    )
    applyTurnDoneEffects(
      { runId: 'background-run', sessionId: 'session-1' },
      { ...effects, refreshAfterTurn: () => calls.push('refreshAfterTurn') }
    )

    expect(calls).toEqual(['loadProjects', 'refreshAfterTurn', 'loadProjects'])
  })

  it('原生 sessionId 到达后把当前 provisional runId 原位升级', () => {
    const calls: string[] = []

    applySessionCapturedEffects(
      { runId: 'run-1', sessionId: 'session-1', previousSessionId: 'run-1' },
      {
        activeSessionId: 'run-1',
        setActiveSessionId: (sessionId) => calls.push(sessionId),
        loadProjects: () => {}
      }
    )

    expect(calls).toEqual(['session-1'])
  })

  it('SDK 返回 sessionId 时先记录 active session，再刷新 integrations 和项目列表', () => {
    const calls: string[] = []

    applyTurnDoneEffects(
      { sessionId: 'session-1' },
      {
        setActiveSessionId: (sessionId) => calls.push(`session:${sessionId}`),
        refreshAfterTurn: () => calls.push('refreshAfterTurn'),
        loadProjects: () => calls.push('loadProjects')
      }
    )

    expect(calls).toEqual(['session:session-1', 'refreshAfterTurn', 'loadProjects'])
  })

  it('SDK 未返回 sessionId 时仍刷新 usage/stats/billing/git/diag/MCP 和 projects', () => {
    const calls: string[] = []

    applyTurnDoneEffects(
      {},
      {
        setActiveSessionId: (sessionId) => calls.push(`session:${sessionId}`),
        refreshAfterTurn: () => calls.push('refreshAfterTurn'),
        loadProjects: () => calls.push('loadProjects')
      }
    )

    expect(calls).toEqual(['refreshAfterTurn', 'loadProjects'])
  })
})