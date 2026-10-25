import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, AssistantTurn, coalesceAdjacentThinking, WorkspaceFileLinkProvider, ev, html } = shared
type Turn = shared.Turn

describe('AssistantTurn 渲染：trace 树 / footer / 文件足迹', () => {
  it.each([false, true])('Pi 普通扩展通知不进入对话正文，保留回复与真实命令反馈（done=%s）', (done) => {
    const piTurn: Turn = {
      runId: 'pi-notifications', userText: '继续', done,
      items: [
        ev({ id: 'pi-reply', kind: 'model', stage: 'text', text: '已完成代码检查。' }),
        ev({
          id: 'pi-tps', kind: 'harness', stage: 'runtime:extension_ui', providerId: 'pi', runtimeProvider: 'pi_rpc',
          text: 'TPS 25.7 tok/s. out 794, in 9,676, cache r/w 54,912/0, total 65,382, 30.9s',
          runtimeMetadata: { method: 'notify', notifyType: 'info' }
        }),
        ev({
          id: 'pi-command', kind: 'harness', stage: 'result', providerId: 'pi', runtimeProvider: 'pi_rpc',
          text: '/test-command 已执行', providerCommand: { name: 'test-command', source: 'extension', modelTurn: 'unobserved' }
        })
      ]
    }
    const rendered = renderToStaticMarkup(<AssistantTurn turn={piTurn} selectedId={null} onSelect={() => {}} />)
    expect(rendered).not.toContain('TPS 25.7')
    expect(rendered).toContain('已完成代码检查。')
    expect(rendered).toContain('aria-label="Pi 命令反馈"')
    expect(rendered).toContain('/test-command 已执行')
  })
it.each([
    { stage: 'runtime:extension_ui', runtimeMetadata: { method: 'notify', notifyType: 'warning' }, isError: false, label: 'Pi 扩展通知' },
    { stage: 'runtime:extension_ui', runtimeMetadata: { method: 'notify', notifyType: 'error' }, isError: true, label: 'Pi 扩展通知' },
    { stage: 'runtime:extension_ui', runtimeMetadata: { method: 'notify' }, isError: false, label: 'Pi 扩展通知' },
    { stage: 'runtime:extension_message', runtimeMetadata: { customType: 'review' }, isError: false, label: 'Pi 扩展消息' }
  ])('Pi 扩展证据保留并正确标注：$stage $runtimeMetadata', ({ stage, runtimeMetadata, isError, label }) => {
    const extensionTurn: Turn = {
      runId: 'pi-extension', userText: '继续', done: true,
      items: [ev({
        id: 'extension', kind: 'harness', stage, providerId: 'pi', runtimeProvider: 'pi_rpc',
        text: '扩展反馈内容', runtimeMetadata, isError
      })]
    }
    const rendered = renderToStaticMarkup(<AssistantTurn turn={extensionTurn} selectedId={null} onSelect={() => {}} />)
    expect(rendered).toContain(`aria-label="${label}"`)
    expect(rendered).toContain('扩展反馈内容')
    expect(rendered).not.toContain('Pi 命令')
    if (isError) expect(rendered).toContain(`${label} · 错误`)
  })
it('routes abbreviated file links through their own turn evidence, not another turn or the active project', () => {
    const historyTurn: Turn = {
      runId: 'history-links', cwd: '/repo', userText: '设计原型', done: true,
      items: [
        ev({ id: 'written', kind: 'tool', stage: 'tool_use', tool: 'Write', fileOp: 'write', filePath: '/repo/designs/scry-unified-remote/brief.md' }),
        ev({ id: 'reply', kind: 'model', stage: 'text', text: '包含原型、`brief.md`。' })
      ]
    }
    const nextTurn: Turn = { runId: 'next-links', cwd: '/repo', userText: '后续任务', done: true,
      items: [ev({ id: 'next-reply', kind: 'model', stage: 'text', text: '`brief.md`' })] }
    const rendered = renderToStaticMarkup(
      <WorkspaceFileLinkProvider workspaces={['/active-project']} onOpen={() => {}}>
        <AssistantTurn turn={historyTurn} selectedId={null} onSelect={() => {}} />
        <AssistantTurn turn={nextTurn} selectedId={null} onSelect={() => {}} />
      </WorkspaceFileLinkProvider>
    )
    expect(rendered.match(/title="designs\/scry-unified-remote\/brief.md · 在右侧文件面板打开"/g)).toHaveLength(1)
    expect(rendered).toContain('title="brief.md · 在右侧文件面板打开"')
  })
it('已完成且带原生轮次边界的 Provider 轮次提供分支入口', () => {
    const branchTurn: Turn = {
      runId: 'run-branch',
      userText: '保留到这里',
      done: true,
      providerTurnId: 'turn-selected',
      forkTurnId: 'turn-selected',
      items: [ev({
        id: 'branch-result',
        kind: 'harness',
        stage: 'result',
        providerId: 'codex',
        runtimeProvider: 'codex_cli'
      })]
    }
    const branchHtml = renderToStaticMarkup(
      <AssistantTurn turn={branchTurn} selectedId={null} onSelect={() => {}} onForkTurn={async () => {}} />
    )
    expect(branchHtml).toContain('aria-label="从此轮创建分支会话"')
    expect(branchHtml).toContain('在新会话中分支')
    expect(branchHtml).toContain('class="turn-tail"')
    expect(branchHtml.indexOf('class="turn-footer"')).toBeLessThan(branchHtml.indexOf('class="turn-branch-row"'))
    expect(html).not.toContain('从此轮创建分支会话')
  })
it('已结束的 Provider 失败轮次提供恢复分支入口', () => {
    const failedTurn: Turn = {
      runId: 'run-failed-branch',
      userText: '继续',
      done: true,
      error: 'Qoder: http_413',
      providerTurnId: 'turn-failed',
      forkTurnId: 'turn-failed',
      items: [ev({
        id: 'failed-branch-result',
        kind: 'harness',
        stage: 'result',
        isError: true,
        providerId: 'pi',
        runtimeProvider: 'pi_rpc'
      })]
    }
    const failedHtml = renderToStaticMarkup(
      <AssistantTurn turn={failedTurn} selectedId={null} onSelect={() => {}} onForkTurn={async () => {}} />
    )

    expect(failedHtml).toContain('aria-label="从失败轮次创建恢复分支"')
    expect(failedHtml).toContain('从失败处恢复')
  })
it('trace 树默认只挂载工具组摘要，展开内容按需渲染', () => {
    expect(html).toContain('Write')
    expect(html).toContain('Read')
    expect(html).toContain('Bash')
    expect(html).not.toContain('data-trace-event-id="e2"')
  })
it('思考默认展开并以独立 disclosure 区别于最终回复', () => {
    expect(html).toContain('class="turn-flow"')
    expect(html).toContain('<details class="thinking" open="">')
    expect(html).toContain('class="think-head" aria-expanded="true"')
    expect(html).toContain('思考过程')
    expect(html).toContain('class="ico think-bulb"')
    expect(html).toContain('class="ico think-chevron motion-chevron"')
    expect(html).toContain('class="think-text md"><p><strong>先写文件再读回</strong></p>')
    expect(html).not.toContain('**先写文件再读回**')
    expect(html).not.toContain('class="think-mark"')
    expect(html).toContain('class="tool-group"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('class="tool-group-body"')
    expect(html).toContain('class="tg-pill">3</span>')
    expect(html).toContain('Bash · Write · Read')
    expect(html).not.toContain('class="tg-dur">0ms</span>')
  })
it('Pi 的连续思考增量只渲染成一个卡片，历史事件也能防御性合并', () => {
    const thinkingItems = [
      ev({ id: 'p1', kind: 'model', stage: 'thinking', thinking: 'need' }),
      ev({ id: 'p2', kind: 'model', stage: 'thinking', thinking: ' to' }),
      ev({ id: 'p3', kind: 'model', stage: 'thinking', thinking: ' apologize' })
    ]
    expect(coalesceAdjacentThinking(thinkingItems)).toEqual([
      expect.objectContaining({ id: 'p1', thinking: 'need to apologize' })
    ])

    const fragmentedHtml = renderToStaticMarkup(
      <AssistantTurn
        turn={{ runId: 'pi-fragments', userText: '继续', done: false, items: thinkingItems }}
        selectedId={null}
        onSelect={() => {}}
      />
    )
    expect(fragmentedHtml.match(/<details class="thinking"/g)).toHaveLength(1)
    expect(fragmentedHtml).toContain('<p>need to apologize</p>')
  })
it('思考合并严格隔离 message 和父工具作用域', () => {
    const items = coalesceAdjacentThinking([
      ev({ id: 'a', kind: 'model', stage: 'thinking', thinking: 'root', messageId: 'm1' }),
      ev({ id: 'b', kind: 'model', stage: 'thinking', thinking: 'next', messageId: 'm2' }),
      ev({ id: 'c', kind: 'model', stage: 'thinking', thinking: 'child', messageId: 'm2', parentToolUseId: 'tool-1' })
    ])
    expect(items.map((item) => item.thinking)).toEqual(['root', 'next', 'child'])
  })
it('工具脚注只在耗时数据完整时展示合计，并保留失败摘要', () => {
    const measuredTurn: Turn = {
      runId: 'measured-tools',
      userText: '执行检查',
      done: true,
      items: [
        ev({ id: 'bash-1', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', durationMs: 120 }),
        ev({ id: 'bash-2', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', durationMs: 380, isError: true }),
        ev({ id: 'read-1', kind: 'tool', stage: 'tool:Read', tool: 'Read', durationMs: 42 })
      ]
    }
    const measuredHtml = renderToStaticMarkup(
      <AssistantTurn turn={measuredTurn} selectedId={null} onSelect={() => {}} />
    )

    expect(measuredHtml).toContain('Bash×2 · Read')
    expect(measuredHtml).toContain('1 失败')
    expect(measuredHtml).toContain('title="工具调用耗时合计">542ms</span>')
  })
it('footer 渲染出 token（蓝本 turn-footer stat 条）', () => {
    expect(html).not.toContain('$0.1234')
    expect(html).toContain('1.5k') // in = fmtTok(tokensIn 1500)
    expect(html).toContain('turn-footer')
  })
it('Codex turn 头部总 Token 不重复加上已包含在 input 内的 cache read', () => {
    const codexUsageTurn: Turn = {
      runId: 'codex-cache-accounting',
      userText: 'inspect',
      done: true,
      items: [
        ev({
          id: 'codex-result',
          kind: 'harness',
          stage: 'result',
          providerId: 'codex',
          runtimeProvider: 'codex_cli',
          tokensIn: 139_269,
          tokensOut: 767,
          cacheReadTokens: 110_336
        })
      ]
    }
    const codexUsageHtml = renderToStaticMarkup(
      <AssistantTurn turn={codexUsageTurn} selectedId={null} onSelect={() => {}} />
    )

    expect(codexUsageHtml).toContain('tok <b>140.0k</b>')
    expect(codexUsageHtml).not.toContain('tok <b>250.4k</b>')
  })
it('footer 不把继承 tool/file 字段的 tool_result 重复计数', () => {
    const footerTurn: Turn = {
      runId: 'footer-dedupe',
      userText: 'read once',
      done: true,
      items: [
        ev({ id: 'read-use', kind: 'tool', stage: 'tool:Read', tool: 'Read', toolUseId: 'read-1', fileOp: 'read', filePath: '/a.ts' }),
        ev({ id: 'read-result', kind: 'tool', stage: 'tool_result', tool: 'Read', toolUseId: 'read-1', fileOp: 'read', filePath: '/a.ts' }),
        ev({ id: 'result', kind: 'harness', stage: 'result', tokensIn: 1, tokensOut: 1 })
      ]
    }
    const footerHtml = renderToStaticMarkup(<AssistantTurn turn={footerTurn} selectedId={null} onSelect={() => {}} />)
    const footer = footerHtml.match(/<div class="turn-footer">[\s\S]*?<\/div>/)?.[0] ?? ''
    expect(footer).toContain('<span class="lbl">tools</span> <b>1</b>')
    expect(footer).toContain('<span class="lbl">files</span> <b>1 R · 0 W</b>')
    expect(footer).not.toContain('<span class="lbl">tools</span> <b>2</b>')
  })
it('footer 的 files 按唯一路径计数，不把重复文件操作当成多个文件', () => {
    const footerTurn: Turn = {
      runId: 'footer-unique-files',
      userText: 'touch the same files repeatedly',
      done: true,
      items: [
        ev({ id: 'read-a-1', kind: 'tool', stage: 'tool:Read', tool: 'Read', toolUseId: 'read-a-1', fileOp: 'read', filePath: '/a.ts' }),
        ev({ id: 'read-a-2', kind: 'tool', stage: 'tool:Read', tool: 'Read', toolUseId: 'read-a-2', fileOp: 'read', filePath: '/a.ts' }),
        ev({ id: 'write-b', kind: 'tool', stage: 'tool:Write', tool: 'Write', toolUseId: 'write-b', fileOp: 'write', filePath: '/b.ts' }),
        ev({ id: 'edit-b', kind: 'tool', stage: 'tool:Edit', tool: 'Edit', toolUseId: 'edit-b', fileOp: 'edit', filePath: '/b.ts' }),
        ev({ id: 'edit-c', kind: 'tool', stage: 'tool:Edit', tool: 'Edit', toolUseId: 'edit-c', fileOp: 'edit', filePath: '/c.ts' }),
        ev({ id: 'result', kind: 'harness', stage: 'result', tokensIn: 1, tokensOut: 1 })
      ]
    }
    const footerHtml = renderToStaticMarkup(<AssistantTurn turn={footerTurn} selectedId={null} onSelect={() => {}} />)
    const footer = footerHtml.match(/<div class="turn-footer">[\s\S]*?<\/div>/)?.[0] ?? ''

    expect(footer).toContain('<span class="lbl">files</span> <b>1 R · 2 W</b>')
    expect(footer).not.toContain('2 R · 3 W')
  })
it('Header 错误数只统计失败 tool_result，不把结果复制到同 ID Hook', () => {
    const sharedHooks = Array.from({ length: 10 }, (_, index) =>
      ev({
        id: `hook-${index}`,
        kind: 'hook',
        stage: 'hook_response',
        toolUseId: 'grep-failed',
        hookName: 'PostToolUse:Grep',
        hookEvent: 'PostToolUse',
        isError: index === 0
      })
    )
    const failedTools = ['grep-failed', 'bash-1', 'bash-2', 'bash-3', 'bash-4', 'bash-5'].flatMap((toolUseId) => [
      ev({ id: `${toolUseId}-start`, kind: 'tool', stage: `tool:${toolUseId === 'grep-failed' ? 'Grep' : 'Bash'}`, tool: toolUseId === 'grep-failed' ? 'Grep' : 'Bash', toolUseId }),
      ev({ id: `${toolUseId}-result`, kind: 'tool', stage: 'tool_result', tool: toolUseId === 'grep-failed' ? 'Grep' : 'Bash', toolUseId, isError: true })
    ])
    const errorTurn: Turn = {
      runId: 'qoder-errors',
      userText: 'work',
      done: true,
      items: [
        ...failedTools,
        ...sharedHooks,
        ev({ id: 'hook-no-id', kind: 'hook', stage: 'hook_response', hookName: 'SessionStart', hookEvent: 'SessionStart', isError: true })
      ]
    }

    const errorHtml = renderToStaticMarkup(<AssistantTurn turn={errorTurn} selectedId={null} onSelect={() => {}} />)
    const header = errorHtml.match(/<div class="who">[\s\S]*?<\/div>/)?.[0] ?? ''

    expect(header).toContain('err <b>6</b>')
    expect(header).not.toContain('err <b>13</b>')
    expect(errorHtml).toContain('失败 1')
    expect(errorHtml).not.toContain('失败 10')
  })
it('turn 顶部与 footer 共用逻辑调用口径，不把 Skill 内部路径证据重复计数', () => {
    const ordinaryTools = Array.from({ length: 40 }, (_, index) =>
      ev({
        id: `tool-${index}`,
        kind: 'tool',
        stage: 'tool:Bash',
        tool: 'Bash',
        toolUseId: `tool-${index}`
      })
    )
    const logicalCountTurn: Turn = {
      runId: 'logical-call-count',
      userText: '/rate-workflow 84441907',
      done: true,
      items: [
        ...ordinaryTools,
        ev({
          id: 'root-skill',
          kind: 'skill',
          stage: 'skill:rate-workflow',
          tool: 'Skill',
          name: 'rate-workflow',
          toolUseId: 'skill-root',
          input: { source: 'tool_use' }
        }),
        ev({
          id: 'root-skill-path',
          kind: 'skill',
          stage: 'skill:rate-workflow',
          tool: 'Skill',
          name: 'rate-workflow',
          toolUseId: 'read-root-skill',
          input: { source: 'skill_path_in_command' }
        }),
        ...['intake', 'status', 'archive'].map((name) =>
          ev({
            id: `skill-${name}`,
            kind: 'skill',
            stage: `skill:${name}`,
            tool: 'Skill',
            name,
            toolUseId: `skill-${name}`,
            input: { source: 'tool_use' }
          })
        ),
        ev({ id: 'logical-result', kind: 'harness', stage: 'result', tokensIn: 1, tokensOut: 1 })
      ]
    }

    const logicalHtml = renderToStaticMarkup(
      <AssistantTurn turn={logicalCountTurn} selectedId={null} onSelect={() => {}} />
    )
    const header = logicalHtml.match(/<div class="who">[\s\S]*?<\/div>/)?.[0] ?? ''
    const footer = logicalHtml.match(/<div class="turn-footer">[\s\S]*?<\/div>/)?.[0] ?? ''

    expect(header).toContain('tools <b>44</b>')
    expect(header).not.toContain('tools <b>45</b>')
    expect(footer).toContain('<span class="lbl">tools</span> <b>44</b>')
  })
it('who 头渲染头像 + runid', () => {
    expect(html).toContain('Agent')
    expect(html).toContain('run · r1') // turn.runId
  })


})