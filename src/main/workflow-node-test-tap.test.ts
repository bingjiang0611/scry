import { describe, expect, it } from 'vitest'
import { nodeTestReportState, parseNodeTestTap } from './workflow-node-test-tap'

const report = (footer: string, body = 'ok 1 - real\n1..1') => `TAP version 13\n${body}\n${footer}\n`
const validFooter = '# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1.25'

describe('bounded Node TAP evidence parser', () => {
  it('keeps only authoritative native runner counts and does not treat the root plan as total', () => {
    expect(parseNodeTestTap(report(validFooter), false)).toMatchObject({ state: 'available', source: 'node_test_tap', counts: { total: 1, suites: 0, passed: 1 } })
  })
  it('rejects escaped console counter text, duplicate counters, malformed and truncated reports', () => {
    const forged = report(validFooter, '# \\# tests 999\n# \\# pass 999\nok 1 - real\n1..1')
    expect(parseNodeTestTap(forged, false).state).toBe('available')
    expect(parseNodeTestTap(report(validFooter + '\n# tests 2'), false).state).toBe('unavailable')
    expect(parseNodeTestTap('TAP version 13\n1..1\n', false).state).toBe('unavailable')
    expect(parseNodeTestTap(report(validFooter), true).state).toBe('unavailable')
  })
  it.each([0, 1])('keeps independent discovery, execution and coverage unavailable with %s skipped', skipped => {
    const evidence = parseNodeTestTap(report(`# tests 1\n# suites 0\n# pass ${1 - skipped}\n# fail 0\n# cancelled 0\n# skipped ${skipped}\n# todo 0\n# duration_ms 1`, 'ok 1 - real\n1..1'), false)
    expect(evidence).toMatchObject({ state: 'available', counts: { skipped }, discovery: { state: 'unavailable' }, execution: { state: 'unavailable' }, coverage: { state: 'unavailable' } })
    expect(nodeTestReportState(evidence)).toBe(skipped ? 'incomplete' : 'passed')
  })
  it('does not equate a suite-level root plan with the reported test count', () => {
    const evidence = parseNodeTestTap(report('# tests 4\n# suites 1\n# pass 1\n# fail 1\n# cancelled 0\n# skipped 1\n# todo 1\n# duration_ms 1', 'ok 1 - group\nnot ok 2 - failure\n1..2'), false)
    expect(evidence).toMatchObject({ state: 'available', counts: { total: 4, suites: 1, passed: 1, failed: 1, skipped: 1, todo: 1 } })
    expect(nodeTestReportState(evidence)).toBe('failed')
  })
  it.each([
    report(validFooter.replace('# tests 1', '# tests 2')),
    report(validFooter.replace('# tests 1', '# tests 9007199254740992')),
    report(validFooter.replace('# pass 1', '# pass -1')),
    report(validFooter.replace('# pass 1', '# pass 01')),
    report(validFooter.replace('duration_ms 1.25', 'duration_ms Infinity')),
    report(validFooter).replace('TAP version 13', 'TAP version 14'),
    report(validFooter, '# tests 1\nok 1 - real\n1..1')
  ])('refuses inconsistent or unsupported native metadata %#', value => {
    const evidence = parseNodeTestTap(value, false)
    expect(evidence.state).toBe('unavailable')
    expect(nodeTestReportState(evidence)).toBe('incomplete')
  })
  it.each(['cancelled', 'todo'])('keeps %s reports incomplete, not green', field => {
    const evidence = parseNodeTestTap(report(validFooter.replace('# pass 1', '# pass 0').replace(`# ${field} 0`, `# ${field} 1`)), false)
    expect(evidence).toMatchObject({ state: 'available', counts: { [field]: 1 } })
    expect(nodeTestReportState(evidence)).toBe('incomplete')
  })
  it('does not pass an empty report', () => {
    const evidence = parseNodeTestTap(report(validFooter.replace('# tests 1', '# tests 0').replace('# pass 1', '# pass 0'), '1..0'), false)
    expect(evidence).toMatchObject({ state: 'available', counts: { total: 0 } })
    expect(nodeTestReportState(evidence)).toBe('incomplete')
  })
})
