import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MATRIX_DOC, OPS_DOC, buildMatrix, collectChannels, loadRouting, protocolOps, renderMatrix, renderOps, workbenchMethods } from './daemon-ipc-matrix.mjs'

const routing = loadRouting()
const matrix = buildMatrix(routing)

describe('daemon IPC routing matrix', () => {
  it('classifies every privileged channel and only privileged channels', () => {
    expect(matrix.channels).toBe(119)
    expect(matrix.defects).toEqual([])
    expect(matrix.rows.filter((row) => row.route === 'main').length).toBeGreaterThan(0)
    expect(matrix.rows.filter((row) => row.route === 'forward').length).toBeGreaterThan(0)
    expect(matrix.rows.filter((row) => row.route === 'new-op').length).toBeGreaterThan(0)
  })

  it('fails when a new channel has no routing decision', () => {
    const withoutOne = { ...routing, channels: routing.channels.filter((row: { channel: string }) => row.channel !== 'agent:steer') }
    const result = buildMatrix(withoutOne)
    expect(result.defects).toContainEqual({ channel: 'agent:steer', problem: expect.stringContaining('no routing decision') })
    expect(result.rows.some((row: { channel: string }) => row.channel === 'agent:steer')).toBe(false)
  })

  it('fails when a routed channel is deleted or a forward op does not exist', () => {
    const orphan = buildMatrix({ ...routing, channels: [...routing.channels, { channel: 'agent:removed', route: 'main', why: 'gone' }] })
    expect(orphan.defects).toContainEqual({ channel: 'agent:removed', problem: expect.stringContaining('no longer registered') })
    const wrongOp = buildMatrix({
      ...routing,
      channels: routing.channels.map((row: { channel: string; op?: string }) => row.channel === 'agent:start' ? { ...row, op: 'dispatchEverything' } : row)
    })
    expect(wrongOp.defects).toContainEqual({ channel: 'agent:start', problem: expect.stringContaining('not in the dispatch vocabulary') })
    const noReason = buildMatrix({
      ...routing,
      channels: routing.channels.map((row: { channel: string; why?: string }) => row.channel === 'app:setTheme' ? { channel: row.channel, route: 'main' } : row)
    })
    expect(noReason.defects).toContainEqual({ channel: 'app:setTheme', problem: expect.stringContaining('needs a reason') })
  })

  it('fails when a new op drifts from its channel or loses its schema', () => {
    const renamed = buildMatrix({
      ...routing,
      channels: routing.channels.map((row: { channel: string; method?: string }) => row.channel === 'agent:steer' ? { ...row, method: 'steerRun' } : row)
    })
    expect(renamed.defects).toContainEqual({ channel: 'agent:steer', problem: expect.stringContaining('last segment') })
    const noSchema = buildMatrix({ ...routing, ops: { ...routing.ops, runControl: { path: 'controls', request: 'r', response: 's' } } })
    expect(noSchema.defects).toContainEqual({ channel: 'agent:steer', problem: expect.stringContaining('missing authorize') })
    const badPath = buildMatrix({
      ...routing,
      channels: routing.channels.map((row: { channel: string; path?: string }) => row.channel === 'agent:steer' ? { ...row, path: 'nowhere' } : row)
    })
    expect(badPath.defects).toContainEqual({ channel: 'agent:steer', problem: expect.stringContaining('unknown user path') })
  })

  it('reads its own inputs instead of trusting an empty scan', () => {
    expect(collectChannels().length).toBe(119)
    expect(protocolOps().has('submit')).toBe(true)
    // steer has no device-facing op today, which is exactly why the matrix records a new one.
    expect(protocolOps().has('steer')).toBe(false)
    expect(workbenchMethods().get('terminal')?.has('terminalWrite')).toBe(true)
    expect(workbenchMethods().get('workspace')?.has('workspaceTrash')).toBe(true)
  })

  it('keeps both generated documents up to date', () => {
    expect(readFileSync(MATRIX_DOC, 'utf8')).toBe(renderMatrix(matrix))
    expect(readFileSync(OPS_DOC, 'utf8')).toBe(renderOps(matrix, routing))
  })

  it('documents every new op next to its channels', () => {
    const ops = readFileSync(OPS_DOC, 'utf8')
    const used = new Set(matrix.rows.filter((row: { route: string }) => row.route === 'new-op').map((row: { target: string }) => row.target.slice(0, row.target.lastIndexOf(':'))))
    expect(used.size).toBe(17)
    for (const op of used) expect(ops).toContain(`| \`${op}\` |`)
    expect(join(OPS_DOC).endsWith('P3-ipc-ops.md')).toBe(true)
  })
})