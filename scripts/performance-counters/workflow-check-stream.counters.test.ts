import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { freezeWorkflowCheck } from '../../src/main/workflow-check'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'

const meter = vi.hoisted(() => ({ active: false, executable: '', chunks: 0, bytes: 0 }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, createReadStream: (...args: Parameters<typeof createReadStream>) => {
    const stream = actual.createReadStream(...args)
    if (String(args[0]) !== meter.executable) return stream
    const iterate = stream[Symbol.asyncIterator].bind(stream)
    stream[Symbol.asyncIterator] = async function* () {
      for await (const chunk of { [Symbol.asyncIterator]: iterate }) {
        if (meter.active) { meter.chunks++; meter.bytes += chunk.byteLength }
        yield chunk
      }
    }
    return stream
  } }
})

async function operation(times = 1) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'scry-check-stream-')))
  meter.active = false
  meter.executable = await realpath(process.execPath)
  const bytes = (await stat(meter.executable)).size
  const digest = createHash('sha256')
  // Independent expected digest, outside the observed production operation.
  for await (const chunk of createReadStream(meter.executable, { highWaterMark: 4 * 1024 * 1024 })) digest.update(chunk)
  const expected = digest.digest('hex')
  try {
    await writeFile(join(directory, 'check.cjs'), "process.stdout.write('checked')\n")
    meter.chunks = meter.bytes = 0
    meter.active = true
    for (let index = 0; index < times; index++) {
      const check = await freezeWorkflowCheck({ argv: [process.execPath, 'check.cjs'], cwd: '.', parser: 'exit_code' }, directory, { PATH: '/usr/bin:/bin' })
      expect(check.executableHash).toBe(expected)
      expect(check.executable).toBe(meter.executable)
      expect(check.entrypoint!.path).toBe(join(directory, 'check.cjs'))
    }
    expect(meter.bytes).toBe(bytes * times)
    expect(meter.chunks).toBeGreaterThan(0)
    return { chunks: meter.chunks, bytes: meter.bytes }
  } finally { meter.active = false; await rm(directory, { recursive: true, force: true }) }
}

describe('native check executable fingerprint stream workload', () => {
  it('counts delivered chunks and every executable byte over five unchanged approvals', async () => {
    const runs = await repeatCounters(defaultRepeats, () => operation())
    const meta = { scenario: 'workflow.check-fingerprint-stream', layer: 'io', unit: 'count',
      workload: 'checks=1;executable=current-node;approvals=1;replica-entrypoint=1;fingerprint=sha256;content-revalidation=complete',
      source: 'pass-through async iterator around production fs.createReadStream of the canonical Node executable; every delivered byte counted and independently hashed' }
    writeCollector('workflow-check-stream', [
      measured({ ...meta, metric: 'io.executable.stream-chunks' }, runs.chunks),
      measured({ ...meta, metric: 'io.executable.stream-bytes' }, runs.bytes)
    ])
  })

  it('detects one added complete approval without omitting any executable bytes', async () => {
    const ordinary = await operation(), duplicated = await operation(2)
    expect(duplicated.bytes).toBe(ordinary.bytes * 2)
    expect(duplicated.chunks).toBeGreaterThan(ordinary.chunks)
  })
})
