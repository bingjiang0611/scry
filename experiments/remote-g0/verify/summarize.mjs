// Summarize a local iOS-remote verification run and decide acceptance.
//
//   node experiments/remote-g0/verify/summarize.mjs <results-dir>
//
// Reads from <results-dir>:
//   checks.json                 stage results written by local-verify.sh
//                               {"stages":[{"name","status":"pass|fail|skip","exitCode","seconds","log"}]}
//   netbench-<label>.jsonl      JSON lines copied from the phone (-netBench),
//                               one file per scenario label
//   relay-probe-<label>.jsonl   RELAYPROBE lines from relay-path-probe.mjs
// Writes summary.json, acceptance.json and SUMMARY.md, and exits non-zero when
// a required rule fails. A rule whose precondition is missing is "blocked"
// (with the reason), never "pass": absent evidence is not success.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const REQUIRED_CAPABILITIES = ['ping', 'mux', 'watchStream', 'sessionsKnown', 'historyDeflate']

function readJsonLines(path, prefix) {
  const out = []
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    let line = raw.trim()
    if (!line) continue
    if (prefix) {
      const at = line.indexOf(prefix)
      if (at < 0) continue
      line = line.slice(at + prefix.length).trim()
    } else if (line.startsWith('NETBENCH ')) line = line.slice('NETBENCH '.length)
    try { out.push(JSON.parse(line)) } catch { /* console noise */ }
  }
  return out
}

const median = (values) => {
  const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
}

export function summarizeNetbench(events) {
  const by = (name) => events.filter((event) => event.event === name)
  const environment = by('environment')[0] ?? null
  const cold = by('cold-open')
  const tunnels = by('tunnels').map((event) => event.diagnostics).filter(Boolean)
  const timings = tunnels.flatMap((diagnostics) => diagnostics.timings ?? [])
  const done = by('done')[0] ?? null
  const summary = by('summary')[0] ?? null
  const catalog = Object.fromEntries(by('catalog').map((event) => [event.pass, event]))
  const phase = (name) => median(timings.filter((timing) => !timing.error).map((timing) => timing[name]))
  return {
    complete: done !== null,
    failures: done?.failures ?? null,
    environment,
    coldOpen: {
      okMs: cold.filter((event) => !event.error).map((event) => event.ms),
      errors: cold.filter((event) => event.error).map((event) => ({ ms: event.ms, error: event.error })),
      medianMs: summary?.coldMedianMs ?? null,
      p90Ms: summary?.coldP90Ms ?? null
    },
    warm: { medianMs: summary?.warmMedianMs ?? null, p90Ms: summary?.warmP90Ms ?? null, samples: summary?.warmSamples ?? 0 },
    catalog,
    history: by('history')[0] ?? null,
    routes: [...new Set(timings.filter((timing) => !timing.error).map((timing) => timing.route))],
    multiplexed: tunnels.length > 0 && tunnels.every((diagnostics) => diagnostics.multiplexed === true),
    capabilities: tunnels[0]?.capabilities ?? null,
    legacyHost: tunnels.some((diagnostics) => diagnostics.legacyHost),
    directRoutes: tunnels[0]?.directRoutes ?? [],
    colos: [...new Set(timings.map((timing) => timing.colo).filter(Boolean))],
    phasesMedianMs: Object.fromEntries(['tcpMs', 'outerTLSMs', 'upgradeMs', 'innerTLSMs', 'pingMs', 'totalMs'].map((name) => [name, phase(name)])),
    openErrors: timings.filter((timing) => timing.error).map((timing) => ({ lane: timing.lane, route: timing.route, error: timing.error }))
  }
}

export function summarizeRelayProbe(events) {
  const summary = events.find((event) => event.event === 'summary') ?? null
  return summary ? { ok: summary.ok, failed: summary.failed, colos: summary.colos, generations: summary.relayGenerations, medianMs: summary.medianMs } : null
}

