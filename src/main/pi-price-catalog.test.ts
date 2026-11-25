import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPiCatalogPrices } from './pi-price-catalog'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'scry-pi-prices-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

function writeCatalog(content: unknown): void {
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
  writeFileSync(join(home, '.pi', 'agent', 'models-store.json'), JSON.stringify(content))
}

describe('Pi 模型目录里的单价', () => {
  it('把目录里带输入与输出单价的模型读成价格版本', () => {
    writeCatalog({
      'openai-codex': { models: [
        { id: 'fixture-model', provider: 'openai-codex', cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 } },
        { id: 'no-price', provider: 'openai-codex' },
        { id: 'partial', provider: 'openai-codex', cost: { input: 0.3 } }
      ] }
    })
    expect(readPiCatalogPrices(home, 1_700_000_000_000)).toEqual([{
      id: 'pi_model_catalog:openai-codex:fixture-model',
      provider: 'openai-codex',
      model: 'fixture-model',
      currency: 'USD',
      inputPerMillion: 0.2,
      outputPerMillion: 1.2,
      cacheReadPerMillion: 0.02,
      cacheWritePerMillion: 0.25,
      reasoningPerMillion: null,
      effectiveFrom: 1_700_000_000_000,
      effectiveTo: null,
      source: 'pi_model_catalog'
    }])
  })

  it('目录缺失或损坏时只当作没有价格', () => {
    expect(readPiCatalogPrices(home)).toEqual([])
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
    writeFileSync(join(home, '.pi', 'agent', 'models-store.json'), '{ not json')
    expect(readPiCatalogPrices(home)).toEqual([])
    writeFileSync(join(home, '.pi', 'agent', 'models-store.json'), '[]')
    expect(readPiCatalogPrices(home)).toEqual([])
  })
})
