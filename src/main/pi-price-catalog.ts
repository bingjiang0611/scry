import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { catalogPriceRows, type ModelPrice } from '../shared/model-price'

/**
 * Pi 把带单价的模型目录写在本机 `~/.pi/agent/models-store.json`。分析页要在
 * 没有新跑一轮之前也能给历史轮次折算金额，所以启动时只读地取一次单价；
 * 文件缺失、权限或格式不对都只是没有价格，不影响读取。
 */
export function readPiCatalogPrices(homeDir: string, nowMs = Date.now()): ModelPrice[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(homeDir, '.pi', 'agent', 'models-store.json'), 'utf8'))
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const models = Object.values(parsed as Record<string, unknown>).flatMap((entry) => {
    const list = entry && typeof entry === 'object' ? (entry as { models?: unknown }).models : undefined
    return Array.isArray(list) ? list : []
  })
  return catalogPriceRows(models, nowMs)
}
