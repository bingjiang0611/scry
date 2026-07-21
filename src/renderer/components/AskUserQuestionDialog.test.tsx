import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentQuestionRequest } from '@shared/runtime'
import {
  AskUserQuestionInline,
  AskUserQuestionResult,
  buildQuestionAnswers,
  initialQuestionDrafts
} from './AskUserQuestionDialog'

const request: AgentQuestionRequest = {
  runId: 'run-1',
  questionId: 'tool-1',
  questions: [
    {
      question: '选择流程？',
      header: '流程',
      multiSelect: false,
      options: [
        { label: '全量', description: '完整执行', preview: '**完整**' },
        { label: '快速', description: '缩短流程' }
      ]
    },
    {
      question: '启用哪些能力？',
      header: '能力',
      multiSelect: true,
      options: [
        { label: 'MCP', description: '调用 MCP' },
        { label: 'Skill', description: '调用 Skill' }
      ]
    }
  ]
}

describe('AskUserQuestionInline', () => {
  it('renders an accessible inline form for single and multi-select questions', () => {
    const html = renderToStaticMarkup(<AskUserQuestionInline request={request} queuedCount={1} onRespond={async () => {}} />)

    expect(html).toContain('<form')
    expect(html).toContain('question-inline-form')
    expect(html).toContain('aria-labelledby=')
    expect(html).toContain('Claude 需要你的选择')
    expect(html).toContain('type="radio"')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('其他')
    expect(html).toContain('提交并继续')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('<dialog')
    expect(html).not.toContain('dangerouslySetInnerHTML')
  })

  it('keeps completed answers visible and raw evidence available', () => {
    const html = renderToStaticMarkup(
      <AskUserQuestionResult
        request={request}
        answers={{ '选择流程？': '全量', '启用哪些能力？': 'MCP, Skill' }}
        output="Your questions have been answered."
      />
    )

    expect(html).toContain('已回答')
    expect(html).toContain('全量')
    expect(html).toContain('MCP, Skill')
    expect(html).toContain('查看原始输入与输出')
    expect(html).toContain('Your questions have been answered.')
  })

  it('serializes multi-select and free text using the SDK answers map contract', () => {
    const drafts = initialQuestionDrafts(request)
    drafts['选择流程？'] = { selected: ['全量'], useOther: false, other: '' }
    drafts['启用哪些能力？'] = { selected: ['Skill', 'MCP'], useOther: true, other: 'Hook' }

    expect(buildQuestionAnswers(request, drafts)).toEqual({
      '选择流程？': '全量',
      '启用哪些能力？': 'MCP, Skill, Hook'
    })
  })

  it('does not treat an empty Other field as a completed answer', () => {
    const drafts = initialQuestionDrafts(request)
    drafts['选择流程？'] = { selected: [], useOther: true, other: '   ' }
    drafts['启用哪些能力？'] = { selected: ['MCP'], useOther: false, other: '' }
    expect(buildQuestionAnswers(request, drafts)).toBeNull()
  })
})
