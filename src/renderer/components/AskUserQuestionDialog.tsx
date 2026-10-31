import { useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { AgentIntervention, AgentQuestionRequest, AgentQuestionResponse } from '@shared/runtime'
import type { ProviderId } from '@shared/provider'
import Markdown from './MarkdownImpl'
import { Icon } from './primitives/Icon'
import { QUESTIONNAIRE_COPY } from '../constants/copy'

const providerLabels = {
  claude: 'Claude',
  codex: 'Codex',
  qoder: 'Qoder',
  opencode: 'OpenCode',
  pi: 'Pi'
} satisfies Record<ProviderId, string>

const GENERIC_OPTION_DESCRIPTIONS = new Set(['选择此项'])
const GENERATED_FREE_TEXT_LABELS = new Set(['type something', 'type something.'])

export function questionDisplayCopy(header: string, question: string): { header: string; question: string } {
  const cleanHeader = header.trim()
  const cleanQuestion = question.trim()
  if (cleanHeader !== cleanQuestion) return { header: cleanHeader, question: cleanQuestion }
  const bracketed = cleanQuestion.match(/^\[([^\]\n]{1,16})\]\s*(.+)$/)
  return bracketed
    ? { header: bracketed[1].trim(), question: bracketed[2].trim() }
    : { header: '', question: cleanQuestion }
}

export function isGeneratedFreeTextOption(label: string): boolean {
  return GENERATED_FREE_TEXT_LABELS.has(label.trim().toLowerCase())
}

export function optionDisplayCopy(label: string, description: string): {
  label: string
  description: string
  recommended: boolean
} {
  let cleanLabel = label.trim().replace(/^\d+[.)、]\s*/, '')
  const recommended = /[（(]推荐[）)]/.test(cleanLabel)
  cleanLabel = cleanLabel.replace(/\s*[（(]推荐[）)]\s*/g, ' ').trim()
  let cleanDescription = description.trim()
  if (GENERIC_OPTION_DESCRIPTIONS.has(cleanDescription) || cleanDescription === `${label.trim()}这次操作`) {
    cleanDescription = ''
  }
  if (!cleanDescription) {
    const split = cleanLabel.match(/^(.+?)\s+[—–]\s+(.+)$/)
    if (split) {
      cleanLabel = split[1].trim()
      cleanDescription = split[2].trim()
    }
  }
  return { label: cleanLabel, description: cleanDescription, recommended }
}

export interface QuestionDraft {
  selected: string[]
  useOther: boolean
  other: string
}

export type QuestionDrafts = Record<string, QuestionDraft>

export function initialQuestionDrafts(request: AgentQuestionRequest): QuestionDrafts {
  return Object.fromEntries(
    request.questions.map((question) => [
      question.question,
      { selected: [], useOther: question.options.length === 0, other: question.initialValue ?? '' }
    ])
  )
}

