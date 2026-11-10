import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '@shared/trace'
import { workflowFixtureMessages } from '@shared/claude-workflow.fixture'
import { type NormalizeCtx, normalizeSdkMessage } from '../../main/normalize'
import { WORKFLOW_COPY } from '../constants/workflow-copy'
import { ToolItem } from './ChatTurnToolItem'
import { ChatView, chatViewProps } from './render-tests/shared'

function events(messages: Array<Record<string, unknown>>): TraceEvent[] {
  let n = 0
  const ctx: NormalizeCtx = { runId: 'run-1', newId: () => `ev-${n++}`, now: () => '2026-11-10T00:00:00.000Z' }
  return messages.flatMap((message) => normalizeSdkMessage(message, ctx))
}

const workflowCall = (): TraceEvent => {
  const found = events(workflowFixtureMessages()).find((event) => event.kind === 'tool' && event.tool === 'Workflow' && event.input != null)
  if (!found) throw new Error('fixture must contain a Workflow tool_use')
  return found
}

const render = (ev: TraceEvent, onOpenWorkflow?: () => void): string => renderToStaticMarkup(createElement(ToolItem, {
  ev, selected: false, onSelect: () => undefined, maxDur: 1, turnDone: true,
  ...(onOpenWorkflow ? { onOpenWorkflow } : {})
}))

describe('Workflow tool card entry', () => {
  it('Workflow 卡片提供打开面板的入口，按 tool_use 定位这次运行', () => {
    const html = render(workflowCall(), () => undefined)
    expect(html).toContain('tool-workflow-open')
    expect(html).toContain(WORKFLOW_COPY.openFromChat)
  })

  it('没有提供回调时不显示入口，避免给出点了没反应的按钮', () => {
    const html = render(workflowCall())
    expect(html).not.toContain('tool-workflow-open')
    expect(html).not.toContain(WORKFLOW_COPY.openFromChat)
  })

  it('其他工具的卡片不出现 Workflow 入口', () => {
    const other: TraceEvent = { ...workflowCall(), tool: 'Read', name: 'Read' }
    const html = render(other, () => undefined)
    expect(html).not.toContain(WORKFLOW_COPY.openFromChat)
  })
})

describe('Workflow 面板入口穿过会话视图', () => {
  it('ChatView 会把 onOpenWorkflow 传给对话流', () => {
    const call = workflowCall()
    const html = renderToStaticMarkup(createElement(ChatView, {
      ...chatViewProps(),
      turns: [{ runId: 'run-1', userText: 'run the workflow', items: [call], done: true }],
      selectedId: call.id,
      onOpenWorkflow: () => undefined
    }))
    expect(html).toContain('tool-workflow-open')
  })
})
