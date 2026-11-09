import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, REQUIRED_CAPABILITIES } from './verify/summarize.mjs'

const tunnel = (route, extra = {}) => ({ lane: 'control', route, tcpMs: 20, innerTLSMs: 60, pingMs: 30, totalMs: 120, multiplexed: true, colo: route === 'relay' ? 'HKG' : undefined, ...extra })

function scenario(label, { routes = ['relay'], localNetwork = true, capabilities = REQUIRED_CAPABILITIES, directRoutes = [], failures = 0, coldErrors = [], refreshMs = 80 } = {}) {
  const lines = [
    { event: 'environment', label, route: label.includes('relay') ? 'relay' : 'auto', localNetwork, rounds: 2 },
    ...(coldErrors.length ? coldErrors.map((error, index) => ({ event: 'cold-open', round: index + 1, ms: 700, error })) : [{ event: 'cold-open', round: 1, ms: 900 }, { event: 'cold-open', round: 2, ms: 950 }]),
    { event: 'catalog', pass: 'full', ms: 400, sessions: 230 },
    { event: 'catalog', pass: 'refresh', ms: refreshMs, sessions: 230 },
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

test('a complete, healthy run passes every required rule', () => {
  const dir = results({
    'checks.json': checksPass,
    'netbench-wifi-relay.jsonl': scenario('wifi-relay'),
    'netbench-wifi-auto.jsonl': scenario('wifi-auto', { routes: ['relay', 'direct'], directRoutes: [{ host: '192.168.1.5', port: 47820 }] }),
    'netbench-host-quit.jsonl': scenario('host-quit', { coldErrors: ['Mac 当前不在线（中继未看到它的连接）'] }),
    'relay-probe-mac.jsonl': probe(4001)
  })
  try {
    const acceptance = run(dir)
    assert.equal(acceptance.verdict, 'pass', JSON.stringify(acceptance.rules.filter((r) => r.status !== 'pass' && r.status !== 'info')))
    assert.match(readFileSync(join(dir, 'SUMMARY.md'), 'utf8'), /Verdict: \*\*pass\*\*/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an old host, a missing direct route and a slow refresh fail with reasons', () => {
  const dir = results({
    'checks.json': checksPass,
    'netbench-wifi-relay.jsonl': scenario('wifi-relay', { capabilities: ['ping'] }),
    'netbench-wifi-auto.jsonl': scenario('wifi-auto', { refreshMs: 900 }),
    'relay-probe-mac.jsonl': probe(4001)
  })
  try {
    const { verdict, rules } = run(dir)
    assert.equal(verdict, 'fail')
    const status = Object.fromEntries(rules.map((r) => [r.id, r]))
    assert.equal(status['R3-transport:wifi-relay'].status, 'fail')
    assert.match(status['R3-transport:wifi-relay'].detail, /missing=mux/)
    assert.equal(status['R5-direct'].status, 'fail')
    assert.equal(status['R6-catalog:wifi-auto'].status, 'fail')
    assert.equal(status['R7-offline-fast'].status, 'blocked')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('missing evidence is incomplete, never a pass; an undeployed relay only blocks the offline rule', () => {
  const dir = results({
    'netbench-wifi-relay.jsonl': scenario('wifi-relay'),
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
