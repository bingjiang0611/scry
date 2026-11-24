import { describe, expect, it } from 'vitest'
import { catalogPriceRows } from '../shared/model-price'

// Q6：Codex app-server 不给金额；金额按同一份价格来源（Pi 模型目录的单价）折算。
describe('模型目录价格', () => {
  it('只保留有输入与输出单价的模型，并记下每个百万 Token 的美元单价', () => {
    const rows = catalogPriceRows([
      { id: 'model-x', provider: 'openai-codex', cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 } },
      { id: 'model-free', provider: 'openai-codex', cost: { input: 0, output: 0 } },
      { id: 'model-partial', provider: 'openai-codex', cost: { input: 1 } },
      { model: 'model-noid', provider: 'openai-codex', cost: { input: 1, output: 2 } }
    ], 1_700_000_000_000)

    expect(rows).toEqual([{
      id: 'pi_model_catalog:openai-codex:model-x',
      provider: 'openai-codex',
      model: 'model-x',
      currency: 'USD',
      inputPerMillion: 4,
      outputPerMillion: 20,
      cacheReadPerMillion: 0.4,
      cacheWritePerMillion: 5,
      reasoningPerMillion: null,
      effectiveFrom: 1_700_000_000_000,
      effectiveTo: null,
      source: 'pi_model_catalog'
    }])
  })
})
