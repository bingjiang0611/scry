#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const workspace = process.cwd()
const after = Number(args[args.indexOf('--after') + 1])
const limit = Number(args[args.indexOf('--limit') + 1])
const recordsRoot = resolve(workspace, '.scry/records')
const files = readdirSync(recordsRoot).filter(name => /^\d{20}-[a-f0-9]{32,64}\.json$/.test(name)).sort()
const all = files.map(name => ({ name, sequence: Number(name.slice(0, 20)) }))
const snapshotIndex = args.indexOf('--snapshot')
const snapshotMaxSequence = snapshotIndex < 0
  ? all.at(-1)?.sequence ?? 0
  : Number(args[snapshotIndex + 1])
if (process.env.RECOVERY_FAIL_WORKSPACE === workspace || process.env.RECOVERY_EXPORT_FAILURE) {
  process.stderr.write('recorder fixture unavailable\n')
  process.exit(1)
}
const page = all.filter(item => item.sequence > after && item.sequence <= snapshotMaxSequence).slice(0, limit)
const rejected = page.find(item => item.sequence === Number(process.env.RECOVERY_BAD_SEQUENCE))
if (rejected) {
  process.stderr.write(`scry: invalid turn record: ${join(recordsRoot, rejected.name)}: $.fixture: rejected by fixture\n`)
  process.exitCode = 1
} else {
  process.stdout.write(JSON.stringify({
    records: page.map(item => JSON.parse(readFileSync(join(recordsRoot, item.name), 'utf8'))),
    nextCursor: page.at(-1)?.sequence ?? after,
    snapshotMaxSequence,
    hasMore: page.length > 0 && page.at(-1).sequence < snapshotMaxSequence
  }))
}
