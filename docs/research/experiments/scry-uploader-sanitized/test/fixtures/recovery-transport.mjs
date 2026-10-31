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

if (args.includes('whoami')) {
  let actor = { subject_id: 'fixture', nickname: 'Fixture' }
  try {
    actor = JSON.parse(readFileSync(join(process.env.HOME, '.config', 'transport', 'auth.yaml'), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  log({ phase: 'actor' })
  respond(actor)
} else if (args.includes('list-tools')) {
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
    await new Promise(resolve => {
      const watcher = watch(gate, () => {
        if (!existsSync(gate)) {
          watcher.close()
          resolve()
        }
      })
      if (!existsSync(gate)) {
        watcher.close()
        resolve()
      }
    })
  }
  if (process.env.RECOVERY_CLOCK_FILE) {
    const path = process.env.RECOVERY_CLOCK_FILE
    writeFileSync(path, `${Number(readFileSync(path, 'utf8')) + 1}\n`)
  }
  log({ phase: 'end' })
  if (process.env.RECOVERY_STATUS) {
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
