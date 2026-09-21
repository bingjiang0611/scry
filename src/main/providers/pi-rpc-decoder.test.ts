import { once } from 'node:events'
import { Readable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import { describe, expect, it } from 'vitest'
import { createPiRpcDecoder } from './pi-rpc-decoder'
import { PI_RPC_MAX_FRAME_BYTES } from './pi'

async function decode(chunks: Iterable<string | Buffer>, limit = 1024): Promise<unknown[]> {
  const output: unknown[] = []
  const decoder = createPiRpcDecoder(limit)
  decoder.on('data', (value: unknown) => output.push(value))
  await pipeline(Readable.from(chunks), decoder)
  return output
}

describe('Pi RPC streaming projection', () => {
  it('drains a >64 MiB agent_end snapshot and immediately delivers the following settlement', async () => {
    const chunk = 'x'.repeat(1024 * 1024)
    function* wire(): Generator<string> {
      yield '{"messages":[{"role":"toolResult","content":[{"type":"text","text":"'
      for (let i = 0; i < 96; i++) yield chunk
      yield '"}]}],"type":"agent_end","willRetry":false}\n{"type":"agent_settled"}\n'
    }
    expect(await decode(wire(), PI_RPC_MAX_FRAME_BYTES)).toEqual([
      { type: 'agent_end', willRetry: false }, { type: 'agent_settled' }
    ])
  })

  it('projects large get_entries payloads to exact ancestry/roles regardless of key order', async () => {
    const message = { content: 'x'.repeat(4096), role: 'user', details: { oversized: 'y'.repeat(4096) } }
    const entries = [
      { message, id: 'user-1', type: 'message', parentId: 'compact-1' },
      { id: 'compact-1', parentId: 'baseline', type: 'compaction', summary: 'z'.repeat(4096) },
      { id: 'result-1', parentId: 'user-1', type: 'message', message: { ...message, role: 'toolResult' } }
    ]
    const wire = JSON.stringify({ type: 'response', success: true, id: '1', data: { entries, leafId: 'result-1' } })
    expect(await decode([wire])).toEqual([{
      type: 'response', success: true, id: '1', data: { leafId: 'result-1', entries: [
        { message: { role: 'user' }, id: 'user-1', type: 'message', parentId: 'compact-1' },
        { id: 'compact-1', parentId: 'baseline', type: 'compaction' },
        { id: 'result-1', parentId: 'user-1', type: 'message', message: { role: 'toolResult' } }
      ] }
    }])
  })

  it('preserves live tool termination, errors, usage, escaped keys and split UTF-8 without projection leaks', async () => {
    const events = [
      { type: 'turn_end', toolResults: [{ content: 'x'.repeat(4096) }], message: { role: 'assistant' } },
      { type: 'tool_execution_end', result: { terminate: true, content: [{ text: '中文😀\n"\\' }], messages: ['nested evidence'] }, isError: true },
      { type: 'message_end', message: { role: 'assistant', usage: { input: 12, cost: { total: 1.2e-7 } }, stopReason: 'toolUse' } },
      { type: 'response', id: '2', success: false, error: 'provider failed', 'data.entries.0.content': 'not a path', ['__proto__']: { safe: true } }
    ]
    const bytes = Buffer.from(events.map((event) => JSON.stringify(event)).join('\r\n') + '\n')
    expect(await decode(Array.from(bytes, (byte) => Buffer.from([byte])))).toEqual([
      { type: 'turn_end', message: { role: 'assistant' } }, ...events.slice(1)
    ])
  })

  it('delivers a complete response without waiting for another frame or EOF', async () => {
    const decoder = createPiRpcDecoder(1024)
    try {
      const received = new Promise<unknown>((resolve) => decoder.once('data', resolve))
      decoder.write('{"type":"response","id":"1"}\n')
      expect(await received).toEqual({ type: 'response', id: '1' })
    } finally {
      decoder.end()
      await finished(decoder)
    }
  })

  it.each([
    '{"type":"agent_end","messages":[{"content":"bad\\q"}]}',
    '{"type":"agent_end","messages":[{"content":"unfinished',
    '{"type":"agent_end","messages":[1,]}',
    '{"type":"response","data":{"entries":[{"message":{"content":tru}}]}}',
    'not-json', 'null', '[]'
  ])('rejects malformed or non-object input, including discarded payloads: %s', async (wire) => {
    await expect(decode([wire])).rejects.toThrow()
  })

  it('bounds nesting even inside an otherwise discarded snapshot', async () => {
    await expect(decode(['{"messages":' + '['.repeat(1024) + ']'.repeat(1024) + '}'])).rejects.toThrow('嵌套超过 1024 层')
  })

  it.each([
    '{"type":"message_end","message":{"content":"',
    '{"type":"tool_execution_end","result":"',
    '{"type":"response","data":{"unknown":"',
    '{"type":"agent_end","messages":[{"'
  ])('still bounds retained evidence and streamed keys: %s', async (prefix) => {
    const decoder = createPiRpcDecoder(1024)
    const failed = once(decoder, 'error')
    decoder.write(prefix)
    decoder.write('x'.repeat(2048))
    expect((await failed)[0]).toHaveProperty('message', expect.stringContaining('超过 64 MiB'))
  })
})
