import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkflowClassifierIntent } from '../shared/workflow-classifier'
import { createTypeSafeWorkflowClassifierAdapter } from './typesafe-workflow-classifier'

const base = (kind: WorkflowClassifierIntent['kind'], extra: Partial<WorkflowClassifierIntent> = {}): WorkflowClassifierIntent => ({
  classifierId: 'classifier', workflowId: 'workflow', programRevision: 'a'.repeat(64), nodeId: 'node',
  frame: { frameId: 'frame', revision: 0, resultRef: { workflowId: 'workflow', key: 'intent', hash: 'b'.repeat(64) } },
  checkpointKey: 'checkpoint', recoveryGeneration: 'generation', createdAt: 1, kind, prompt: 'classify this', criteria: 'the rubric', inputRefs: [], inputs: [], ...extra
})

let server: Server | undefined
afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined })

async function localResponse(handler: (body: unknown, request: IncomingMessage, response: ServerResponse<IncomingMessage>) => void): Promise<string> {
  server = createServer((request, response) => {
    let text = ''
    request.on('data', chunk => { text += String(chunk) })
    request.on('end', () => handler(JSON.parse(text) as unknown, request, response))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('local server did not bind')
  const url = `http://127.0.0.1:${address.port}/v1/systemone`
  return url
}

describe('TypeSafe workflow classifier HTTP contract', () => {
  it('sends the official request and maps bool, choice, and score answers', async () => {
    const url = await localResponse((body, request, response) => {
      expect(request.headers.authorization).toBe('Bearer fixture-key')
      const questions = (body as { questions: Record<string, { type: string }> }).questions
      const type = questions.classifier.type
      const answer = type === 'noul' ? { type: 'noul', noul: 0.75 } : type === 'choice' ? { type: 'choice', choice: 'yes', confidence: 0.8, probabilities: { yes: 0.8, no: 0.2 } } : { type: 'score', score: 1.5, confidence: 0.6, legend: { '0': 'low', '1': 'medium', '2': 'high' }, probabilities: { '0': 0.1, '1': 0.3, '2': 0.6 } }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ model: 'jev-fixture', answers: { classifier: answer }, usage: { input_tokens: 1, output_tokens: 1 } }))
    })
    const adapter = createTypeSafeWorkflowClassifierAdapter('fixture-key', { apiUrl: url })
    await expect(adapter(base('bool'))).resolves.toMatchObject({ state: 'completed', value: true, confidence: 0.75, probability: { true: 0.75, false: 0.25 }, source: 'typesafe:jev-fixture' })
    await expect(adapter(base('choice', { choices: ['yes', 'no'] }))).resolves.toMatchObject({ state: 'completed', value: 'yes', confidence: 0.8, probability: { yes: 0.8, no: 0.2 } })
    await expect(adapter(base('score', { criteria: '["low","medium","high"]', score: { min: 0, max: 2 } }))).resolves.toMatchObject({ state: 'completed', value: 1.5, confidence: 0.6 })
  })

  it('reports HTTP rejection as failed without fabricating an answer', async () => {
    const url = await localResponse((_body, _request, response) => { response.writeHead(422); response.end('{"detail":"invalid"}') })
    await expect(createTypeSafeWorkflowClassifierAdapter('fixture-key', { apiUrl: url })(base('bool'))).resolves.toMatchObject({ state: 'failed', settled: true })
  })

  it('reports transport errors and timeout as unknown', async () => {
    const adapter = createTypeSafeWorkflowClassifierAdapter('fixture-key', { apiUrl: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 20 })
    await expect(adapter(base('bool'))).resolves.toMatchObject({ state: 'unknown', settled: false })
  })

  it('is unavailable without an explicit API key and does not call fetch', async () => {
    let called = false
    const adapter = createTypeSafeWorkflowClassifierAdapter(undefined, { fetch: async () => { called = true; throw new Error('must not call') } })
    await expect(adapter(base('bool'))).resolves.toMatchObject({ state: 'unavailable', settled: true, reason: 'TYPESAFE_API_KEY is not configured' })
    expect(called).toBe(false)
  })

  it('does not invent a score rubric that the canonical intent cannot represent', async () => {
    const adapter = createTypeSafeWorkflowClassifierAdapter('fixture-key', { fetch: async () => { throw new Error('must not call') } })
    await expect(adapter(base('score', { score: { min: 0, max: 2 } }))).resolves.toMatchObject({ state: 'unavailable', settled: true })
  })
})
