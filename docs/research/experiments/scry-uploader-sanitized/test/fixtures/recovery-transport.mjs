#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

const args = process.argv.slice(2)
const logPath = process.env.RECOVERY_TRANSPORT_LOG
function log(value) {
  if (logPath) appendFileSync(logPath, JSON.stringify({ ...value, pid: process.pid }) + '\n')
}
function respond(value) {
  process.stdout.write(JSON.stringify(value) + '\n')
}
function tickClock() {
  const path = process.env.RECOVERY_CLOCK_FILE
  if (!path) return
  writeFileSync(path, `${Number(readFileSync(path, 'utf8')) + 1}\n`)
}

if (args.includes('whoami')) {
  let actor = { subject_id: 'fixture', nickname: 'Fixture' }
  try {
    actor = JSON.parse(readFileSync(join(process.env.HOME, '.config', 'transport', 'auth.yaml'), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (process.env.RECOVERY_CLOCK_ALL_PHASES) tickClock()
  log({ phase: 'actor' })
  respond(actor)
} else if (args.includes('list-tools')) {
  if (process.env.RECOVERY_CLOCK_ALL_PHASES) tickClock()
  log({ phase: 'schema' })
  const fields = ['actorUserId', 'actorNick', 'repo', 'installationId', 'uploaderVersion', 'redactionVersion', 'records']
  respond([{ name: 'submitTurns', inputSchema: { properties: Object.fromEntries(fields.map(key => [key, {}])) } }])
} else if (args.includes('call-tool')) {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const values = JSON.parse(input)
  const records = values.records.map(source => {
    const value = JSON.parse(source)
    return value.scryEncoding === 'gzip-base64'
      ? JSON.parse(gunzipSync(Buffer.from(value.payload, 'base64')).toString('utf8'))
      : value
  })
  log({ phase: 'start', ids: records.map(record => record.recordId), bytes: Buffer.byteLength(input), traceTask: process.env.HOST_TRACE_TASK_ID })
  const gate = process.env.RECOVERY_GATE_FILE
  if (gate && existsSync(gate)) {
    // Tell the test the request is parked, so a "still waiting" assertion
    // cannot pass just because the child has not arrived yet.
    log({ phase: 'gate-wait' })
    await new Promise((resolve, reject) => {
      let watcher
      const released = () => {
        watcher?.close()
        resolve()
      }
      try {
        watcher = watch(gate, () => {
          if (!existsSync(gate)) released()
        })
      } catch (error) {
        // The gate can vanish between the check above and watch(). A missing
        // gate means the test released it, so this is not a failure.
        if (error.code === 'ENOENT') return resolve()
        return reject(error)
      }
      if (!existsSync(gate)) released()
    })
  }
  tickClock()
  log({ phase: 'end' })
  if (process.env.RECOVERY_ALL_BUSINESS_ERROR) {
    // Whole-service outage: every request fails with an unclassifiable business
    // error and no status code.
    respond({ success: false, error: process.env.RECOVERY_ALL_BUSINESS_ERROR })
  } else if (process.env.RECOVERY_FAIL_RECORD_ID && records.some(record => record.recordId === process.env.RECOVERY_FAIL_RECORD_ID)) {
    // Business failure without any HTTP status: the client cannot classify it
    // from a status code and must not retry the same batch forever.
    respond({ success: false, error: process.env.RECOVERY_BUSINESS_ERROR || '参数校验失败',
      ...(process.env.RECOVERY_BUSINESS_CODE ? { code: process.env.RECOVERY_BUSINESS_CODE } : {}) })
  } else if (process.env.RECOVERY_MALFORMED_RESPONSE) {
    respond({ success: true, data: { received: 0, items: [] } })
  } else if (process.env.RECOVERY_STATUS) {
    respond({ success: false, statusCode: Number(process.env.RECOVERY_STATUS),
      retryAfter: process.env.RECOVERY_RETRY_AFTER, error: 'fixture transport failure' })
  } else respond({ success: true, data: {
    received: records.length,
    inserted: records.length,
    duplicated: 0,
    conflicted: 0,
    rejected: 0,
    items: records.map((record, index) => ({ index, recordId: record.recordId, status: 'inserted' }))
  } })
} else {
  throw new Error('unexpected fixture transport command')
}
