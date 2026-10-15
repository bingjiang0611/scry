import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import {
  TRACE_EVENT_FALLBACK_BYTES,
  TraceOutputBridge,
  traceEventByteSize,
  type TraceBacklogState,
  type TraceBatch,
  type TraceOutputBridgeOptions
} from './trace-output'

const event = (id: string, text = ''): TraceEvent => ({
  id,
  runId: 'run-1',
  ts: '',
  kind: 'model',
  stage: 'text_delta',
  text
})

const sizeOf = (candidate: TraceEvent): number => traceEventByteSize(candidate)

interface Harness {
  bridge: TraceOutputBridge
  sent: TraceBatch[]
  health: TraceBacklogState[]
  /** 只跑本轮开始时已经挂上的定时器；无界 drain 会掩盖重排 bug。 */
  runPendingTimers: (ticks?: number) => void
  pendingTimers: () => number
  canSend: { value: boolean }
}

function harness(overrides: Partial<TraceOutputBridgeOptions> = {}): Harness {
  const sent: TraceBatch[] = []
  const health: TraceBacklogState[] = []
  let timers: (() => void)[] = []
  const canSend = { value: true }
  const bridge = new TraceOutputBridge({
    canSend: () => canSend.value,
    send: (payload) => sent.push(payload),
    publishHealth: (state) => health.push(state),
    schedule: (fn) => {
      timers.push(fn)
      return () => {
        timers = timers.filter((candidate) => candidate !== fn)
      }
    },
    ...overrides
  })
  return {
    bridge,
    sent,
    health,
    canSend,
    pendingTimers: () => timers.length,
    runPendingTimers: (ticks = 1) => {
      for (let tick = 0; tick < ticks; tick++) {
        const due = timers
        timers = []
        for (const fn of due) fn()
      }
    }
  }
}

describe('trace event byte measurement', () => {
  it('measures the full serialized event in UTF-8, not JS string length', () => {
    const ascii = event('e1', 'abcd')
    expect(sizeOf(ascii)).toBe(Buffer.byteLength(JSON.stringify(ascii), 'utf8'))

    // 非 ASCII：JS length 会低估。中文在 UTF-8 里是 3 字节/字。
    const unicode = event('e2', '中文证据'.repeat(10))
    expect(unicode.text!.length).toBe(40)
    expect(sizeOf(unicode)).toBeGreaterThan(40 * 2)
    expect(sizeOf(unicode)).toBe(Buffer.byteLength(JSON.stringify(unicode), 'utf8'))

    // 星外字符（surrogate pair）同样按真实 UTF-8 字节计。
    const emoji = event('e3', '🙈'.repeat(100))
    expect(sizeOf(emoji)).toBeGreaterThanOrEqual(400)
  })

  it('counts large nested structured payloads that the old text-only estimate ignored', () => {
    const nested: TraceEvent = {
      ...event('e-nested'),
      kind: 'tool',
      stage: 'tool_use',
      input: { rows: Array.from({ length: 2000 }, (_unused, index) => ({ index, path: `/repo/file-${index}.ts` })) },
      runtimeMetadata: { replacesStreamedText: true, notes: 'x'.repeat(5000) }
    }
    // 全部嵌套字段都进入计量：远超任何仅看 text/thinking/output 的估计。
    expect(sizeOf(nested)).toBeGreaterThan(50_000)
    expect(sizeOf(nested)).toBe(Buffer.byteLength(JSON.stringify(nested), 'utf8'))
  })

  it('falls back to a conservative size when an event cannot be serialized', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const broken = { ...event('e-circular'), input: circular } as unknown as TraceEvent
    // 绝不能算成 0 字节而绕过限额。
    expect(sizeOf(broken)).toBe(TRACE_EVENT_FALLBACK_BYTES)
  })

  it('caches by event identity so each event is serialized once', () => {
    const reused = event('e-cached', 'y'.repeat(1000))
    const first = sizeOf(reused)
    expect(sizeOf(reused)).toBe(first)
    expect(first).toBeGreaterThan(1000)
  })
})

