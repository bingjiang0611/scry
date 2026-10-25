import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, AssistantTurn, OverviewPanel, ev, turn } = shared
type AgentQuestionRequest = shared.AgentQuestionRequest
type Turn = shared.Turn

describe('AssistantTurn AskUserQuestion 内联问答', () => {
  const askInput = {
    questions: [
      {
        question: '请选择验证方式',
        header: '验证',
        multiSelect: false,
        options: [
          { label: '自动验证', description: 'A' },
          { label: '手动验证', description: 'B' }
        ]
      },
      {
        question: '请选择需要验证的能力',
        header: '能力',
        multiSelect: true,
        options: [
          { label: 'MCP', description: '验证 MCP' },
          { label: 'Skill', description: '验证 Skill' }
        ]
      }
    ]
  }
  const pendingRequest: AgentQuestionRequest = {
    runId: 'ask-run',
    questionId: 'ask-tool',
    questions: askInput.questions
  }
  const askTurn: Turn = {
    runId: 'ask-run',
    userText: '请提问',
    done: false,
    items: [
      ev({
        id: 'ask-use',
        runId: 'ask-run',
        kind: 'tool',
        stage: 'tool:AskUserQuestion',
        tool: 'AskUserQuestion',
        toolUseId: 'ask-tool',
        input: askInput
      })
    ]
  }

  it('等待态默认展开选择框，不再渲染 dialog 或绿色完成态', () => {
    const html = renderToStaticMarkup(
      <AssistantTurn
        turn={askTurn}
        selectedId={null}
        onSelect={() => {}}
        pendingQuestions={[pendingRequest]}
        onAnswerQuestion={async () => {}}
      />
    )

    expect(html).toContain('需要你的选择')
    expect(html).toContain('2 个问题')
    expect(html).not.toContain('等待回答')
    expect(html).toContain('type="radio"')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('提交并继续')
    expect(html).not.toContain('<dialog')
  })

  it('完成态问答默认收起并可按需展开，普通工具也保持收起', () => {
    const completed: Turn = {
      ...askTurn,
      done: true,
      items: [
        ...askTurn.items,
        ev({
          id: 'ask-result',
          runId: 'ask-run',
          kind: 'tool',
          stage: 'tool_result',
          tool: 'AskUserQuestion',
          toolUseId: 'ask-tool',
          text: 'Your questions have been answered: 自动验证; MCP, Skill'
        })
      ]
    }
    const collapsedHtml = renderToStaticMarkup(
      <AssistantTurn turn={completed} selectedId={null} onSelect={() => {}} />
    )
    const expandedHtml = renderToStaticMarkup(
      <AssistantTurn turn={completed} selectedId="ask-use" onSelect={() => {}} />
    )
    const ordinaryHtml = renderToStaticMarkup(<AssistantTurn turn={turn} selectedId={null} onSelect={() => {}} />)

    expect(collapsedHtml).not.toContain('Your questions have been answered: 自动验证; MCP, Skill')
    expect(expandedHtml).toContain('已回答')
    expect(expandedHtml).toContain('Your questions have been answered: 自动验证; MCP, Skill')
    expect(ordinaryHtml).not.toContain('class="tool-detail"')
  })

  it('只匹配相同 runId 与 toolUseId，避免并行会话串答', () => {
    const html = renderToStaticMarkup(
      <AssistantTurn
        turn={askTurn}
        selectedId={null}
        onSelect={() => {}}
        pendingQuestions={[{ ...pendingRequest, runId: 'another-run' }]}
        onAnswerQuestion={async () => {}}
      />
    )

    expect(html).not.toContain('等待回答')
    expect(html).not.toContain('提交并继续')
    expect(html).toContain('等待状态同步')
    expect(html).not.toContain('已回答')
  })

  it('二级 subagent 的 pending Ask 无直接渲染位置时回退为可回答表单', () => {
    const nestedTurn: Turn = {
      runId: 'nested-run',
      userText: '嵌套提问',
      done: false,
      items: [
        ev({
          id: 'parent-task',
          runId: 'nested-run',
          kind: 'agent',
          stage: 'tool:Task',
          tool: 'Task',
          toolUseId: 'parent-task-use'
        }),
        ev({
          id: 'child-task',
          runId: 'nested-run',
          kind: 'agent',
          stage: 'tool:Task',
          tool: 'Task',
          toolUseId: 'child-task-use',
          parentToolUseId: 'parent-task-use'
        }),
        ev({
          id: 'nested-ask',
          runId: 'nested-run',
          kind: 'tool',
          stage: 'tool:AskUserQuestion',
          tool: 'AskUserQuestion',
          toolUseId: 'nested-ask-use',
          parentToolUseId: 'child-task-use',
          input: askInput
        })
      ]
    }
    const html = renderToStaticMarkup(
      <AssistantTurn
        turn={nestedTurn}
        selectedId={null}
        onSelect={() => {}}
        pendingQuestions={[{ ...pendingRequest, runId: 'nested-run', questionId: 'nested-ask-use' }]}
        onAnswerQuestion={async () => {}}
      />
    )

    expect(html.match(/question-inline-form/g)).toHaveLength(1)
    expect(html).toContain('需要你的选择')
    expect(html).not.toContain('等待回答')
    expect(html).toContain('提交并继续')
  })

  it('已结束但缺失 tool_result 时标记未获得返回，不伪报仍在同步或成功', () => {
    const html = renderToStaticMarkup(
      <AssistantTurn turn={{ ...askTurn, done: true }} selectedId="ask-use" onSelect={() => {}} />
    )

    expect(html).toContain('未获得返回')
    expect(html).not.toContain('等待状态同步')
    expect(html).not.toContain('已回答')
  })

  it('使用结构化 intervention 展示所在轮次、问题、答案与结构化介入计数', () => {
    const completed: Turn = {
      ...askTurn,
      done: true,
      items: [
        ...askTurn.items,
        ev({
          id: 'human-intervention',
          runId: 'ask-run',
          ts: '2026-08-06T10:00:02.000Z',
          kind: 'human',
          stage: 'intervention',
          toolUseId: 'ask-tool',
          providerId: 'qoder',
          intervention: {
            kind: 'clarification',
            source: 'qoder:AskUserQuestion',
            resolution: 'answered',
            request: { ...pendingRequest, providerId: 'qoder', questionKind: 'clarification', source: 'qoder:AskUserQuestion' },
            response: {
              runId: 'ask-run',
              questionId: 'ask-tool',
              behavior: 'answered',
              answers: {
                '请选择验证方式': '自动验证',
                '请选择需要验证的能力': 'MCP, Skill'
              }
            },
            openedAt: '2026-08-06T10:00:00.000Z',
            closedAt: '2026-08-06T10:00:02.000Z',
            durationMs: 2000
          }
        })
      ]
    }
    const turnHtml = renderToStaticMarkup(<AssistantTurn turn={completed} selectedId="ask-use" onSelect={() => {}} />)
    const overviewHtml = renderToStaticMarkup(
      <OverviewPanel turns={[completed]} selected={null} onSelect={() => {}} usage={null} stats={null} />
    )

    expect(turnHtml).toContain('请选择验证方式')
    expect(turnHtml).toContain('自动验证')
    expect(turnHtml).toContain('MCP, Skill')
    expect(turnHtml).toContain('等待 2.0s')
    expect(turnHtml).toContain('human</span> <b>1 · 2Q</b>')
    expect(overviewHtml).toContain('本会话 1 次 · 2 个问题')
    expect(overviewHtml).toContain('aria-label="结构化介入 1，展开明细"')
    expect(overviewHtml).toContain('T01')
  })
})