export function evaluate({ checks, scenarios, probes }) {
  const rules = []
  const rule = (id, required, status, detail) => rules.push({ id, required, status, detail })

  // R1: automated checks.
  if (!checks) rule('R1-checks', true, 'blocked', 'checks.json missing: run local-verify.sh checks')
  else {
    const failed = checks.stages.filter((stage) => stage.status === 'fail').map((stage) => stage.name)
    const skipped = checks.stages.filter((stage) => stage.status === 'skip').map((stage) => stage.name)
    rule('R1-checks', true, failed.length ? 'fail' : 'pass', failed.length ? `failed: ${failed.join(', ')}` : `all ran stages passed${skipped.length ? `; skipped: ${skipped.join(', ')}` : ''}`)
  }

  const normal = Object.entries(scenarios).filter(([label]) => label !== 'host-quit' && !label.startsWith('baseline'))
  // R2: every normal scenario completed without failures.
  if (normal.length === 0) rule('R2-netbench-clean', true, 'blocked', 'no netbench scenario besides host-quit')
  for (const [label, s] of normal) {
    if (!s.complete) rule(`R2-netbench-clean:${label}`, true, 'fail', 'no done event: the run crashed or was cut off')
    else rule(`R2-netbench-clean:${label}`, true, s.failures === 0 ? 'pass' : 'fail', `failures=${s.failures}`)
  }

  // R3: the host speaks the new transport and the phone multiplexes.
  for (const [label, s] of normal) {
    const missing = REQUIRED_CAPABILITIES.filter((name) => !(s.capabilities ?? []).includes(name))
    const ok = s.multiplexed && missing.length === 0 && !s.legacyHost
    rule(`R3-transport:${label}`, true, ok ? 'pass' : 'fail',
      ok ? 'multiplexed, all capabilities' : `multiplexed=${s.multiplexed} legacyHost=${s.legacyHost} missing=${missing.join(',') || 'none'} (host not restarted on the new build?)`)
  }

  // R4: forced relay really used the relay.
  const relay = scenarios['wifi-relay']
  if (!relay) rule('R4-relay-only', true, 'blocked', 'scenario wifi-relay not run')
  else rule('R4-relay-only', true, relay.routes.length > 0 && relay.routes.every((route) => route === 'relay') ? 'pass' : 'fail', `routes=${relay.routes.join(',') || 'none'}`)

  // R5: on the same Wi-Fi, auto mode reaches the Mac directly.
  const auto = scenarios['wifi-auto']
  if (!auto) rule('R5-direct', true, 'blocked', 'scenario wifi-auto not run')
  else if (auto.environment?.localNetwork !== true) rule('R5-direct', true, 'blocked', 'phone was not on a local network during wifi-auto')
  else if (auto.directRoutes.length === 0) rule('R5-direct', true, 'fail', 'host advertised no direct route (LAN listener off, firewall, or SCRY_REMOTE_LAN=0)')
  else rule('R5-direct', true, auto.routes.includes('direct') ? 'pass' : 'fail',
    `routes=${auto.routes.join(',') || 'none'} advertised=${auto.directRoutes.map((route) => `${route.host}:${route.port}`).join(',')}${auto.openErrors.length ? ` openErrors=${JSON.stringify(auto.openErrors.slice(0, 3))}` : ''}`)

  // R6: an unchanged catalog refresh is not slower than the full walk.
  for (const [label, s] of normal) {
    const full = s.catalog.full
    const refresh = s.catalog.refresh
    if (!full || !refresh || full.error || refresh.error) { rule(`R6-catalog:${label}`, true, 'fail', `catalog error: ${full?.error ?? refresh?.error ?? 'missing'}`); continue }
    const ok = refresh.ms <= full.ms * 1.2 + 50
    rule(`R6-catalog:${label}`, true, ok ? 'pass' : 'fail', `full=${full.ms}ms (${full.sessions} sessions) refresh=${refresh.ms}ms`)
  }

  // R7: Scry quit on the Mac -> the phone is told it is offline, quickly.
  const quit = scenarios['host-quit']
  const generations = Object.values(probes).flatMap((probe) => probe?.generations ?? [])
  if (!quit) rule('R7-offline-fast', true, 'blocked', 'scenario host-quit not run')
  else if (!generations.includes('heartbeat-aware')) rule('R7-offline-fast', false, 'blocked', `relay not redeployed (probe generations: ${generations.join(',') || 'no probe'}); old relay answers 1013 after retries`)
  else {
    const errors = quit.coldOpen.errors
    const offline = errors.filter((error) => /不在线|host_offline|4001/.test(error.error))
    const ms = median(offline.map((error) => error.ms))
    const ok = errors.length > 0 && offline.length === errors.length && quit.coldOpen.okMs.length === 0 && ms !== null && ms <= 3000
    rule('R7-offline-fast', true, ok ? 'pass' : 'fail', `errors=${errors.length} offline=${offline.length} medianMs=${ms} sample=${JSON.stringify(errors[0] ?? null)}`)
  }

  // Informational comparisons (never fail the run).
  if (relay && auto) rule('I1-direct-vs-relay', false, 'info', `warm median relay=${relay.warm.medianMs}ms direct=${auto.warm.medianMs}ms; cold median relay=${relay.coldOpen.medianMs}ms auto=${auto.coldOpen.medianMs}ms`)
  for (const [label, s] of Object.entries(scenarios).filter(([label]) => label.startsWith('baseline'))) {
    const peer = scenarios[label.replace(/^baseline-/, '')]
    if (peer) rule(`I2-vs-${label}`, false, 'info', `cold ${s.coldOpen.medianMs}→${peer.coldOpen.medianMs}ms warm ${s.warm.medianMs}→${peer.warm.medianMs}ms refresh ${s.catalog.refresh?.ms}→${peer.catalog.refresh?.ms}ms`)
  }
  for (const [label, probe] of Object.entries(probes)) if (probe) rule(`I3-relay-path:${label}`, false, 'info', `colos=${probe.colos.join(',')} generations=${probe.generations.join(',')} median=${JSON.stringify(probe.medianMs)}`)

  const failedRequired = rules.filter((r) => r.required && r.status === 'fail')
  const blockedRequired = rules.filter((r) => r.required && r.status === 'blocked')
  return { verdict: failedRequired.length ? 'fail' : blockedRequired.length ? 'incomplete' : 'pass', rules }
}