describe('TraceOutputBridge bounded delivery', () => {
  it('batches in arrival order and caps events per IPC message', () => {
    const { bridge, sent, runPendingTimers } = harness({ maxBatchEvents: 3 })
    for (let index = 0; index < 7; index++) bridge.push(event(`e${index}`))
    runPendingTimers()
    bridge.flushAll()
    expect(sent.map((batch) => batch.events.map((item) => item.id))).toEqual([
      ['e0', 'e1', 'e2'],
      ['e3', 'e4', 'e5'],
      ['e6']
    ])
  })

  it('caps bytes per IPC message but never splits a single event', () => {
    const big = event('big', 'x'.repeat(5000))
    const small = event('small')
    const { bridge, sent } = harness({ maxBatchEvents: 100, maxBatchBytes: sizeOf(small) + 10 })
    bridge.push(big)
    bridge.push(small)
    bridge.flushAll()
    expect(sent[0].events.map((item) => item.id)).toEqual(['big'])
    expect(sent[0].bytes).toBe(sizeOf(big))
    expect(sent[1].events.map((item) => item.id)).toEqual(['small'])
  })

  it('leaves no retry timer while credit-blocked and resumes on ACK without reordering', () => {
    const first = event('e0')
    const { bridge, sent, runPendingTimers, pendingTimers } = harness({
      maxBatchEvents: 1,
      highWaterBytes: sizeOf(first)
    })
    bridge.push(first)
    bridge.push(event('e1'))
    runPendingTimers()
    expect(sent.map((batch) => batch.events[0].id)).toEqual(['e0'])
    expect(bridge.snapshot().bufferedEvents).toBe(1)
    // 关键：被 high-water 挡住时不留任何定时器，否则就是 20Hz 空转。
    expect(pendingTimers()).toBe(0)

    bridge.ack(sent[0])
    expect(sent.map((batch) => batch.events[0].id)).toEqual(['e0', 'e1'])
    expect(pendingTimers()).toBe(0)
    expect(bridge.snapshot().degraded).toBe(false)
  })

  it('schedules nothing further after a lost ACK, no matter how long it idles', () => {
    const first = event('e0')
    const { bridge, sent, runPendingTimers, pendingTimers } = harness({
      maxBatchEvents: 1,
      highWaterBytes: sizeOf(first)
    })
    bridge.push(first)
    bridge.push(event('e1'))
    runPendingTimers()
    expect(pendingTimers()).toBe(0)

    // ACK 永久丢失：再怎么跑时钟都不该出现新的定时器或新的发送。
    runPendingTimers(50)
    expect(pendingTimers()).toBe(0)
    expect(sent).toHaveLength(1)
    expect(bridge.snapshot().bufferedEvents).toBe(1)
  })

  it('does not arm a coalescing timer for pushes that arrive while blocked', () => {
    const first = event('e0')
    const { bridge, runPendingTimers, pendingTimers } = harness({
      maxBatchEvents: 1,
      highWaterBytes: sizeOf(first)
    })
    bridge.push(first)
    runPendingTimers()
    expect(pendingTimers()).toBe(0)
    for (let index = 1; index <= 20; index++) bridge.push(event(`e${index}`))
    // 20 次 push 全在阻塞期到达：一个定时器都不该留下。
    expect(pendingTimers()).toBe(0)
    expect(bridge.snapshot().bufferedEvents).toBe(20)
  })

  it('does not poll while the renderer cannot receive, and resumes on rendererReady', () => {
    const { bridge, sent, canSend, runPendingTimers, pendingTimers } = harness({ maxBatchEvents: 10 })
    canSend.value = false
    bridge.push(event('e0'))
    bridge.push(event('e1'))
    runPendingTimers()
    expect(sent).toHaveLength(0)
    expect(pendingTimers()).toBe(0)
    runPendingTimers(50)
    expect(pendingTimers()).toBe(0)

    canSend.value = true
    bridge.rendererReady()
    expect(sent[0].events.map((item) => item.id)).toEqual(['e0', 'e1'])
    expect(pendingTimers()).toBe(0)
  })

  it('arms at most one coalescing timer while events flow normally', () => {
    const { bridge, sent, pendingTimers, runPendingTimers } = harness({ maxBatchEvents: 100 })
    for (let index = 0; index < 10; index++) bridge.push(event(`e${index}`))
    expect(pendingTimers()).toBe(1)
    runPendingTimers()
    expect(sent[0].events).toHaveLength(10)
    expect(pendingTimers()).toBe(0)
  })

  it('rejects malformed or byte-mismatched ACK values instead of silently unblocking the queue', () => {
    const { bridge, sent, runPendingTimers } = harness()
    bridge.push(event('e0'))
    runPendingTimers()
    const receipt = sent[0]
    expect(() => bridge.ack({ ...receipt, bytes: -1 })).toThrow('trace 输出确认无效')
    expect(() => bridge.ack({ ...receipt, batchId: 1.5 })).toThrow('trace 输出确认无效')
    expect(() => bridge.ack({ ...receipt, generation: Number.POSITIVE_INFINITY })).toThrow('trace 输出确认无效')
    expect(() => bridge.ack({ ...receipt, bytes: 64 * 1024 * 1024 })).toThrow('trace 输出确认无效')
    expect(() => bridge.ack({ ...receipt, bytes: receipt.bytes + 1 })).toThrow('trace 输出确认字节不匹配')
  })

  it('ignores duplicate and pre-reset ACKs without releasing newer renderer credit', () => {
    const first = event('e0')
    const { bridge, sent, runPendingTimers } = harness({ maxBatchEvents: 1, highWaterBytes: sizeOf(first) })
    bridge.push(first)
    runPendingTimers()
    const oldReceipt = sent[0]
    expect(bridge.ack(oldReceipt)).toBe(true)
    expect(bridge.ack(oldReceipt)).toBe(false)

    bridge.reset()
    bridge.push(event('e1'))
    bridge.push(event('e2'))
    runPendingTimers()
    expect(sent.at(-1)?.events[0].id).toBe('e1')
    expect(bridge.ack(oldReceipt)).toBe(false)
    expect(bridge.snapshot().bufferedEvents).toBe(1)
  })

  it('degrades the live mirror honestly under overload and keeps the delivered prefix contiguous', () => {
    const warnings: string[] = []
    const unit = sizeOf(event('probe'))
    const { bridge, sent, health } = harness({
      maxBatchEvents: 1,
      highWaterBytes: 1,
      maxBufferBytes: unit * 3,
      warn: (message) => warnings.push(message)
    })
    for (let index = 0; index < 6; index++) bridge.push(event(`e${index}`))

    const state = bridge.snapshot()
    expect(state.degraded).toBe(true)
    // 过载时只放弃镜像最新事件：前 3 条（1 在途 + 2 缓冲）保留，后 3 条如实记为跳过。
    expect(state.skippedEvents).toBe(3)
    expect(state.bufferedEvents).toBe(2)
    expect(warnings).toEqual(['live trace mirror degraded after IPC backlog exceeded safety limit'])
    expect(sent.flatMap((batch) => batch.events.map((item) => item.id))).toEqual(['e0'])
    bridge.flushAll()
    expect(sent.flatMap((batch) => batch.events.map((item) => item.id))).toEqual(['e0', 'e1', 'e2'])
    expect(health.at(-1)).toMatchObject({ degraded: true, skippedEvents: 3 })
  })

  it('条数预算同样会触发降级：海量小事件不能绕过字节预算', () => {
    const { bridge, sent, health } = harness({
      maxBatchEvents: 1,
      highWaterBytes: 1,
      maxBufferEvents: 3,
      maxBufferBytes: 1024 * 1024
    })
    for (let index = 0; index < 6; index++) bridge.push(event(`e${index}`))

    const state = bridge.snapshot()
    expect(state.degraded).toBe(true)
    // 1 在途 + 2 缓冲 = 3 条已到上限；其余 3 条如实计为跳过。
    expect(state.skippedEvents).toBe(3)
    expect(state.bufferedEvents).toBe(2)
    expect(health.at(-1)).toMatchObject({ degraded: true, skippedEvents: 3 })
    // ACK 释放额度后又能继续接收，证明条数计数器不会泄漏。
    bridge.ack(sent[0])
    bridge.push(event('e6'))
    expect(bridge.snapshot().skippedEvents).toBe(3)
  })

  it('asks for an authoritative resync after the backlog drains, then clears degradation', () => {
    const unit = sizeOf(event('probe'))
    const { bridge, health, sent } = harness({
      maxBatchEvents: 1,
      maxBufferBytes: unit,
      highWaterBytes: 1
    })
    bridge.push(event('e0'))
    bridge.push(event('e1'))
    expect(bridge.snapshot()).toMatchObject({ degraded: true, skippedEvents: 1, resyncRequired: false })

    bridge.ack(sent[0])
    expect(bridge.snapshot()).toMatchObject({ degraded: true, resyncRequired: true })
    expect(health.at(-1)?.resyncRequired).toBe(true)

    bridge.resynchronized()
    expect(bridge.snapshot()).toMatchObject({ degraded: false, skippedEvents: 0, resyncRequired: false })
  })

  it('flushAll ignores the high-water mark so terminal state is never left truncated', () => {
    const { bridge, sent } = harness({ maxBatchEvents: 1, highWaterBytes: 1 })
    bridge.push(event('e0'))
    bridge.push(event('e1'))
    bridge.push(event('e2'))
    bridge.flushAll()
    expect(sent.flatMap((batch) => batch.events.map((item) => item.id))).toEqual(['e0', 'e1', 'e2'])
    expect(bridge.snapshot().bufferedEvents).toBe(0)
  })

  it('reset clears in-flight accounting so a remounted renderer cannot deadlock the bridge', () => {
    const { bridge, sent, health } = harness({ maxBatchEvents: 1, highWaterBytes: 1 })
    bridge.push(event('e0'))
    bridge.push(event('e1'))
    expect(bridge.snapshot().inFlightBytes).toBeGreaterThan(0)
    bridge.reset()
    expect(bridge.snapshot()).toMatchObject({ inFlightBytes: 0, bufferedEvents: 0, bufferedBytes: 0 })
    // 丢掉未交付的缓冲后必须要求权威对齐，不能让 live 视图静默缺事件。
    expect(bridge.snapshot().resyncRequired).toBe(true)
    expect(health.at(-1)?.resyncRequired).toBe(true)
    bridge.push(event('e2'))
    bridge.flushAll()
    expect(sent.at(-1)?.events.map((item) => item.id)).toEqual(['e2'])
  })

  it('reset on an idle bridge does not invent a resync requirement', () => {
    const { bridge, health } = harness()
    bridge.reset()
    expect(bridge.snapshot()).toMatchObject({ degraded: false, resyncRequired: false })
    expect(health).toHaveLength(0)
  })
})
