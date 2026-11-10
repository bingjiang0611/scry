import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, REQUIRED_CAPABILITIES } from './verify/summarize.mjs'

const tunnel = (route, extra = {}) => ({ lane: 'control', route, phase: 'open', tcpMs: 20, innerTLSMs: 60, pingMs: 30, totalMs: 120, multiplexed: true, colo: route === 'relay' ? 'HKG' : undefined, ...extra })

function scenario(label, { routes = ['relay'], localNetwork = true, capabilities = REQUIRED_CAPABILITIES, directRoutes = [], failures = 0, coldErrors = [], refreshMs = 80, confirmed = true, offline = { ms: 1400, hostOffline: true } } = {}) {
  const lines = [
    { event: 'environment', label, route: label.includes('relay') ? 'relay' : 'auto', localNetwork, rounds: 2 },
    ...(coldErrors.length ? coldErrors.map((error, index) => ({ event: 'cold-open', round: index + 1, ms: 700, error })) : [{ event: 'cold-open', round: 1, ms: 900 }, { event: 'cold-open', round: 2, ms: 950 }]),
    { event: 'catalog', pass: 'full', ms: 400, sessions: 230 },
    ...[0, 1, 2].map(() => ({ event: 'catalog', pass: 'refresh', ms: refreshMs, sessions: 230, ...(confirmed === null ? {} : { confirmed }) })),
    ...(offline ? [{ event: 'offline-probe', ...offline }] : []),
    { event: 'history', ms: 1200, turns: 40, session: 'x' },
    { event: 'tunnels', diagnostics: { hostId: 'h', capabilities, legacyHost: false, multiplexed: true, directRoutes, localNetworkAvailable: localNetwork, timings: routes.map((route) => tunnel(route)) } },
    { event: 'summary', coldMedianMs: 900, coldP90Ms: 950, warmMedianMs: routes.includes('direct') ? 15 : 180, warmP90Ms: 220, coldSamples: 2, warmSamples: 6 },
    { event: 'done', failures }
  ]
  return lines.map((line) => `NETBENCH ${JSON.stringify({ label, ...line })}`).join('\n') + '\n'
}

function results(files) {
  const dir = mkdtempSync(join(tmpdir(), 'scry-verify-'))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

const checksPass = JSON.stringify({ stages: [{ name: 'node-unit', status: 'pass' }, { name: 'swift-test', status: 'pass' }] })
const probe = (code) => `RELAYPROBE ${JSON.stringify({ event: 'summary', ok: 3, failed: 0, colos: ['HKG'], relayGenerations: [code === 4001 ? 'heartbeat-aware' : 'pre-heartbeat'], medianMs: { total: 300 } })}\n`

test('a complete, healthy run passes every required rule without quitting Scry', () => {
  const dir = results({
    'checks.json': checksPass,
    'netbench-wifi-relay.jsonl': scenario('wifi-relay'),
    'netbench-wifi-auto.jsonl': scenario('wifi-auto', { routes: ['relay', 'direct'], directRoutes: [{ host: '192.168.1.5', port: 47820 }] }),
    'relay-probe-mac.jsonl': probe(4001)
  })
  try {
    const acceptance = run(dir)
    assert.equal(acceptance.verdict, 'pass', JSON.stringify(acceptance.rules.filter((r) => r.status !== 'pass' && r.status !== 'info')))
    assert.match(readFileSync(join(dir, 'SUMMARY.md'), 'utf8'), /Verdict: \*\*pass\*\*/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an old host, a missing direct route, an unconfirmed refresh and a slow offline answer fail with reasons', () => {
  const dir = results({
    'checks.json': checksPass,
    'netbench-wifi-relay.jsonl': scenario('wifi-relay', { capabilities: ['ping'], offline: { ms: 5200, hostOffline: true } }),
    'netbench-wifi-auto.jsonl': scenario('wifi-auto', { refreshMs: 900, confirmed: false }),
    'relay-probe-mac.jsonl': probe(4001)
  })
  try {
    const { verdict, rules } = run(dir)
    assert.equal(verdict, 'fail')
    const status = Object.fromEntries(rules.map((r) => [r.id, r]))
    assert.equal(status['R3-transport:wifi-relay'].status, 'fail')
    assert.match(status['R3-transport:wifi-relay'].detail, /missing=mux/)
    assert.equal(status['R6-catalog:wifi-auto'].status, 'fail')
    assert.match(status['R6-catalog:wifi-auto'].detail, /confirmed 0\/3/)
    assert.equal(status['R6-catalog:wifi-relay'].status, 'pass', 'a slow but confirmed refresh is not a failure')
    assert.equal(status['R7-offline-fast'].status, 'fail')
    assert.match(status['R7-offline-fast'].detail, /slowestMs=5200/)
    assert.equal(status['R5-direct'].status, 'blocked', 'no advertised address is an environment precondition, not a defect')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('missing evidence is incomplete, never a pass; an undeployed relay only blocks the offline rule', () => {
  const dir = results({
    'netbench-wifi-relay.jsonl': scenario('wifi-relay', { confirmed: null }),
    'netbench-host-quit.jsonl': scenario('host-quit', { coldErrors: ['中继连接已关闭（1013 no_host_leg）'] }),
    'relay-probe-mac.jsonl': probe(1013)
  })
  try {
    const { verdict, rules } = run(dir)
    assert.equal(verdict, 'incomplete')
    const status = Object.fromEntries(rules.map((r) => [r.id, r]))
    assert.equal(status['R1-checks'].status, 'blocked')
    assert.equal(status['R5-direct'].status, 'blocked')
    assert.equal(status['R7-offline-fast'].status, 'blocked')
    assert.equal(status['R7-offline-fast'].required, false)
    assert.equal(status['R6-catalog:wifi-relay'].status, 'blocked', 'an old netBench without confirmation evidence cannot pass R6')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a run cut off before its done event fails', () => {
  const dir = results({
    'checks.json': checksPass,
    'netbench-wifi-relay.jsonl': scenario('wifi-relay').split('\n').filter((line) => !line.includes('"done"')).join('\n')
  })
  try {
    const { rules } = run(dir)
    assert.equal(rules.find((r) => r.id === 'R2-netbench-clean:wifi-relay').status, 'fail')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an unproven direct route on the open path fails R5b; a known-baseline check needs its control log', () => {
  const blocking = scenario('wifi-auto', { directRoutes: [{ host: '172.18.0.1', port: 47820 }] })
    .replace('"timings":[', '"timings":[{"lane":"bulk","route":"direct","phase":"open","error":"Connect timeout (900 ms)"},')
  const dir = results({
    'checks.json': JSON.stringify({ stages: [{ name: 'swift-test', status: 'pass' }, { name: 'ios-checks', status: 'known-baseline', baselineEvidence: 'logs/control-base-ios-checks.tail.txt' }, { name: 'install-mac', status: 'known-baseline' }] }),
    'netbench-wifi-auto.jsonl': blocking,
    'relay-probe-mac.jsonl': probe(4001)
  })
  try {
    const status = Object.fromEntries(run(dir).rules.map((r) => [r.id, r]))
    assert.equal(status['R5b-no-blocking-unproven-route:wifi-auto'].status, 'fail')
    assert.equal(status['R1-checks'].status, 'fail')
    assert.match(status['R1-checks'].detail, /install-mac \(known-baseline without baselineEvidence\)/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
