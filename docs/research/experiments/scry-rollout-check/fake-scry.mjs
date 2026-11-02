#!/usr/bin/env node
// Minimal stand-in for `scry turns export` so the uploader's discovery step sees
// an empty, well-formed page instead of parsing synthetic records with the real
// recorder. Records in these checks arrive through `notify`, as hooks deliver them.
const args = process.argv.slice(2)
if (args[0] === 'version') { console.log('0.0.0'); process.exit(0) }
const after = Number(args[args.indexOf('--after') + 1] || 0)
console.log(JSON.stringify({ records: [], nextCursor: after, snapshotMaxSequence: 0, hasMore: false }))
