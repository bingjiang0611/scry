import { renderToStaticMarkup } from 'react-dom/server'
import { bench, describe } from 'vitest'
import type { TraceEvent } from '@shared/trace'
import type { Turn } from '../format'
import { AssistantTurn } from './ChatTurnAssistant'

const timestamp = '2026-01-01T00:00:00.000Z'
const items: TraceEvent[] = []
for (let index = 0; index < 72; index++) {
  const toolUseId = `tool-${index}`
  items.push({
    id: `text-${index}`,
    runId: 'giant-turn',
    ts: timestamp,
    kind: 'model',
    stage: 'text',
    text: `## Step ${index}\n\n${'Completed detailed work. '.repeat(80)}`
  })
  items.push({
    id: `tool-start-${index}`,
    runId: 'giant-turn',
    ts: timestamp,
    kind: 'tool',
    stage: 'tool_start',
    tool: 'read',
    toolUseId,
    input: { path: `/workspace/file-${index}.ts` },
    filePath: `/workspace/file-${index}.ts`
  })
  items.push({
    id: `tool-result-${index}`,
    runId: 'giant-turn',
    ts: timestamp,
    kind: 'tool',
    stage: 'tool_result',
    tool: 'read',
    toolUseId,
    text: `result ${index}`,
    durationMs: index + 1
  })
  items.push({
    id: `thinking-${index}`,
    runId: 'giant-turn',
    ts: timestamp,
    kind: 'model',
    stage: 'thinking',
    thinking: `Reasoning ${index}: ${'inspect evidence '.repeat(24)}`
  })
}
items.push({
  id: 'final-text',
  runId: 'giant-turn',
  ts: timestamp,
  kind: 'model',
  stage: 'text',
  text: `## Result\n\n${'Final verified result. '.repeat(100)}`
})

const turn: Turn = {
  runId: 'giant-turn',
  userText: 'benchmark a giant archived turn',
  done: true,
  items
}

describe('giant archived turn rendering', () => {
  bench('server-render 289 interleaved events', () => {
    renderToStaticMarkup(
      <AssistantTurn
        turn={turn}
        selectedId={null}
        onSelect={() => {}}
      />
    )
  }, { iterations: 5, warmupIterations: 1, time: 0 })
})
