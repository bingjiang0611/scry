import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, AssistantTurn, RecorderContentPager, OverviewPanel, parseUnifiedDiff, TurnDiffReviewPanel, ev, turn, html } = shared
type TraceEvent = shared.TraceEvent
type Turn = shared.Turn

describe('AssistantTurn 渲染：trace 树 / footer / 文件足迹', () => {
  it('main 尚未返回 runId 时展示即时发送反馈而不暴露临时 ID', () => {
    const pendingHtml = renderToStaticMarkup(
      <AssistantTurn
        turn={{ runId: 'pending-run-1', pendingStart: true, userText: '立即发送', done: false, items: [] }}
        selectedId={null}
        onSelect={() => {}}
      />
    )
    expect(pendingHtml).toContain('正在发送')
    expect(pendingHtml).toContain('正在启动')
    expect(pendingHtml).not.toContain('pending-run-1')
  })
it('who 头根据 runtimeProvider 展示 CLI agent 名称', () => {
    const qoderTurn: Turn = {
      runId: 'run-qoder',
      userText: '当前处于哪个目录',
      done: true,
      items: [
        ev({
          id: 'q1',
          kind: 'model',
          stage: 'text',
          text: '在 /repo',
          runtimeProvider: 'qoder_cli'
        })
      ]
    }
    const qoderHtml = renderToStaticMarkup(<AssistantTurn turn={qoderTurn} selectedId={null} onSelect={() => {}} />)
    expect(qoderHtml).toContain('Qoder')
    expect(qoderHtml).toContain('run · run-qoder')
  })
it('文件工具证据同时渲染结构化操作与 Bash 推断读取', () => {
    expect(html).toContain('本轮文件（工具证据）')
    expect(html).toContain('probe.txt')
    const filesHtml = html.match(/<details class="files-summary"[\s\S]*?<\/details>/)?.[0] ?? ''
    expect(filesHtml).not.toContain('open=""')
    expect(filesHtml).not.toContain('Bash 触及')
    expect(filesHtml).toContain('bash-only.txt')
    expect(filesHtml).toContain('~R1')
    expect(filesHtml).toContain('<span class="fh-total">2</span>')
  })
it('有 turn_diff 时增强同一张卡，展示逐文件与汇总 +/- 行数', () => {
    const diffTurn: Turn = {
      ...turn,
      items: [
        ...turn.items,
        ev({
          id: 'turn-diff',
          kind: 'harness',
          stage: 'turn_diff',
          turnDiff: {
            version: 1,
            status: 'captured',
            files: [
              { path: '/repo/src/a.ts', added: 5, deleted: 3 },
              { path: '/repo/test/image.png', added: 0, deleted: 0, binary: true },
              { path: '/repo/test/b.ts', added: 2, deleted: 0 }
            ],
            repoRoot: '/repo',
            scope: '.',
            beforeAt: '2026-07-14T00:00:00.000Z',
            afterAt: '2026-07-14T00:00:01.000Z',
            captureMs: 8,
            cleanup: 'ok'
          }
        })
      ]
    }
    const diffHtml = renderToStaticMarkup(<AssistantTurn turn={diffTurn} selectedId={null} onSelect={() => {}} />)

    expect(diffHtml).toContain('本轮改动')
    expect(diffHtml).toContain('3 files')
    expect(diffHtml).toContain('>+7<')
    expect(diffHtml).toContain('>−3<')
    expect(diffHtml).toContain('src/a.ts')
    expect(diffHtml).toContain('test/b.ts')
    expect(diffHtml).toContain('binary')
    expect(diffHtml.indexOf('class="turn-flow"')).toBeLessThan(diffHtml.indexOf('class="files-summary diff"'))
    expect(diffHtml.match(/class="files-summary/g)).toHaveLength(1)
    const filesHtml = diffHtml.match(/<details class="files-summary diff"[\s\S]*?<\/details>/)?.[0] ?? ''
    expect(filesHtml).not.toContain('R ·')
  })
it('完整正文引用显示按需分页入口，不把 blob 内联进初始 DOM', () => {
    const html = renderToStaticMarkup(<RecorderContentPager label="output" contentRef={{
      storage: 'recorder-content-v1',
      sha256: 'a'.repeat(64),
      bytes: 900_000,
      encoding: 'utf8'
    }} />)
    expect(html).toContain('查看完整 output')
    expect(html).toContain('900,000 bytes')
    expect(html).not.toContain('完整 output · bytes')
  })
it('Edit 卡展示本次工具输入的 action-level +/-，并明确不是 Git 净改动', () => {
    const editTurn: Turn = {
      ...turn,
      items: [
        ev({
          id: 'edit-1',
          kind: 'tool',
          stage: 'tool:Edit',
          tool: 'Edit',
          fileOp: 'edit',
          filePath: '/repo/src/a.ts',
          input: { file_path: '/repo/src/a.ts', old_string: 'one\ntwo\n', new_string: 'ONE\nTWO\nTHREE\n' }
        })
      ]
    }
    const editHtml = renderToStaticMarkup(<AssistantTurn turn={editTurn} selectedId="edit-1" onSelect={() => {}} />)

    expect(editHtml).toContain('edit-lines')
    expect(editHtml).toContain('>+3<')
    expect(editHtml).toContain('>−2<')
    expect(editHtml).toContain('本次 Edit 工具输入：写入 new_string 3 行、替换掉 old_string 2 行')
    expect(editHtml).toContain('不是本轮 Git 净改动')
    // action-level 计数不得改写卡片语义：标题仍是工具名，不冒充「本轮改动」
    expect(editHtml).not.toContain('本轮改动')
  })
it('Edit 卡只在轮次结束且该文件真的在本轮快照里时才接到 Diff 面板', () => {
    const editEvent = ev({
      id: 'edit-1',
      kind: 'tool',
      stage: 'tool:Edit',
      tool: 'Edit',
      fileOp: 'edit',
      filePath: '/repo/src/a.ts',
      input: { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' }
    })
    const diffEvent = ev({
      id: 'turn-diff',
      kind: 'harness',
      stage: 'turn_diff',
      turnDiff: {
        version: 1,
        status: 'captured',
        files: [{ path: '/repo/src/a.ts', added: 1, deleted: 1 }],
        repoRoot: '/repo',
        scope: '.',
        beforeAt: '2026-08-10T00:00:00.000Z',
        afterAt: '2026-08-10T00:00:01.000Z',
        captureMs: 9,
        cleanup: 'ok'
      }
    })
    const linkTitle = '点开工具输入，同时在右侧 Diff 中定位该文件的本轮改动'

    const linked = renderToStaticMarkup(
      <AssistantTurn
        turn={{ ...turn, items: [editEvent, diffEvent] }}
        selectedId="edit-1"
        onSelect={() => {}}
        onOpenDiff={() => {}}
      />
    )
    expect(linked).toContain(linkTitle)

    // 运行中：本轮 Diff 还没定稿，不给假入口
    const running = renderToStaticMarkup(
      <AssistantTurn
        turn={{ ...turn, done: false, items: [editEvent, diffEvent] }}
        selectedId="edit-1"
        onSelect={() => {}}
        onOpenDiff={() => {}}
      />
    )
    expect(running).not.toContain(linkTitle)

    // 该文件没有净改动：不联动，但 action-level 计数仍照实显示
    const otherFile = renderToStaticMarkup(
      <AssistantTurn
        turn={{ ...turn, items: [editEvent, { ...diffEvent, turnDiff: { ...diffEvent.turnDiff!, files: [{ path: '/repo/src/b.ts', added: 1, deleted: 0 }] } }] }}
        selectedId="edit-1"
        onSelect={() => {}}
        onOpenDiff={() => {}}
      />
    )
    expect(otherFile).not.toContain(linkTitle)
    expect(otherFile).toContain('edit-lines')
  })
it('本轮 patch 可渲染右侧 Review，并正确计算 unified diff 行号', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -2,2 +2,3 @@',
      ' keep',
      '-old',
      '+new',
      '+more'
    ].join('\n')
    const lines = parseUnifiedDiff(patch)
    expect(lines.find((line) => line.text === ' keep')).toMatchObject({ oldLine: 2, newLine: 2 })
    expect(lines.find((line) => line.text === '-old')).toMatchObject({ oldLine: 3 })
    expect(lines.find((line) => line.text === '-old')?.newLine).toBeUndefined()
    expect(lines.find((line) => line.text === '+new')).toMatchObject({ newLine: 3 })
    expect(lines.find((line) => line.text === '+new')?.oldLine).toBeUndefined()

    const reviewHtml = renderToStaticMarkup(
      <TurnDiffReviewPanel
        onClose={() => {}}
        review={{
          runId: 'run-review',
          userText: '修改 a.ts',
          turnDiff: {
            version: 1,
            status: 'captured',
            files: [{ path: '/repo/src/a.ts', added: 2, deleted: 1, patch, patchStatus: 'captured' }],
            repoRoot: '/repo',
            scope: '.',
            beforeAt: 'a',
            afterAt: 'b',
            captureMs: 8,
            cleanup: 'ok'
          }
        }}
      />
    )
    expect(reviewHtml).toContain('Review')
    expect(reviewHtml).toContain('src/a.ts')
    expect(reviewHtml).not.toContain('diff-file-head')
    expect(reviewHtml).toContain('unified-diff')
    expect(reviewHtml).toContain('+new')
  })
it('新轮 capture timeout 时保留旧文件足迹并诚实标记行数不可用', () => {
    const timeoutTurn: Turn = {
      ...turn,
      items: [
        ...turn.items,
        ev({
          id: 'turn-diff-timeout',
          kind: 'harness',
          stage: 'turn_diff',
          turnDiff: {
            version: 1,
            status: 'timeout',
            reason: 'deadline',
            files: [],
            beforeAt: '2026-07-14T00:00:00.000Z',
            afterAt: '2026-07-14T00:00:03.000Z',
            captureMs: 3000,
            cleanup: 'ok'
          }
        })
      ]
    }
    const timeoutHtml = renderToStaticMarkup(<AssistantTurn turn={timeoutTurn} selectedId={null} onSelect={() => {}} />)

    expect(timeoutHtml).toContain('本轮文件（工具证据）')
    expect(timeoutHtml).toContain('Git 差异采集超时')
    expect(timeoutHtml).not.toContain('± —')
    expect(timeoutHtml).toContain('精确行数不可用：deadline')
    expect(timeoutHtml).toContain('probe.txt')
  })
it('本轮 Hook 位于输出之后、本轮文件之前，并复用逻辑调用聚合', () => {
    const outputIndex = html.indexOf('class="model-text md"')
    const hookIndex = html.indexOf('class="turn-hooks-summary"')
    const filesIndex = html.indexOf('class="files-summary"')

    expect(outputIndex).toBeGreaterThan(-1)
    expect(hookIndex).toBeGreaterThan(outputIndex)
    expect(filesIndex).toBeGreaterThan(hookIndex)
    expect(html).toContain('本轮 Hook')
    expect(html).not.toContain('<details class="turn-hooks-summary" open="">')
    expect(html).toContain('1 个处理器实例')
    expect(html).toContain('branch-check-hook.sh')
    expect(html).toContain('PreToolUse')
    expect(html).toContain('成功 1')
    expect(html.match(/class="turn-hook-row"/g)).toHaveLength(1)
    expect(html).not.toContain('Hook 执行')
    expect(html).not.toContain('执行命令')
    expect(html).not.toContain('$CLAUDE_PROJECT_DIR/.claude/scripts/branch-check-hook.sh')
    expect(html.match(/branch ok/g)).toHaveLength(1)
    expect(html).not.toContain('hook_response')
  })
it('本轮 Hook 按生命周期分组，并在周期内聚合同一处理器的调用次数', () => {
    const eventRouter = 'python3 /repo/.claude/hooks/event_router.py'
    const pair = (
      id: string,
      event: string,
      trigger: string,
      command: string,
      ts: string
    ): TraceEvent[] => [
      ev({ id: `${id}-start`, ts, kind: 'hook', stage: 'hook_started', hookId: id, hookEvent: event, hookName: trigger, hookCommand: command }),
      ev({ id: `${id}-response`, ts, kind: 'hook', stage: 'hook_response', hookId: id, hookEvent: event, hookName: trigger, hookCommand: command, hookOutcome: 'success' })
    ]
    const lifecycleTurn: Turn = {
      runId: 'run-hook-lifecycle',
      userText: '检查 Hook 周期',
      done: true,
      items: [
        ev({ id: 'bash', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'bash' }),
        ev({ id: 'read', kind: 'tool', stage: 'tool:Read', tool: 'Read', toolUseId: 'read' }),
        ...pair('stop-router', 'Stop', 'Stop', eventRouter, '2026-08-05T11:43:14.621Z'),
        ...pair('stop-goal', 'Stop', 'Stop', 'goal-loop-stop', '2026-08-05T11:43:14.622Z'),
        ...pair('stop-entry', 'Stop', 'Stop', 'hook_entry', '2026-08-05T11:43:14.623Z'),
        ...pair('stop-pilot', 'Stop', 'Stop', 'qoder-loongsuite-pilot-hook.sh', '2026-08-05T11:43:14.624Z'),
        ...pair('post-read', 'PostToolUse', 'PostToolUse:Read', eventRouter, '2026-08-05T11:42:12.670Z'),
        ...pair('pre-bash', 'PreToolUse', 'PreToolUse:Bash', eventRouter, '2026-08-05T11:40:12.163Z'),
        ...pair('post-bash', 'PostToolUse', 'PostToolUse:Bash', eventRouter, '2026-08-05T11:40:12.830Z')
      ]
    }

    const hookHtml = renderToStaticMarkup(<AssistantTurn turn={lifecycleTurn} selectedId={null} onSelect={() => {}} />)
    const pre = hookHtml.indexOf('class="hook-phase-event">PreToolUse')
    const post = hookHtml.indexOf('class="hook-phase-event">PostToolUse')
    const stop = hookHtml.indexOf('class="hook-phase-event">Stop')
    const postPhaseHtml = hookHtml.slice(post, stop)

    expect(hookHtml).toContain('3 个周期 · 7 个处理器实例')
    expect(hookHtml).toContain('1 次触发 · 4 个处理器实例')
    expect(hookHtml.match(/class="turn-hook-phase"/g)).toHaveLength(3)
    expect(pre).toBeGreaterThan(-1)
    expect(post).toBeGreaterThan(pre)
    expect(stop).toBeGreaterThan(post)
    expect(postPhaseHtml.match(/event_router\.py/g)).toHaveLength(1)
    expect(postPhaseHtml).toContain('hook-run-count">2×')
    expect(postPhaseHtml).toContain('1 次 Bash')
    expect(postPhaseHtml).toContain('1 次 Read')
  })
it('cancelled Hook 使用黄色诚实态，并展示疑似超时依据而不冒充工具取消', () => {
    const command = 'python3 $CLAUDE_PROJECT_DIR/.claude/hooks/trace_pre.py'
    const cancelledTurn: Turn = {
      runId: 'run-hook-cancelled',
      userText: '继续',
      done: true,
      items: [
        ev({
          id: 'hook-cancelled',
          runId: 'run-hook-cancelled',
          kind: 'hook',
          stage: 'hook_response',
          hookId: 'cancel-1',
          hookEvent: 'PreToolUse',
          hookName: 'PreToolUse:Read',
          hookCommand: command,
          hookConfiguredCommands: [{
            command,
            source: 'project',
            sourcePath: '/repo/.claude/settings.json',
            timeoutSeconds: 5
          }],
          hookOutcome: 'cancelled',
          hookExitCode: 0,
          durationMs: 5531,
          input: { durationMs: 5531 },
          isError: false
        })
      ]
    }

    const turnHtml = renderToStaticMarkup(<AssistantTurn turn={cancelledTurn} selectedId={null} onSelect={() => {}} />)
    const overviewHtml = renderToStaticMarkup(
      <OverviewPanel turns={[cancelledTurn]} selected={null} onSelect={() => {}} usage={null} stats={null} />
    )

    expect(turnHtml).toContain('hook-run-status warn')
    expect(turnHtml).toContain('疑似超时')
    expect(turnHtml).toContain('5.5s / 当前配置上限 5.0s')
    expect(turnHtml).toContain('不代表对应工具调用也被取消')
    expect(turnHtml).toContain('未成功的 Hook · 1')
    expect(turnHtml).toContain('trace_pre.py')
    expect(turnHtml).not.toContain('hook-run-status ok">cancelled')
    expect(overviewHtml).toContain('hook-status warn">疑似超时 1')
    expect(overviewHtml).toContain('取消 1')
    expect(overviewHtml).toContain('疑似超时：5.5s / 当前配置上限 5.0s')
    expect(overviewHtml).not.toContain('疑似超时 · 0')
  })
it('流式 Markdown 遇到工具边界时分段，并保持文本—工具—文本顺序', () => {
    const streamingTurn: Turn = {
      runId: 'run-streaming-boundary',
      userText: '修复问题',
      done: false,
      items: [
        ev({ id: 'delta-1', kind: 'model', stage: 'text_delta', text: '先**检查**' }),
        ev({ id: 'delta-2', kind: 'model', stage: 'text_delta', text: '项目' }),
        ev({ id: 'tool-1', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', input: { command: 'npm test' } }),
        ev({ id: 'delta-3', kind: 'model', stage: 'text_delta', text: '临时草稿' }),
        ev({ id: 'text-1', kind: 'model', stage: 'text', text: '然后`修复`完成' })
      ]
    }

    const streamingHtml = renderToStaticMarkup(<AssistantTurn turn={streamingTurn} selectedId={null} onSelect={() => {}} />)
    const firstText = streamingHtml.indexOf('先<strong>检查</strong>项目')
    const tool = streamingHtml.indexOf('npm test')
    const secondText = streamingHtml.indexOf('然后<code>修复</code>完成')

    expect(streamingHtml.match(/class="model-text md/g)).toHaveLength(2)
    expect(firstText).toBeGreaterThan(-1)
    expect(tool).toBeGreaterThan(firstText)
    expect(secondText).toBeGreaterThan(tool)
    expect(streamingHtml).not.toContain('临时草稿')
  })


})