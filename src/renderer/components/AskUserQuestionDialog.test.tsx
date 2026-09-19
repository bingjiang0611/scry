import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentQuestionRequest } from '@shared/runtime'
import {
  AskUserQuestionInline,
  AskUserQuestionResult,
  buildQuestionAnswers,
  initialQuestionDrafts,
  isGeneratedFreeTextOption,
  optionDisplayCopy,
  questionDisplayCopy
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

  it('shows the provider that owns the pending question', () => {
    const html = renderToStaticMarkup(
      <AskUserQuestionInline
        request={{ ...request, providerId: 'qoder' }}
        queuedCount={1}
        onRespond={async () => {}}
      />
    )

    expect(html).toContain('Qoder 需要你的选择')
    expect(html).not.toContain('Claude 需要你的选择')
  })

  it('removes generated duplicate copy while preserving the raw answer value', () => {
    expect(questionDisplayCopy(
      '[下一步] 卡片改版已实现并通过验证，接下来要继续哪一步？',
      '[下一步] 卡片改版已实现并通过验证，接下来要继续哪一步？'
    )).toEqual({ header: '下一步', question: '卡片改版已实现并通过验证，接下来要继续哪一步？' })
    expect(optionDisplayCopy(
      '1. 安装到 Applications（推荐） — 打包并安装当前版本，方便直接体验',
      '选择此项'
    )).toEqual({
      label: '安装到 Applications',
      description: '打包并安装当前版本，方便直接体验',
      recommended: true
    })
    expect(isGeneratedFreeTextOption('Type something.')).toBe(true)

    const html = renderToStaticMarkup(
      <AskUserQuestionInline
        request={{
          ...request,
          questions: [{
            question: '[下一步] 卡片改版已实现并通过验证，接下来要继续哪一步？',
            header: '[下一步] 卡片改版已实现并通过验证，接下来要继续哪一步？',
            multiSelect: false,
            options: [
              { label: '1. 安装到 Applications（推荐） — 打包并安装当前版本，方便直接体验', description: '选择此项' },
              { label: 'Type something.', description: '选择此项' }
            ]
          }]
        }}
        queuedCount={1}
        onRespond={async () => {}}
      />
    )

    expect(html.match(/卡片改版已实现并通过验证/g)).toHaveLength(1)
    expect(html).toContain('安装到 Applications')
    expect(html).toContain('打包并安装当前版本，方便直接体验')
    expect(html).not.toContain('选择此项')
    expect(html).not.toContain('Type something.')
    expect(html.match(/>其他</g)).toHaveLength(1)
  })

  it('renders provider-native free-text prompts as a direct input instead of an Other option', () => {
    const freeTextRequest: AgentQuestionRequest = {
      runId: 'run-1',
      questionId: 'input-1',
      providerId: 'pi',
      questions: [{
        header: '不满意点',
        question: '你最想改善什么？\n\n1. 布局不均衡\n2. 视觉风格不够精致',
        options: [],
        multiSelect: false,
        placeholder: '例如：1,3'
      }]
    }
    const drafts = initialQuestionDrafts(freeTextRequest)
    const html = renderToStaticMarkup(
      <AskUserQuestionInline request={freeTextRequest} queuedCount={1} onRespond={async () => {}} />
    )

    expect(drafts[freeTextRequest.questions[0].question].useOther).toBe(true)
    expect(html).toContain('question-free-text-input')
    expect(html).toContain('placeholder="例如：1,3"')
    expect(html).toContain('1. 布局不均衡\n2. 视觉风格不够精致')
    expect(html).not.toContain('>其他<')
  })

  it('renders native editor requests as multiline input', () => {
    const editor: AgentQuestionRequest = {
      runId: 'run-editor', questionId: 'editor-1', providerId: 'pi',
      questions: [{ question: '请输入多行内容', header: 'Pi Editor', options: [], multiSelect: false, inputMode: 'multiline' }]
    }
    const html = renderToStaticMarkup(<AskUserQuestionInline request={editor} queuedCount={1} onRespond={async () => {}} />)
    expect(html).toContain('<textarea')
    expect(html).toContain('rows="8"')
    expect(html).not.toContain('输入一个不在上述选项中的回答')
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

  it('submits provider response values while keeping readable option labels', () => {
    const valuedRequest: AgentQuestionRequest = {
      runId: 'run-1',
      questionId: 'input-1',
      questions: [{
        header: '重点',
        question: '选择改进重点？',
        multiSelect: true,
        options: [
          { label: '布局', description: '改善留白', answerValue: '1' },
          { label: '视觉', description: '改善层级', answerValue: '2' }
        ]
      }]
    }
    const drafts = initialQuestionDrafts(valuedRequest)
    drafts['选择改进重点？'] = { selected: ['布局', '视觉'], useOther: false, other: '' }

    expect(buildQuestionAnswers(valuedRequest, drafts)).toEqual({ '选择改进重点？': '1,2' })
  })

  it('does not treat an empty Other field as a completed answer', () => {
    const drafts = initialQuestionDrafts(request)
    drafts['选择流程？'] = { selected: [], useOther: true, other: '   ' }
    drafts['启用哪些能力？'] = { selected: ['MCP'], useOther: false, other: '' }
    expect(buildQuestionAnswers(request, drafts)).toBeNull()
  })
})
