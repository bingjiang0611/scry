#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { basename, extname } from 'node:path'

// A cheap size budget, not a tokenizer: 5,000 estimated tokens = 20,000 bytes.
const maxBytes = 20_000
const lockfiles = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'Package.resolved'])
const generatedFiles = new Set([
  'experiments/remote-g0/generated/wire.mjs',
  'experiments/remote-g0/generated/wire.ts',
  'experiments/remote-g0/swift/Sources/RemoteTransport/Wire.swift'
])
const binaryExtensions = new Set(['.png', '.icns'])

function git(args, input) {
  return execFileSync('git', args, { encoding: 'utf8', input, maxBuffer: 16 * 1024 * 1024 })
}

// Raw, NUL-delimited records provide index blob IDs without reading the worktree.
// Disable rename detection so renames/copies are checked as additions, including
// a previously exempt generated file renamed into hand-written source.
const records = git(['diff', '--cached', '--raw', '--no-abbrev', '--no-renames', '--diff-filter=ACMT', '-z']).split('\0')
const files = []
for (let index = 0; index < records.length - 1; index += 2) {
  const [, mode, , oid] = records[index].split(' ')
  const path = records[index + 1]
  // Symlinks and submodules are not authored file contents.
  if (!['100644', '100755'].includes(mode)) continue
  if (lockfiles.has(basename(path)) || generatedFiles.has(path) || binaryExtensions.has(extname(path))) continue
  files.push({ path, oid })
}

if (files.length > 0) {
  const sizes = git(['cat-file', '--batch-check=%(objectsize)'], files.map(file => file.oid).join('\n') + '\n').trim().split('\n')
  const oversized = files.flatMap((file, index) => {
    const bytes = Number(sizes[index])
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`Cannot read staged blob size: ${JSON.stringify(file.path)}`)
    return bytes > maxBytes ? [{ ...file, bytes }] : []
  })
  if (oversized.length > 0) {
    console.error('Commit blocked: staged files exceed 5,000 estimated tokens (20,000 bytes; tokens ≈ bytes / 4).')
    for (const file of oversized) {
      console.error(`  ${JSON.stringify(file.path)}: ${file.bytes} bytes, ≈${Math.ceil(file.bytes / 4)} tokens`)
    }
    console.error('\nSplit by responsibility, not arbitrary line counts:')
    console.error('- Extract a cohesive component, domain operation, or test suite into a focused file.')
    console.error('- Reuse existing modules; keep related logic together and avoid circular imports or wrapper-only files.')
    console.error('- Update imports and tests, verify behavior, then git add the split files and commit again.')
    console.error('Checks use the complete staged version, not the worktree or just added lines. Existing large files are not grandfathered.')
    process.exitCode = 1
  }
}