export function buildQuestionAnswers(request: AgentQuestionRequest, drafts: QuestionDrafts): Record<string, string> | null {
  const answers: Record<string, string> = {}
  for (const question of request.questions) {
    const draft = drafts[question.question]
    if (!draft || (question.allowCustomAnswer === false && draft.useOther)) return null
    if (!question.multiSelect) {
      const selectedOption = question.options.find((option) => option.label === draft.selected[0])
      const answer = draft.useOther ? draft.other.trim() : selectedOption?.answerValue ?? selectedOption?.label
      if (!answer) return null
      answers[question.question] = answer
      continue
    }
    const selectedOptions = question.options.filter((option) => draft.selected.includes(option.label))
    const selected = selectedOptions.map((option) => option.answerValue ?? option.label)
    if (draft.useOther) {
      const other = draft.other.trim()
      if (!other) return null
      selected.push(other)
    }
    if (selected.length === 0) return null
    const separator = selectedOptions.some((option) => option.answerValue) ? ',' : ', '
    answers[question.question] = selected.join(separator)
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
  const groupedPiQuestionnaire = request.providerId === 'pi' && request.source === 'pi_questionnaire'
  const submittingRef = useRef(false)
  const [drafts, setDrafts] = useState<QuestionDrafts>(() => initialQuestionDrafts(request))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const answers = useMemo(() => buildQuestionAnswers(request, drafts), [drafts, request])
  const missing = request.questions.filter((question) => !buildQuestionAnswers({ ...request, questions: [question] }, drafts)).length
  const statusCopy = groupedPiQuestionnaire
    ? missing > 0 ? QUESTIONNAIRE_COPY.pending(missing) : QUESTIONNAIRE_COPY.review
    : missing > 0 ? QUESTIONNAIRE_COPY.selectToContinue : QUESTIONNAIRE_COPY.ready
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
      answers,
      ...(request.providerId === 'pi' && request.source === 'pi_extension_ui:select' &&
        request.questions.length === 1 && drafts[request.questions[0].question].useOther
        ? { nativeCustomAnswer: true } : {}),
      ...(groupedPiQuestionnaire ? {
        nativeCustomAnswers: request.questions.filter((question) => drafts[question.question].useOther).map((question) => question.question)
      } : {})
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
      return { ...current, [questionText]: { ...draft, selected, useOther: multiSelect && !groupedPiQuestionnaire ? draft.useOther : false } }
    })
  }

  const toggleOther = (questionText: string, multiSelect: boolean): void => {
    setDrafts((current) => {
      const draft = current[questionText]
      const useOther = !draft.useOther
      return {
        ...current,
        // Pi's native multi-select accepts either indices or custom text, not a mixture.
        [questionText]: { ...draft, useOther, selected: multiSelect && !groupedPiQuestionnaire ? draft.selected : [] }
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
      if (input.type === 'text') {
        event.preventDefault()
        submit()
      }
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
      <h3 id={titleId} className="visually-hidden">
        {providerLabels[request.providerId ?? 'claude']} 需要你的选择
      </h3>
      {queuedCount > 1 && <span className="question-queue">还有 {queuedCount - 1} 组待回答</span>}

      <div className="question-dialog-body">
        {request.questions.map((question, questionIndex) => {
          const draft = drafts[question.question]
          const display = questionDisplayCopy(question.header, question.question)
          const closedChoice = question.allowCustomAnswer === false
          const options = closedChoice ? question.options : question.options.filter((option) => !isGeneratedFreeTextOption(option.label))
          const selectedPreviews = options.filter(
            (option) => draft.selected.includes(option.label) && option.preview
          )
          return (
              <fieldset className="question-field" key={question.question}>
                <legend>
                  {request.questions.length > 1 && (
                    <span className="question-index">{String(questionIndex + 1).padStart(2, '0')}</span>
                  )}
                  <span>
                    {display.header && <b>{display.header}</b>}
                    <span>{display.question}</span>
                  </span>
                </legend>
                {/* Provider 自己给出的触发原因；它是待审阅的数据，不是 Scry 的风险结论。 */}
                {question.warning && (
                  <p className="question-warning" role="note">{question.warning}</p>
                )}
                {options.length === 0 && !closedChoice ? question.inputMode === 'multiline' ? (
                  <textarea
                    autoFocus={questionIndex === 0}
                    className="question-other-input question-free-text-input question-editor-input"
                    aria-label={`${display.header || '问题'}的回答`}
                    value={draft.other}
                    maxLength={100_000}
                    placeholder={question.placeholder || '请输入多行内容…'}
                    rows={8}
                    onChange={(event) => setDrafts((current) => ({
                      ...current,
                      [question.question]: { ...current[question.question], useOther: true, other: event.target.value }
                    }))}
                  />
                ) : (
                  <input
                    autoFocus={questionIndex === 0}
                    className="question-other-input question-free-text-input"
                    aria-label={`${display.header || '问题'}的回答`}
                    value={draft.other}
                    maxLength={4_000}
                    placeholder={question.placeholder || '请输入回答…'}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [question.question]: { ...current[question.question], useOther: true, other: event.target.value }
                      }))
                    }
                  />
                ) : (
                  <div className="question-options">
                    {options.map((option, optionIndex) => {
                      const checked = draft.selected.includes(option.label)
                      const copy = optionDisplayCopy(option.label, option.description)
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
                            <b>
                              {copy.label}
                              {copy.recommended && <em className="question-recommended">推荐</em>}
                            </b>
                            {copy.description && <small>{copy.description}</small>}
                          </span>
                        </label>
                      )
                    })}
                    {!closedChoice && <label className={`question-option question-other ${draft.useOther ? 'selected' : ''}`}>
                      <input
                        type={question.multiSelect ? 'checkbox' : 'radio'}
                        name={`question-${request.questionId}-${questionIndex}`}
                        checked={draft.useOther}
                        onChange={() => toggleOther(question.question, question.multiSelect)}
                      />
                      <span>
                        <b>{request.providerId === 'pi' && request.source === 'pi_extension_ui:select' ? '输入自定义回答' : '其他'}</b>
                        <small>输入一个不在上述选项中的回答</small>
                      </span>
                    </label>}
                    {!closedChoice && draft.useOther && (
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
                )}
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
          {error ? <span className="question-error">{error}</span> : statusCopy}
        </div>
        <div className="question-actions">
          <button type="button" className="btn question-cancel" disabled={submitting} onClick={cancel}>
            {QUESTIONNAIRE_COPY.cancel}
          </button>
          <button type="submit" className="btn primary question-submit" disabled={!answers || submitting}>
            {submitting ? QUESTIONNAIRE_COPY.submitting : groupedPiQuestionnaire ? QUESTIONNAIRE_COPY.submitAll : QUESTIONNAIRE_COPY.submit}
            <span className="question-shortcut" aria-hidden="true">{QUESTIONNAIRE_COPY.submitShortcut}</span>
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
      {/* 已回答的问答是人工决定记录：状态与等待压成一行等宽小字，问题与答案按行对齐，
          答案落在右轨（与等待时长同一条右边）。判词、问题数与等待来源都不变。 */}
      <div className="question-result-head">
        <span>
          <Icon name={incomplete ? 'alert' : 'check'} />
          {status}
        </span>
        <small>{request.questions.length} 个问题</small>
        {durationMs != null && <small className="question-result-wait">等待 {(durationMs / 1000).toFixed(1)}s</small>}
      </div>
      <dl className="question-result-list">
        {request.questions.map((question) => {
          const answer = answers?.[question.question]
          return (
            <div key={question.question}>
              <dt>{question.question}</dt>
              <dd className={answer == null ? 'missing' : undefined}>
                {answer ?? (incomplete ? '未获得答案' : '答案已提交')}
              </dd>
            </div>
          )
        })}
      </dl>
      {!answers && output && <div className="question-result-fallback">{output}</div>}
      <details className="question-raw">
        <summary>
          <Icon name="chevronRight" />
          <span>查看原始输入与输出</span>
        </summary>
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
