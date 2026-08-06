import { useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { AgentIntervention, AgentQuestionRequest, AgentQuestionResponse } from '@shared/runtime'
import type { ProviderId } from '@shared/provider'
import Markdown from './MarkdownImpl'
import { Icon } from './primitives/Icon'

const providerLabels = {
  claude: 'Claude',
  codex: 'Codex',
  qoder: 'Qoder',
  opencode: 'OpenCode'
} satisfies Record<ProviderId, string>

export interface QuestionDraft {
  selected: string[]
  useOther: boolean
  other: string
}

export type QuestionDrafts = Record<string, QuestionDraft>

export function initialQuestionDrafts(request: AgentQuestionRequest): QuestionDrafts {
  return Object.fromEntries(
    request.questions.map((question) => [question.question, { selected: [], useOther: false, other: '' }])
  )
}

export function buildQuestionAnswers(request: AgentQuestionRequest, drafts: QuestionDrafts): Record<string, string> | null {
  const answers: Record<string, string> = {}
  for (const question of request.questions) {
    const draft = drafts[question.question]
    if (!draft) return null
    if (!question.multiSelect) {
      const answer = draft.useOther ? draft.other.trim() : draft.selected[0]
      if (!answer) return null
      answers[question.question] = answer
      continue
    }
    const selected = question.options.filter((option) => draft.selected.includes(option.label)).map((option) => option.label)
    if (draft.useOther) {
      const other = draft.other.trim()
      if (!other) return null
      selected.push(other)
    }
    if (selected.length === 0) return null
    answers[question.question] = selected.join(', ')
  }
  return answers
}

export function AskUserQuestionInline({
  request,
  queuedCount,
  onRespond,
  onSubmitted
}: {
  request: AgentQuestionRequest
  queuedCount: number
  onRespond: (response: AgentQuestionResponse) => Promise<void>
  onSubmitted?: (answers: Record<string, string>) => void
}) {
  const submittingRef = useRef(false)
  const [drafts, setDrafts] = useState<QuestionDrafts>(() => initialQuestionDrafts(request))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const answers = useMemo(() => buildQuestionAnswers(request, drafts), [drafts, request])
  const missing = request.questions.filter((question) => !buildQuestionAnswers({ ...request, questions: [question] }, drafts)).length
  const id = useId()
  const titleId = `${id}-title`
  const statusId = `${id}-status`

  const respond = async (response: AgentQuestionResponse): Promise<void> => {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      await onRespond(response)
      if (response.behavior === 'answered') onSubmitted?.(response.answers)
    } catch (reason) {
      setError(String((reason as Error)?.message ?? reason))
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const submit = (event?: FormEvent): void => {
    event?.preventDefault()
    if (!answers) return
    void respond({
      runId: request.runId,
      questionId: request.questionId,
      behavior: 'answered',
      answers
    })
  }

  const cancel = (): void => {
    void respond({ runId: request.runId, questionId: request.questionId, behavior: 'cancelled' })
  }

  const toggleOption = (questionText: string, label: string, multiSelect: boolean): void => {
    setDrafts((current) => {
      const draft = current[questionText]
      const selected = multiSelect
        ? draft.selected.includes(label)
          ? draft.selected.filter((item) => item !== label)
          : [...draft.selected, label]
        : [label]
      return { ...current, [questionText]: { ...draft, selected, useOther: multiSelect ? draft.useOther : false } }
    })
  }

  const toggleOther = (questionText: string, multiSelect: boolean): void => {
    setDrafts((current) => {
      const draft = current[questionText]
      const useOther = !draft.useOther
      return {
        ...current,
        [questionText]: { ...draft, useOther, selected: multiSelect ? draft.selected : [] }
      }
    })
  }

  const onFormKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
    if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) {
      event.preventDefault()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      submit()
      return
    }
    if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') {
      const input = event.target as HTMLInputElement
      if (input.type === 'text') event.preventDefault()
    }
  }

  return (
    <form
      className="question-form question-inline-form"
      aria-labelledby={titleId}
      aria-describedby={statusId}
      onSubmit={submit}
      onKeyDown={onFormKeyDown}
    >
      <header className="question-dialog-head">
        <div>
          <h3 id={titleId}>{providerLabels[request.providerId ?? 'claude']} 需要你的选择</h3>
          <p>{request.questions.length} 个问题 · 回答后继续当前任务</p>
        </div>
        {queuedCount > 1 && <span className="question-queue">还有 {queuedCount - 1} 组待回答</span>}
      </header>

      <div className="question-dialog-body">
        {request.questions.map((question, questionIndex) => {
          const draft = drafts[question.question]
          const selectedPreviews = question.options.filter(
            (option) => draft.selected.includes(option.label) && option.preview
          )
          return (
              <fieldset className="question-field" key={question.question}>
                <legend>
                  <span className="question-index">{String(questionIndex + 1).padStart(2, '0')}</span>
                  <span>
                    <b>{question.header}</b>
                    <span>{question.question}</span>
                  </span>
                </legend>
                <div className="question-options">
                  {question.options.map((option, optionIndex) => {
                    const checked = draft.selected.includes(option.label)
                    return (
                      <label className={`question-option ${checked ? 'selected' : ''}`} key={option.label}>
                        <input
                          autoFocus={questionIndex === 0 && optionIndex === 0}
                          type={question.multiSelect ? 'checkbox' : 'radio'}
                          name={`question-${request.questionId}-${questionIndex}`}
                          checked={checked}
                          onChange={() => toggleOption(question.question, option.label, question.multiSelect)}
                        />
                        <span>
                          <b>{option.label}</b>
                          <small>{option.description}</small>
                        </span>
                      </label>
                    )
                  })}
                  <label className={`question-option question-other ${draft.useOther ? 'selected' : ''}`}>
                    <input
                      type={question.multiSelect ? 'checkbox' : 'radio'}
                      name={`question-${request.questionId}-${questionIndex}`}
                      checked={draft.useOther}
                      onChange={() => toggleOther(question.question, question.multiSelect)}
                    />
                    <span>
                      <b>其他</b>
                      <small>输入一个不在上述选项中的回答</small>
                    </span>
                  </label>
                  {draft.useOther && (
                    <input
                      autoFocus
                      className="question-other-input"
                      aria-label={`${question.header}的其他回答`}
                      value={draft.other}
                      maxLength={4_000}
                      placeholder="请输入回答…"
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [question.question]: { ...current[question.question], other: event.target.value }
                        }))
                      }
                    />
                  )}
                </div>
                {selectedPreviews.map((option) => (
                  <div className="question-preview" key={option.label}>
                    <span>{option.label} · PREVIEW</span>
                    <Markdown>{option.preview!}</Markdown>
                  </div>
                ))}
              </fieldset>
          )
        })}
      </div>

      <footer className="question-dialog-foot">
        <div
          id={statusId}
          className={`question-status ${error ? 'error' : missing > 0 ? 'incomplete' : 'complete'}`}
          aria-live="polite"
        >
          {!error && <Icon name={missing > 0 ? 'alert' : 'check'} />}
          {error ? <span className="question-error">{error}</span> : missing > 0 ? `还需回答 ${missing} 个问题` : '回答完整，可提交'}
        </div>
        <div className="question-actions">
          <button type="button" className="btn question-cancel" disabled={submitting} onClick={cancel}>
            取消提问
          </button>
          <button type="submit" className="btn primary question-submit" disabled={!answers || submitting}>
            {submitting ? '正在提交…' : '提交并继续'}
            <span className="question-shortcut" aria-hidden="true">⌘ Enter</span>
          </button>
        </div>
      </footer>
    </form>
  )
}

