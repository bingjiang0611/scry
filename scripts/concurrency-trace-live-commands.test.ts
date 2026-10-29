import { beforeAll, describe, expect, it } from 'vitest'
import {
  CLIENT_COMMANDS,
  CLIENT_FAULT_TYPE,
  CLIENT_MESSAGE_TYPE,
  CLIENT_REPLY_TYPE,
  DRIVER_METHODS,
  SNAPSHOT_MESSAGE_TYPE,
  driverExpression,
  parseClientRequest,
  parseDriverCall,
  parsePairPayload,
  parsePeerPayload,
  parseVisitTarget
} from './fixtures/concurrency-trace-live-commands'

interface ProtocolModule { CLIENT_MESSAGE_TYPE: string; CLIENT_REPLY_TYPE: string; CLIENT_FAULT_TYPE: string; SNAPSHOT_MESSAGE_TYPE: string; CLIENT_COMMANDS: string[]; DRIVER_METHODS: string[] }

// Plain ESM without declarations: loaded through a computed specifier like the build test.
let protocol: ProtocolModule
beforeAll(async () => { protocol = await import(new URL('./fixtures/concurrency-trace-live-protocol.mjs', import.meta.url).href) as ProtocolModule })

const request = (overrides: Record<string, unknown> = {}) => ({ type: CLIENT_MESSAGE_TYPE, requestId: 'r-1', command: 'status', payload: {}, ...overrides })
const target = (overrides: Record<string, unknown> = {}) => ({
  visitId: 'w0-p0-t0',
  connectionId: 'conn-1',
  cwd: '/tmp/workspace',
  providerId: 'codex',
  nativeRunId: 'run-1',
  session: { sessionId: 'sess-1', externalSessionId: 'ext-1', providerId: 'codex', cwd: '/tmp/workspace', label: 'sess-1', ts: 1 },
  ...overrides
})

