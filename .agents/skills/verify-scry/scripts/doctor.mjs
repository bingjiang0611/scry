#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connectCdp, rendererEvaluator } from '../../../../scripts/electron-security-cdp.mjs'

export const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
export const processIdentity = pid => execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=,command='],
  { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim()

// Read-only: no input, reload, state setters, Provider calls, or signals.
export async function doctor(evidence) {
  const instance = JSON.parse(readFileSync(join(evidence, 'instance.json'), 'utf8'))
  assert.equal(processIdentity(instance.pid), instance.identity, 'owned process identity changed')
  assert.ok(instance.identity.includes(`--remote-debugging-port=${instance.port}`))
  assert.ok(instance.identity.includes(instance.entry))
  for (const [path, hash] of Object.entries(instance.build)) assert.equal(sha256(path), hash, `build changed: ${path}`)
  const response = await fetch(`http://127.0.0.1:${instance.port}/json/list`, { signal: AbortSignal.timeout(5000) })
  assert.ok(response.ok)
  const pages = (await response.json()).filter(page => page.type === 'page' && page.url === instance.renderer)
  assert.equal(pages.length, 1, 'expected exactly one owned production renderer')
  const cdp = connectCdp(pages[0].webSocketDebuggerUrl)
  try {
    const state = await rendererEvaluator(cdp)(`({ url: location.href, title: document.title,
      isolated: typeof require === 'undefined', preload: typeof window.scry?.sourceControl?.read,
      ready: Boolean(document.querySelector('button.sb-sess')) })`)
    assert.equal(state.url, instance.renderer)
    assert.equal(state.title, 'Scry')
    assert.equal(state.isolated, true)
    assert.equal(state.preload, 'function')
    assert.equal(state.ready, true, 'fixture session is not usable yet')
    return { pid: instance.pid, port: instance.port, revision: instance.revision, version: instance.version, state }
  } finally {
    cdp.close()
  }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 3, 'usage: doctor.mjs EVIDENCE_DIRECTORY (live instance only)')
  console.log(JSON.stringify(await doctor(process.argv[2]), null, 2))
}
