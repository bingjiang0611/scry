import { bench, describe } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TraceEvent } from '@shared/trace'
import { applyTraceBatch, type Turn } from './format'
import { normalizeMarkdownForDisplay } from './components/MarkdownImpl'
import MarkdownImpl from './components/MarkdownImpl'
import { TurnStreamProjectionCache } from './turn-stream-projection'

const structuredEvent = (index: number): TraceEvent => ({
  id: `tool-${index}`,
  runId: 'run-bench',
  ts: '2026-09-16T00:00:00.000Z',
  kind: 'tool',
  stage: index % 2 === 0 ? 'tool_start' : 'tool_result',
  tool: 'read'
})
const deltaEvent = (index: number): TraceEvent => ({
  id: `delta-${index}`,
  runId: 'run-bench',
  ts: '2026-09-16T00:00:00.000Z',
  kind: 'model',
  stage: 'text_delta',
  messageId: 'message-live',
  text: 'token'
})

const structural = Array.from({ length: 10_000 }, (_, index) => structuredEvent(index))
const currentTurn: Turn = { runId: 'run-bench', userText: 'benchmark', items: structural, done: false }
const batch = Array.from({ length: 16 }, (_, index) => deltaEvent(index))
const markdown = Array.from({ length: 1_000 }, (_, index) =>
  `## Section ${index}\n\n| a | b |\n|---|---|\n| ${index} | **value** |\n\n\`inline-${index}\``
).join('\n\n')
const proseMarkdown = Array.from({ length: 1_000 }, (_, index) =>
  `Paragraph ${index}: ${'long prose '.repeat(8)}`
).join('\n\n')
const referenceMarkdown = `${proseMarkdown}\n\n[docs]: https://example.com\n\nSee [docs].`
const tableMarkdown = `| value | detail |\n| --- | --- |\n${Array.from({ length: 3_000 }, (_, index) => `| ${index} | ${'cell '.repeat(5)} |`).join('\n')}`
const codeMarkdown = `\`\`\`text\n${'code line\n'.repeat(8_000)}\`\`\``

describe('renderer streaming pressure', () => {
  bench('apply a 16-event batch to a 10k-event active turn', () => {
    applyTraceBatch([currentTurn], batch, new Set())
  })

  bench('reuse the structural projection while a 10k-event turn streams', () => {
    const cache = new TurnStreamProjectionCache()
    cache.project(structural)
    cache.project(structural.concat(batch))
  })

  bench('normalize about 80 KiB of markdown', () => {
    normalizeMarkdownForDisplay(markdown)
  })

  bench('server-render about 80 KiB of streaming markdown', () => {
    renderToStaticMarkup(<MarkdownImpl streaming>{markdown}</MarkdownImpl>)
  })

  bench('server-render about 80 KiB of completed GFM markdown', () => {
    renderToStaticMarkup(<MarkdownImpl>{markdown}</MarkdownImpl>)
  }, { iterations: 10, time: 0 })

  bench('server-render long heading-free prose', () => {
    renderToStaticMarkup(<MarkdownImpl>{proseMarkdown}</MarkdownImpl>)
  })

  bench('server-render long cross-document references', () => {
    renderToStaticMarkup(<MarkdownImpl>{referenceMarkdown}</MarkdownImpl>)
  })

  bench('server-render one huge table', () => {
    renderToStaticMarkup(<MarkdownImpl>{tableMarkdown}</MarkdownImpl>)
  })

  bench('server-render one long fenced block', () => {
    renderToStaticMarkup(<MarkdownImpl>{codeMarkdown}</MarkdownImpl>)
  })
})