export function AskUserQuestionResult({
  request,
  answers,
  output,
  error = false,
  resolution,
  durationMs,
  source
}: {
  request: AgentQuestionRequest
  answers?: Record<string, string>
  output?: string
  error?: boolean
  resolution?: AgentIntervention['resolution']
  durationMs?: number
  source?: string
}) {
  const incomplete = error || (resolution != null && resolution !== 'answered')
  const status = resolution === 'user_cancelled'
    ? '用户取消'
    : resolution === 'provider_cancelled'
      ? 'Provider 取消'
      : error
        ? '未完成'
        : '已回答'
  return (
    <div className={`question-result ${incomplete ? 'error' : ''}`} aria-label={`AskUserQuestion ${status}`}>
      <div className="question-result-head">
        <span>{status}</span>
        <small>
          {request.questions.length} 个问题
          {durationMs != null ? ` · 等待 ${(durationMs / 1000).toFixed(1)}s` : ''}
        </small>
      </div>
      <dl className="question-result-list">
        {request.questions.map((question) => (
          <div key={question.question}>
            <dt>{question.question}</dt>
            <dd>{answers?.[question.question] ?? (incomplete ? '未获得答案' : '答案已提交')}</dd>
          </div>
        ))}
      </dl>
      {!answers && output && <div className="question-result-fallback">{output}</div>}
      <details className="question-raw">
        <summary>查看原始输入与输出</summary>
        <div className="lbl">input</div>
        <pre>{JSON.stringify({ source, questions: request.questions }, null, 2)}</pre>
        {output && (
          <>
            <div className="lbl">output</div>
            <pre>{output.slice(0, 4000)}</pre>
          </>
        )}
      </details>
    </div>
  )
}
