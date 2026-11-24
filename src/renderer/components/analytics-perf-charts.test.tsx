import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LlmComparisonRound } from '@shared/llm-performance'
import { compareModels } from './llm-performance-data'
import { PerfTable } from './analytics-perf-charts'

const round = (overrides: Partial<LlmComparisonRound> & Pick<LlmComparisonRound, 'model' | 'metrics'>): LlmComparisonRound => ({
  ts: Date.now(), providerId: 'pi', state: 'completed', ...overrides
})

const groups = compareModels([
  round({ model: 'model-a', metrics: { speed: 12, firstToken: 2, firstOutput: 9 } }),
  round({ model: 'model-a', metrics: { speed: 14, firstToken: 3 } }),
  round({ model: 'model-b', metrics: { firstToken: 4, firstOutput: 20 }, state: 'failed' }),
  round({ model: 'model-c', metrics: { speed: 30 } }),
  round({ model: 'model-a', metrics: {}, state: 'failed' })
])

const render = (): string => renderToStaticMarkup(<PerfTable groups={groups} selected={groups[0].key}
  colorOf={() => 'var(--analytics-series-0)'} gatewayOf={(_agent, model) => model === 'model-c' ? 'openai-codex' : undefined}
  onSelect={() => {}} />)

describe('LLM 性能对比表', () => {
  it('表头带单位，分布列表头也带单位', () => {
    const html = render()
    expect(html).toContain('输出速度<span class="analytics-th-unit">token/秒</span>')
    expect(html).toContain('首 token<span class="analytics-th-unit">秒</span>')
    expect(html).toContain('输出速度分布（token/秒）')
  })

  it('网关作副标题，不当成分组行', () => {
    const html = render()
    expect(html).toContain('openai-codex')
    expect(html).toContain('Pi')
    expect(html).not.toContain('custom-gateway')
    expect(html).not.toContain('unknown')
  })

  it('缺值留空，不写「—」，也不出现「所选：」', () => {
    const html = render()
    expect(html).not.toContain('—')
    expect(html).not.toContain('所选：')
    expect(html).toContain('<td class="is-num is-strong"></td>')
  })

  it('没有成功轮次的模型不成行，失败轮次只作为覆盖说明', () => {
    const html = render()
    expect(html).toContain('model-a')
    expect(html).toContain('model-c')
    expect(html).not.toContain('model-b')
    expect(html).toContain('1 轮未成功')
    expect(html).toContain('title="2 轮 · 1 轮未成功"')
  })

  it('没有实测值的模型不画分布', () => {
    const html = render()
    expect((html.match(/class="analytics-dist"/g) ?? []).length).toBe(2)
  })
})
