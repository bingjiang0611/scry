#!/usr/bin/env node
// Fake transport CLI for local rollout checks. It never talks to a network.
//
// Behaviour is read from the JSON file named by FAKE_CONTROL on every call, so a
// scenario can switch from "outage" to "ok" while the uploader keeps running.
// Every submit is appended to FAKE_LOG as one JSON line (start and end events),
// which the runner uses to count requests and measure concurrency.
//
// Control fields (all optional):
//   mode: "ok" | "outage503" | "busy" | "timeout" | "malformed" | "lostResponse"
//   failRecordIds: [recordId]  -> batches containing these fail
//   failKind: "413" | "business"  (how failRecordIds fail; default "413")
//   rejectRecordIds: [recordId] -> item status "rejected" for these
//   slowMs: number               -> sleep before answering
//   stderrSecret: string         -> extra stderr text on failures (redaction check)
//   authProbeFails: true          -> `auth whoami` fails with stderrSecret appended
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const protocol = JSON.parse(readFileSync(process.env.FAKE_PROTOCOL || join(here, 'protocol.json'), 'utf8'))
const control = (() => {
  try { return JSON.parse(readFileSync(process.env.FAKE_CONTROL, 'utf8')) } catch { return {} }
})()
const args = process.argv.slice(2).filter(a => !a.startsWith('--no-update-check'))
const log = value => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, JSON.stringify({ t: Date.now(), pid: process.pid, ...value }) + '\n')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const fail = (text, code = 1) => {
  process.stderr.write(text + (control.stderrSecret ? `\n${control.stderrSecret}` : '') + '\n')
  process.exit(code)
}

// Every invocation is logged so the harness can prove the uploader really calls this fake and not the real transport.
log({ phase: 'invoke', args: args.slice(0, 2) })
if (args[0] === 'version') { console.log('transport 0.0.0-fake'); process.exit(0) }
// Expired login: every authenticated call fails with the transport's own wording.
if (control.loggedOut) { log({ phase: 'denied', args: args.slice(0, 2) }); fail('Error: not logged in; run transport auth login --sso') }
if (args[0] === 'auth') {
  // A failing identity probe whose stderr carries credentials; `doctor` prints it.
  if (control.authProbeFails) fail('whoami failed: upstream rejected the probe')
  console.log(JSON.stringify({ [protocol.whoami.userIdField]: 'rollout-check', [protocol.whoami.nickField]: 'rollout-check' }))
  process.exit(0)
}
if (args[0] === 'mcp' && args[1] === 'list-tools') {
  const properties = Object.fromEntries(protocol.argumentNames.map(name => [name, {}]))
  console.log(JSON.stringify([{ name: protocol.toolName, inputSchema: { type: 'object', properties } }]))
  process.exit(0)
}
if (args[0] === 'mcp' && args[1] === 'call-tool') {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const payload = JSON.parse(input)
  const recordsIndex = protocol.argumentNames.indexOf(protocol.recordsArgument)
  const raw = payload[protocol.recordsArgument] ?? payload[`fieldName_${recordsIndex}`] ?? payload[`arg${recordsIndex}`] ?? []
  const records = raw.map(text => {
    const value = JSON.parse(text)
    return value.scryEncoding === 'gzip-base64' ? JSON.parse(gunzipSync(Buffer.from(value.payload, 'base64')).toString('utf8')) : value
  })
  const ids = records.map(r => r.recordId)
  log({ phase: 'start', ids })
  const end = result => log({ phase: 'end', ids, result })
  if (control.slowMs) await sleep(control.slowMs)
  const mode = control.mode || 'ok'
  if (control.failRecordIds?.some(id => ids.includes(id))) {
    end('poison')
    if (control.failKind === 'business') { console.log(JSON.stringify({ success: false, error: '参数校验失败: records 字段非法' })); process.exit(0) }
    fail('HTTP 413 Request Entity Too Large')
  }
  if (mode === 'outage503') { end('503'); fail('HTTP 503 Service Unavailable') }
  if (mode === 'busy') { end('busy'); console.log(JSON.stringify({ success: false, error: '服务繁忙，请稍后重试' })); process.exit(0) }
  if (mode === 'timeout') { end('timeout'); fail('Post "https://fake/mcp": context deadline exceeded') }
  const statuses = protocol.response.itemStatuses
  let status = statuses.inserted
  if (mode === 'lostResponse') {
    // First delivery commits, then the response is lost; later deliveries answer duplicated.
    const committedFile = process.env.FAKE_LOG + '.committed'
    const committed = new Set(existsSync(committedFile) ? readFileSync(committedFile, 'utf8').split('\n').filter(Boolean) : [])
    const fresh = ids.filter(id => !committed.has(id))
    if (fresh.length) {
      writeFileSync(committedFile, [...committed, ...fresh].join('\n') + '\n')
      end('lost')
      fail('connection reset by peer while reading response (ECONNRESET)')
    }
    status = statuses.duplicated
  }
  const items = records.map((r, index) => ({ index, recordId: r.recordId,
    status: control.rejectRecordIds?.includes(r.recordId) ? statuses.rejected : status }))
  const count = s => items.filter(i => i.status === s).length
  const data = { received: items.length, inserted: count(statuses.inserted), duplicated: count(statuses.duplicated),
    conflicted: 0, rejected: count(statuses.rejected), items }
  if (mode === 'malformed') { delete data.received; end('malformed') } else end(items.map(i => i.status).join(','))
  console.log(JSON.stringify(protocol.response.wrapSuccess ? { success: true, data } : data))
  process.exit(0)
}
fail(`fake transport: unexpected command ${args.join(' ')}`, 2)
