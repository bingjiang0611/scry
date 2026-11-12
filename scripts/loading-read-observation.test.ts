import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'

const source = ts.createSourceFile('loading-smoke.tsx', readFileSync(new URL('./fixtures/loading-smoke.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'request')!
const code = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

afterEach(() => vi.useRealTimers())

function fixture(fail: boolean) {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const records: Array<{ kind: string; end?: number; failed?: boolean }> = []
  const window = new EventTarget()
  const request = runInNewContext(`${code}\nrequest`, {
    records, window, Event, fail, delay: 60, performance: { now: Date.now }, setTimeout, queueMicrotask
  }) as (kind: string, value: () => number) => Promise<number>
  return { records, window, request }
}

it.each([false, true])('observes a real pending session read without waiting for a frame (fail=%s)', async fail => {
  const { records, window, request } = fixture(fail)
  const observed: string[] = []
  queueMicrotask(() => observed.push('commit'))
  window.addEventListener('loading-fixture-session-read', () => {
    expect(records[0].kind).toBe('session')
    expect(records[0].end).toBeUndefined()
    observed.push('pending')
  })
  const pending = request('session', () => 42)
  const outcome = fail ? expect(pending).rejects.toThrow('fixture source unavailable') : expect(pending).resolves.toBe(42)
  expect(observed).toEqual([])
  await Promise.resolve()
  expect(observed).toEqual(['commit', 'pending'])
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(60)
  await outcome
  expect(records[0]).toMatchObject({ end: 60, failed: fail })
})

it('does not report unrelated reads as pending session reads', async () => {
  const { window, request } = fixture(false)
  const observed = vi.fn()
  window.addEventListener('loading-fixture-session-read', observed)
  const pending = request('skills', () => 42)
  await vi.advanceTimersByTimeAsync(60)
  await expect(pending).resolves.toBe(42)
  expect(observed).not.toHaveBeenCalled()
})
