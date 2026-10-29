import type { WorkflowClassifierAdapter, WorkflowClassifierIntent, WorkflowClassifierOutcome, WorkflowClassifierProbability } from '../shared/workflow-classifier'
import { workflowUsageFromClassifier, type WorkflowUsage } from '../shared/workflow-usage'

const DEFAULT_API_URL = 'https://api.typesafe.ai/v1/systemone'
const DEFAULT_MODEL = 'jev-latest'
const DEFAULT_TIMEOUT_MS = 15_000

type JsonRecord = Record<string, unknown>
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type TypeSafeWorkflowClassifierOptions = Readonly<{
  apiUrl?: string
  timeoutMs?: number
  fetch?: FetchLike
  resolveApiKey?: () => Promise<string | undefined>
}>

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined
}

function number(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function probabilityMap(value: unknown): WorkflowClassifierProbability | undefined {
  const input = record(value)
  if (!input || Object.keys(input).length === 0 || Object.values(input).some(item => !number(item) || item < 0 || item > 1)) return undefined
  return input as WorkflowClassifierProbability
}

function scoreCriteria(intent: WorkflowClassifierIntent): string[] | undefined {
  if (!intent.score || intent.score.min !== 0 || !Number.isSafeInteger(intent.score.max) || intent.score.max < 0) return undefined
  try {
    const parsed: unknown = JSON.parse(intent.criteria)
    if (!Array.isArray(parsed) || parsed.length !== intent.score.max + 1 || parsed.some(item => typeof item !== 'string')) return undefined
    return parsed
  } catch {
    return undefined
  }
}

function stateFor(intent: WorkflowClassifierIntent): JsonRecord {
  return {
    criteria: intent.criteria,
    inputs: intent.inputs.map(input => ({ nodeId: input.nodeId, path: [...input.path], value: input.value.state === 'known' ? input.value.value : undefined }))
  }
}

function questionFor(intent: WorkflowClassifierIntent): JsonRecord | undefined {
  if (intent.kind === 'bool') return { type: 'noul', instructions: intent.prompt }
  if (intent.kind === 'choice' && intent.choices?.length) {
    return { type: 'choice', instructions: intent.prompt, criteria: Object.fromEntries(intent.choices.map(choice => [choice, choice])) }
  }
  const criteria = scoreCriteria(intent)
  return criteria ? { type: 'score', instructions: intent.prompt, criteria } : undefined
}

function unavailable(intent: WorkflowClassifierIntent, reason: string): WorkflowClassifierOutcome {
  return { classifierId: intent.classifierId, state: 'unavailable', settled: true, provenance: 'unavailable', reason }
}

function unknown(intent: WorkflowClassifierIntent, reason: string, usage?: WorkflowUsage): WorkflowClassifierOutcome {
  return { classifierId: intent.classifierId, state: 'unknown', settled: false, provenance: 'unavailable', reason, ...(usage ? { usage } : {}) }
}

function completed(intent: WorkflowClassifierIntent, answer: JsonRecord, model: string, usage: WorkflowUsage): WorkflowClassifierOutcome {
  const source = `typesafe:${model}`
  if (intent.kind === 'bool') {
    if (answer.type !== 'noul' || !number(answer.noul) || answer.noul < 0 || answer.noul > 1) return unknown(intent, 'TypeSafe returned an invalid bool answer', usage)
    const probability = { true: answer.noul, false: 1 - answer.noul }
    return { classifierId: intent.classifierId, state: 'completed', settled: true, value: answer.noul >= 0.5, probability, confidence: Math.max(answer.noul, 1 - answer.noul), provenance: 'provider', source, usage }
  }
  if (intent.kind === 'choice') {
    const probability = probabilityMap(answer.probabilities)
    if (answer.type !== 'choice' || typeof answer.choice !== 'string' || !intent.choices?.includes(answer.choice) || !number(answer.confidence) || answer.confidence < 0 || answer.confidence > 1 || !probability || Object.keys(probability).some(choice => !intent.choices?.includes(choice))) return unknown(intent, 'TypeSafe returned an invalid choice answer', usage)
    return { classifierId: intent.classifierId, state: 'completed', settled: true, value: answer.choice, probability, confidence: answer.confidence, provenance: 'provider', source, usage }
  }
  const probability = probabilityMap(answer.probabilities)
  const legend = record(answer.legend)
  if (answer.type !== 'score' || !number(answer.score) || !intent.score || answer.score < intent.score.min || answer.score > intent.score.max || !number(answer.confidence) || answer.confidence < 0 || answer.confidence > 1 || !probability || !legend || Object.keys(legend).length !== intent.score.max - intent.score.min + 1) return unknown(intent, 'TypeSafe returned an invalid score answer', usage)
  return { classifierId: intent.classifierId, state: 'completed', settled: true, value: answer.score, probability, confidence: answer.confidence, provenance: 'provider', source, usage }
}

export function createTypeSafeWorkflowClassifierAdapter(apiKey: string | undefined, options: TypeSafeWorkflowClassifierOptions = {}): WorkflowClassifierAdapter {
  const apiUrl = options.apiUrl ?? DEFAULT_API_URL
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = options.fetch ?? fetch
  return async (intent, signal) => {
    let resolvedApiKey = apiKey
    try { resolvedApiKey ??= await options.resolveApiKey?.() } catch (error) {
      return unavailable(intent, `TypeSafe credential unavailable: ${String((error as Error).message)}`)
    }
    if (!resolvedApiKey) return unavailable(intent, 'TYPESAFE_API_KEY is not configured')
    const question = questionFor(intent)
    if (!question) return unavailable(intent, 'TypeSafe cannot represent this classifier rubric')
    if (intent.inputs.some(input => input.value.state !== 'known')) return unknown(intent, 'classifier input is unavailable')
    if (signal?.aborted) return unknown(intent, 'classifier stopped')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const abort = (): void => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const response = await fetchImpl(apiUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${resolvedApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: intent.model ?? DEFAULT_MODEL, state: stateFor(intent), questions: { classifier: question } }),
        signal: controller.signal
      })
      if (!response.ok) return { classifierId: intent.classifierId, state: 'failed', settled: true, provenance: 'unavailable', reason: `TypeSafe request failed (${response.status})` }
      let payload: unknown
      try { payload = JSON.parse(await response.text()) as unknown } catch { return unknown(intent, 'TypeSafe returned invalid JSON') }
      const body = record(payload)
      const usage = body ? record(body.usage) : undefined
      const usageValid = usage && nonNegativeInteger(usage.input_tokens) && nonNegativeInteger(usage.output_tokens)
      const model = body && typeof body.model === 'string' ? body.model : undefined
      const answers = body ? record(body.answers) : undefined
      const answer = answers ? record(answers.classifier) : undefined
      const workflowUsage = usageValid ? workflowUsageFromClassifier(usage.input_tokens as number, usage.output_tokens as number) : undefined
      return model && answers && workflowUsage && answer
        ? completed(intent, answer, model, workflowUsage)
        : unknown(intent, 'TypeSafe response omitted model, answers, usage, or answer', workflowUsage)
    } catch (error) {
      return unknown(intent, controller.signal.aborted ? (signal?.aborted ? 'classifier stopped' : 'TypeSafe request timed out') : `TypeSafe request error: ${String(error)}`)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
}