describe('concurrency trace live client command protocol', () => {
  it('keeps the TypeScript enum equal to the runtime protocol the launcher imports', () => {
    expect([...CLIENT_COMMANDS]).toEqual(protocol.CLIENT_COMMANDS)
    expect([...DRIVER_METHODS]).toEqual(protocol.DRIVER_METHODS)
    expect(CLIENT_MESSAGE_TYPE).toBe(protocol.CLIENT_MESSAGE_TYPE)
    expect(CLIENT_REPLY_TYPE).toBe(protocol.CLIENT_REPLY_TYPE)
    expect(CLIENT_FAULT_TYPE).toBe(protocol.CLIENT_FAULT_TYPE)
    // The snapshot name is the fixed C1 bootstrap protocol, reused unchanged.
    expect(SNAPSHOT_MESSAGE_TYPE).toBe('concurrency-snapshot')
  })

  it('accepts only the closed command enum from the parent', () => {
    expect(parseClientRequest(request())).toEqual({ type: CLIENT_MESSAGE_TYPE, requestId: 'r-1', command: 'status', payload: {} })
    expect(parseClientRequest(request({ command: 'driver', payload: { peerId: 0, method: 'round', args: [] } })).command).toBe('driver')
    expect(() => parseClientRequest(request({ command: 'eval' }))).toThrow(/unexpected_command/)
    expect(() => parseClientRequest(request({ command: 'executeJavaScript' }))).toThrow(/unexpected_command/)
    expect(() => parseClientRequest(request({ type: 'other' }))).toThrow(/invalid_request/)
    expect(() => parseClientRequest(request({ requestId: '' }))).toThrow(/invalid_request/)
    expect(() => parseClientRequest(request({ payload: [] }))).toThrow(/invalid_payload/)
    expect(() => parseClientRequest(null)).toThrow(/invalid_request/)
  })

  it('refuses a driver method outside the fixed renderer surface', () => {
    expect(parseDriverCall({ peerId: 0, method: 'beginVisit', args: [target()] })).toEqual({ peerId: 0, method: 'beginVisit', args: [target()], injectFailure: false })
    expect(parseDriverCall({ peerId: 1, method: 'round' }).args).toEqual([])
    expect(parseDriverCall({ peerId: 0, method: 'round', injectFailure: true }).injectFailure).toBe(true)
    for (const method of ['eval', 'start', 'window.__scryTraceLive.round()', 'beginVisit;process.exit(1)']) {
      expect(() => parseDriverCall({ peerId: 0, method, args: [] })).toThrow(/unexpected_driver_method/)
    }
    expect(() => parseDriverCall({ peerId: -1, method: 'round' })).toThrow(/invalid_peer/)
    expect(() => parseDriverCall({ peerId: '0', method: 'round' })).toThrow(/invalid_peer/)
    expect(() => parseDriverCall({ peerId: 0, method: 'round', args: 'round()' })).toThrow(/invalid_arguments/)
    expect(DRIVER_METHODS).toEqual(['state', 'beginVisit', 'ready', 'round', 'endVisit', 'takeViews', 'releaseViews'])
  })

  it('validates pair, finish and counters payloads before the privileged side sees them', () => {
    expect(parsePairPayload({ peerId: 0, label: 'peer-0', invitation: 'scry-desktop1:abc', directory: '/tmp/peer-0' }))
      .toEqual({ peerId: 0, label: 'peer-0', invitation: 'scry-desktop1:abc', directory: '/tmp/peer-0' })
    expect(() => parsePairPayload({ peerId: 0, label: '', invitation: 'x', directory: '/tmp' })).toThrow(/invalid_label/)
    expect(() => parsePairPayload({ peerId: 0, label: 'p', invitation: '', directory: '/tmp' })).toThrow(/invalid_invitation/)
    expect(() => parsePairPayload({ peerId: 0, label: 'p', invitation: 'x' })).toThrow(/invalid_directory/)
    expect(parsePeerPayload({ peerId: 2 })).toEqual({ peerId: 2 })
    expect(() => parsePeerPayload({})).toThrow(/invalid_peer/)
  })

  it('binds the visit target session to the same cwd and provider', () => {
    const parsed = parseVisitTarget(target())
    expect(parsed).toMatchObject({ visitId: 'w0-p0-t0', connectionId: 'conn-1', cwd: '/tmp/workspace', providerId: 'codex', nativeRunId: 'run-1' })
    // The validated host session is returned, not just checked: main forwards its real id.
    expect(parsed.session).toEqual({ sessionId: 'sess-1', externalSessionId: 'ext-1', providerId: 'codex', cwd: '/tmp/workspace', label: 'sess-1', ts: 1 })
    expect(parsed.session.externalSessionId).toBe('ext-1')
    expect(parseVisitTarget(target({ agentProfileId: 'profile-1' }))).toMatchObject({ agentProfileId: 'profile-1' })
    expect(() => parseVisitTarget(target({ nativeRunId: '' }))).toThrow(/invalid_target/)
    expect(() => parseVisitTarget(target({ session: undefined }))).toThrow(/invalid_target/)
    const session = (overrides: Record<string, unknown>) => ({ session: { sessionId: 'sess-1', externalSessionId: 'ext-1', providerId: 'codex', cwd: '/tmp/workspace', label: 'sess-1', ts: 1, ...overrides } })
    expect(() => parseVisitTarget(target(session({ providerId: 'claude' })))).toThrow(/target_session_provider_mismatch/)
    expect(() => parseVisitTarget(target(session({ cwd: '/tmp/other' })))).toThrow(/target_session_cwd_mismatch/)
    // A live run always recorded a host session id; an unnamed session is refused instead
    // of being replaced by an empty string.
    expect(() => parseVisitTarget(target(session({ externalSessionId: undefined })))).toThrow(/target_session_missing_external_id/)
    expect(() => parseVisitTarget('beginVisit')).toThrow(/invalid_target/)
  })

  it('builds the renderer expression from the enum and JSON-escaped arguments only', () => {
    expect(driverExpression('round', [])).toBe('window.__scryTraceLive.round(...[])')
    const expression = driverExpression('beginVisit', [target({ cwd: '/tmp/quote"s and ); process.exit(1); (' })])
    expect(expression.startsWith('window.__scryTraceLive.beginVisit(...[')).toBe(true)
    // The injected text stays inside a JSON string, so it cannot become code.
    expect(expression).toContain('quote\\"s and ); process.exit(1); (')
    expect(expression.match(/window\.__scryTraceLive\./g)).toHaveLength(1)
  })
})