function markdown({ verdict, rules }, scenarios) {
  const lines = [`# iOS remote local verification`, '', `Verdict: **${verdict}**`, '', '| Rule | Required | Status | Detail |', '|---|---|---|---|']
  for (const r of rules) lines.push(`| ${r.id} | ${r.required ? 'yes' : 'no'} | ${r.status} | ${String(r.detail).replace(/\|/g, '\\|')} |`)
  lines.push('', '| Scenario | Cold median/p90 ms | Warm median/p90 ms | Catalog full→refresh ms | History ms | Routes | Colos | Phase medians ms |', '|---|---|---|---|---|---|---|---|')
  for (const [label, s] of Object.entries(scenarios)) {
    lines.push(`| ${label} | ${s.coldOpen.medianMs}/${s.coldOpen.p90Ms} | ${s.warm.medianMs}/${s.warm.p90Ms} | ${s.catalog.full?.ms ?? '-'}→${s.catalog.refresh?.ms ?? '-'} | ${s.history?.ms ?? s.history?.skipped ?? '-'} | ${s.routes.join(',')} | ${s.colos.join(',')} | ${JSON.stringify(s.phasesMedianMs)} |`)
  }
  return lines.join('\n') + '\n'
}

export function run(dir) {
  const checks = existsSync(join(dir, 'checks.json')) ? JSON.parse(readFileSync(join(dir, 'checks.json'), 'utf8')) : null
  const scenarios = {}
  const probes = {}
  for (const name of readdirSync(dir)) {
    let match = name.match(/^netbench-(.+)\.jsonl$/)
    if (match) scenarios[match[1]] = summarizeNetbench(readJsonLines(join(dir, name)))
    match = name.match(/^relay-probe-(.+)\.jsonl$/)
    if (match) probes[match[1]] = summarizeRelayProbe(readJsonLines(join(dir, name), 'RELAYPROBE '))
  }
  const acceptance = evaluate({ checks, scenarios, probes })
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ scenarios, probes, checks }, null, 2))
  writeFileSync(join(dir, 'acceptance.json'), JSON.stringify(acceptance, null, 2))
  writeFileSync(join(dir, 'SUMMARY.md'), markdown(acceptance, scenarios))
  return acceptance
}

// pathToFileURL: a checkout path with spaces is percent-encoded in
// import.meta.url, so a raw `file://${argv[1]}` comparison never matches and
// the whole summary silently became a no-op.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2]
  if (!dir) { console.error('usage: summarize.mjs <results-dir>'); process.exit(2) }
  const acceptance = run(dir)
  console.log(readFileSync(join(dir, 'SUMMARY.md'), 'utf8'))
  process.exit(acceptance.verdict === 'fail' ? 1 : 0)
}
