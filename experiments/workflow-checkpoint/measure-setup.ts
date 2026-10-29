import { beforeEach, afterEach } from 'vitest'
import { FileWorkflowStore } from '../../src/main/workflow-store'

type Meter = { calls: Record<string, number>; inclusiveMs: Record<string, number> }
type PrimitiveStore = {
  atomicText(name: string, text: string, options?: { deferDirectorySync?: boolean }): Promise<void>
}
const prototype = FileWorkflowStore.prototype as unknown as PrimitiveStore
const original = prototype.atomicText
const owners = new WeakMap<object, Meter>()
let rows = new Set<Meter>()

function kind(name: string): string {
  if (name.endsWith('.frame.json')) return 'frame'
  if (name.endsWith('.planning.json')) return 'planning'
  if (/^[A-Za-z0-9_-]{1,96}\.json$/.test(name) && !['preferences.json', 'settings.json'].includes(name)) return 'root'
  return 'artifact'
}
prototype.atomicText = async function(...args) {
  let meter = owners.get(this)
  if (!meter) {
    meter = { calls: {}, inclusiveMs: {} }
    owners.set(this, meter)
    rows.add(meter)
  }
  const type = kind(args[0]), started = performance.now()
  meter.calls[type] = (meter.calls[type] ?? 0) + 1
  try { await original.apply(this, args) }
  finally { meter.inclusiveMs[type] = (meter.inclusiveMs[type] ?? 0) + performance.now() - started }
}
beforeEach(() => { rows = new Set() })
afterEach(context => {
  const calls: Record<string, number> = {}, inclusiveMs: Record<string, number> = {}
  for (const meter of rows) {
    for (const [key, count] of Object.entries(meter.calls)) calls[key] = (calls[key] ?? 0) + count
    for (const [key, ms] of Object.entries(meter.inclusiveMs)) inclusiveMs[key] = (inclusiveMs[key] ?? 0) + ms
  }
  console.log('CHECKPOINT_METHODS', JSON.stringify({ name: context.task.name, state: context.task.result?.state,
    scope: 'instrumented FileWorkflowStore objects; inclusive method time, not OS fsync or subprocess IO', calls, inclusiveMs,
    incompleteIfFailed: true }))
})
