import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

type FileCall = {
  operation: 'sync' | 'readFile'
  method: string
  path: string | null
  fd: number | null
  flags: string | number | null
  outcome?: 'read' | 'error'
  errorCode?: string | null
  returnedBytes?: number
}

type ProbeReport = {
  counters: { fsync: number }
  fileCalls: FileCall[]
  fileCallsTruncated: boolean
}

function runProbe(body: string, setup = ''): ProbeReport {
  const directory = mkdtempSync(join(tmpdir(), 'scry-file-probe-'))
  const log = join(directory, 'probe.jsonl')
  const data = join(directory, 'data.txt')
  writeFileSync(data, 'payload')
  try {
    const script = `
      const fs = require('node:fs')
      const assert = require('node:assert/strict')
      const data = ${JSON.stringify(data)}
      ${setup}
      require(${JSON.stringify(resolve('scripts/concurrent-performance-probe.cjs'))})
      ;(async () => { ${body} })().catch(error => { console.error(error); process.exitCode = 1 })
    `
    const child = spawnSync(process.execPath, ['--input-type=commonjs', '-e', script], {
      cwd: directory,
      env: { HOME: directory, PATH: process.env.PATH, SCRY_CONCURRENT_ROLE: 'hook', SCRY_CONCURRENT_LOG: log },
      encoding: 'utf8'
    })
    expect(child.error).toBeUndefined()
    expect(child.status, child.stderr).toBe(0)
    return JSON.parse(readFileSync(log, 'utf8')) as ProbeReport
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

it('records Node file API attempts without changing native values, errors or FileHandle binding', () => {
  const report = runProbe(`
    assert.equal(fs.readFileSync(data, 'utf8'), 'payload')
    assert.equal(await fs.promises.readFile(data, 'utf8'), 'payload')
    const handle = await fs.promises.open(data, 'r+')
    await handle.sync()
    await handle.datasync()
    await handle.close()
    const fd = fs.openSync(data, 'r+')
    assert.equal(fs.readFileSync(fd, 'utf8'), 'payload')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    assert.throws(() => fs.readFileSync(data + '.missing'), { code: 'ENOENT' })
  `)
  expect(report.fileCallsTruncated).toBe(false)
  expect(report.counters.fsync).toBe(3)
  const syncs = report.fileCalls.filter(call => call.operation === 'sync')
  expect(syncs.map(call => call.method)).toEqual(['FileHandle.sync', 'FileHandle.datasync', 'fs.fsyncSync'])
  expect(syncs.slice(0, 2).every(call => call.path?.endsWith('/data.txt') && call.flags === 'r+')).toBe(true)
  expect(syncs[2]).toMatchObject({ path: null, fd: expect.any(Number) })
  const reads = report.fileCalls.filter(call => call.operation === 'readFile')
  expect(reads).toHaveLength(4)
  expect(reads.some(call => call.path?.endsWith('/data.txt.missing'))).toBe(true)
  expect(reads.some(call => call.path === null && typeof call.fd === 'number')).toBe(true)
})

it('distinguishes successful payload reads from missing-file attempts for every native read API', () => {
  const report = runProbe(`
    assert.equal(fs.readFileSync(data).toString(), 'payload')
    assert.throws(() => fs.readFileSync(data + '.missing'), { code: 'ENOENT' })
    assert.equal((await fs.promises.readFile(data)).toString(), 'payload')
    await assert.rejects(fs.promises.readFile(data + '.missing'), { code: 'ENOENT' })
    await new Promise((resolve, reject) => fs.readFile(data, (error, value) => {
      if (error) return reject(error)
      assert.equal(value.toString(), 'payload')
      resolve()
    }))
    await new Promise(resolve => fs.readFile(data + '.missing', error => {
      assert.equal(error.code, 'ENOENT')
      resolve()
    }))
  `)
  const reads = report.fileCalls.filter(call => call.operation === 'readFile')
  expect(reads).toHaveLength(6)
  expect(reads.filter(call => call.outcome === 'read')).toHaveLength(3)
  expect(reads.filter(call => call.outcome === 'read').map(call => call.returnedBytes)).toEqual([7, 7, 7])
  expect(reads.filter(call => call.outcome === 'error').map(call => call.errorCode)).toEqual(['ENOENT', 'ENOENT', 'ENOENT'])
})

it('keeps counters complete and marks bounded metadata as truncated', () => {
  const report = runProbe('for (let index = 0; index < 20001; index++) fs.fsyncSync(17)', 'fs.fsyncSync = () => undefined')
  expect(report.counters.fsync).toBe(20001)
  expect(report.fileCalls).toHaveLength(20000)
  expect(report.fileCallsTruncated).toBe(true)
})

it('preserves a sync failure instead of reporting it as success', () => {
  const report = runProbe(
    "assert.throws(() => fs.fsyncSync(19), { code: 'EIO', message: 'synthetic sync failure' })",
    "fs.fsyncSync = () => { const error = new Error('synthetic sync failure'); error.code = 'EIO'; throw error }"
  )
  expect(report.counters.fsync).toBe(1)
  expect(report.fileCalls).toEqual([expect.objectContaining({ operation: 'sync', method: 'fs.fsyncSync', path: null, fd: 19 })])
  expect(report.fileCallsTruncated).toBe(false)
})
