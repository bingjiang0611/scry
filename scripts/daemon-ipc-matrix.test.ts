import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MATRIX_DOC, OPS_DOC, WORKBENCH_MATRIX_DOC, buildMatrix, collectChannels, loadRouting, protocolOps, renderMatrix, renderOps, renderWorkbenchMatrix, workbenchMethods } from './daemon-ipc-matrix.mjs'

const routing = loadRouting()
const matrix = buildMatrix(routing)

describe('daemon IPC routing matrix', () => {
  it('classifies every privileged channel and only privileged channels', () => {
    expect(matrix.channels).toBe(134)
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
    const channels = collectChannels().map((entry) => entry.channel)
    expect(channels.length).toBe(134)
    // Registered through a handler table and through the `handle(` parameter name; both
    // were missing from the first scan, which only matched handleTrusted('literal').
    expect(channels).toContain('sourceControl:read')
    expect(channels).toContain('sourceControl:loadDraft')
    expect(channels).toContain('workspaceSelection:validateBranch')
    expect(protocolOps().has('submit')).toBe(true)
    // steer has no device-facing op today, which is exactly why the matrix records a new one.
    expect(protocolOps().has('steer')).toBe(false)
    expect(workbenchMethods().get('terminal')?.has('terminalWrite')).toBe(true)
    expect(workbenchMethods().get('workspace')?.has('workspaceTrash')).toBe(true)
  })

  it('counts a shared handler table only when main registers it', () => {
    // The scan reads channel keys from `satisfies ChannelHandlers` tables; that is only
    // honest if every exported factory is actually registered in main.
    const tables = readFileSync(new URL('../src/main/bootstrap/startup-channels.ts', import.meta.url), 'utf8')
    const factories = [...tables.matchAll(/^export function (\w+ChannelHandlers)\(/gm)].map(([, name]) => name).filter((name) => name !== 'registerChannelHandlers')
    expect(factories.length).toBeGreaterThan(0)
    const registrations = collectChannels().map((entry) => entry.file)
    const sources = [...new Set(registrations)].map((file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')).join('\n')
    for (const factory of factories) expect(sources, `${factory} is never registered in main`).toMatch(new RegExp(`registerChannelHandlers\\(handleTrusted, ${factory}\\(`))
  })

  it('keeps both generated documents up to date', () => {
    expect(readFileSync(MATRIX_DOC, 'utf8')).toBe(renderMatrix(matrix))
    expect(readFileSync(WORKBENCH_MATRIX_DOC, 'utf8')).toBe(renderWorkbenchMatrix(matrix))
    expect(readFileSync(OPS_DOC, 'utf8')).toBe(renderOps(matrix, routing))
  })

  it('documents every new op next to its channels', () => {
    const ops = readFileSync(OPS_DOC, 'utf8')
    const used = new Set(matrix.rows.filter((row: { route: string }) => row.route === 'new-op').map((row: { target: string }) => row.target.slice(0, row.target.lastIndexOf(':'))))
    expect(used.size).toBe(18)
    for (const op of used) expect(ops).toContain(`| \`${op}\` |`)
    expect(join(OPS_DOC).endsWith('P3-ipc-ops.md')).toBe(true)
  })
})
// Batch 4 D1-D4: the review found gaps that change authorization semantics, so each fix
// is guarded by an assertion that fails on the data as it stood before the fix.
describe('daemon IPC routing decisions (D1-D4)', () => {
  const opsFile = JSON.parse(readFileSync(new URL('./daemon-ipc-ops.json', import.meta.url), 'utf8'))
  const rowFor = (channel: string) => routing.channels.find((row: { channel: string }) => row.channel === channel)

  it('D1 declares which callers may reach each new op', () => {
    for (const [name, op] of Object.entries(opsFile.ops as Record<string, { scopes?: string[] }>)) {
      expect(op.scopes, `${name} must declare scopes`).toBeInstanceOf(Array)
      expect((op.scopes ?? []).length, `${name} must list at least one scope`).toBeGreaterThan(0)
      for (const scope of op.scopes ?? []) expect(['local', 'remote']).toContain(scope)
    }
  })

  it('D1 keeps every remote-capable new op on an approved list', () => {
    const approvals = JSON.parse(readFileSync(new URL('./daemon-ipc-remote-approvals.json', import.meta.url), 'utf8'))
    const approved = new Set(approvals.approved)
    for (const [name, op] of Object.entries(opsFile.ops as Record<string, { scopes?: string[] }>)) {
      if ((op.scopes ?? []).includes('remote')) expect(approved, `${name} exposes remote without maintainer approval`).toContain(name)
    }
  })

  it('D2 records the semantic difference of every forwarded op', () => {
    const differences = routing.differences as Record<string, string>
    for (const row of routing.channels.filter((item: { route: string }) => item.route === 'forward')) {
      expect(differences[row.channel], `${row.channel} must state whether the forward is equivalent`).toBeTruthy()
    }
    for (const channel of ['agent:start', 'agent:deleteSession']) expect(differences[channel]).toMatch(/scope/i)
    // G1: naming a difference is not enough. Every non-equivalent forward must say how
    // the daemon reconciles it (policy by grant scope, or a separate op), otherwise the
    // local App silently loses evidence the phone projection trims away.
    for (const [channel, difference] of Object.entries(differences)) {
      if (!difference.startsWith('不同')) continue
      expect(difference, `${channel} states a difference without saying how it is handled`)
        .toMatch(/scope|op\b/)
    }
  })

  it('D3 splits the channels that would write the daemon authorization input', () => {
    for (const channel of ['agent:chooseFolder', 'agent:recentFolders', 'agent:removeRecentFolder']) {
      const row = rowFor(channel)
      expect(row.route, `${channel} must not stay in main`).toBe('split')
      expect(row.main, `${channel} must say what stays in main`).toBeTruthy()
      expect(row.op, `${channel} must name the daemon op`).toBeTruthy()
    }
    for (const channel of ['workspace:resolveFile', 'workspace:readKnown', 'workspace:readPageKnown', 'workspace:openKnownExternal']) {
      expect(rowFor(channel).source, `${channel} must take known projects from the daemon`).toMatch(/^daemon:/)
    }
  })

  it('D4 documents how a revoked App enrolls again and when the secret exists', () => {
    const design = readFileSync(join(__dirname, '../docs/plans/remote-runtime-v2/P3-batch4-design.md'), 'utf8')
    const section = design.slice(design.indexOf('## 13.2'), design.indexOf('## 13.3'))
    for (const required of ['secret 生命周期', '重新入网', '单实例']) expect(section).toContain(required)
  })
})
