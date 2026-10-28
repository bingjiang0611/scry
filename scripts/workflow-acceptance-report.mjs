import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join } from 'node:path'

const exec = promisify(execFile)
const manifest = JSON.parse(await readFile(join(import.meta.dirname, 'workflow-acceptance-manifest.json'), 'utf8'))
const reportPath = process.argv.find(value => value.startsWith('--result='))?.slice('--result='.length)
if (!reportPath) throw new Error('acceptance report requires --result=<acceptance-report.json>')
const report = JSON.parse(await readFile(reportPath, 'utf8'))
const hash = value => createHash('sha256').update(value).digest('hex')
async function gitState() {
  const [{ stdout: head }, { stdout: branch }, { stdout: status }, { stdout: untrackedText }] = await Promise.all([
    exec('git', ['rev-parse', 'HEAD']), exec('git', ['branch', '--show-current']), exec('git', ['diff', '--name-status', '--no-renames', '-z', 'HEAD']), exec('git', ['ls-files', '--others', '--exclude-standard'])
  ])
  const changes = [], parts = status.split('\0')
  for (let index = 0; index + 1 < parts.length; index += 2) if (parts[index] && parts[index + 1]) changes.push({ path: parts[index + 1], status: parts[index] })
  for (const path of untrackedText.split('\n').filter(Boolean)) changes.push({ path, status: '??' })
  const entries = []
  for (const change of changes.sort((a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status))) entries.push({ ...change, hash: existsSync(change.path) ? hash(await readFile(change.path)) : null })
  const identity = { head: head.trim(), branch: branch.trim(), changes: entries }
  return { head: identity.head, branch: identity.branch, changeSha256: hash(JSON.stringify(identity)), changedPaths: entries.map(entry => entry.path) }
}
if (report.schemaVersion !== manifest.schemaVersion || report.name !== manifest.name) throw new Error('acceptance report does not match manifest')
if (!Array.isArray(report.commands) || report.commands.length !== manifest.commands.length) throw new Error('acceptance command count does not match manifest')
for (const [index, expected] of manifest.commands.entries()) {
  const actual = report.commands[index], command = [expected.command, ...expected.args]
  if (!actual || actual.id !== expected.id || JSON.stringify(actual.command) !== JSON.stringify(command) || actual.status !== 'passed' || actual.exitCode !== 0 || typeof actual.artifact !== 'string' || !Number.isFinite(actual.durationMs) || typeof actual.stdout !== 'string' || actual.stdoutSha256 !== hash(actual.stdout) || typeof actual.artifactSha256 !== 'string') throw new Error(`acceptance command ${expected.id} is not a passing exact match`)
  if (existsSync(actual.artifact)) {
    const bytes = await readFile(actual.artifact)
    if (hash(bytes) !== actual.artifactSha256) throw new Error(`acceptance artifact hash mismatch: ${expected.id}`)
    const artifact = JSON.parse(bytes)
    if (artifact.id !== actual.id || JSON.stringify(artifact.command) !== JSON.stringify(actual.command) || artifact.status !== actual.status || artifact.exitCode !== actual.exitCode || artifact.stdoutSha256 !== actual.stdoutSha256 || artifact.stdout !== actual.stdout) throw new Error(`acceptance artifact content mismatch: ${expected.id}`)
  }
}
if (report.status !== 'passed') throw new Error('acceptance report status is not passed')
if (!Array.isArray(report.negativeControls) || report.negativeControls.length !== manifest.negativeControls.length) throw new Error('acceptance negative control count does not match manifest')
for (const [index, expected] of manifest.negativeControls.entries()) {
  const actual = report.negativeControls[index], command = report.commands.find(entry => entry.id === expected.commandId), token = expected.testEvidenceToken
  const proof = actual?.stdoutProof
  if (!actual || actual.id !== expected.id || actual.commandId !== expected.commandId || actual.status !== 'passed' || actual.testEvidenceToken !== token || !command || command.exitCode !== 0 || typeof command.artifactSha256 !== 'string' || actual.artifactSha256 !== command.artifactSha256 || !proof || typeof proof.text !== 'string' || proof.sha256 !== hash(proof.text) || proof.text !== command.stdout || proof.tokenFound !== true || !proof.text.includes(token)) throw new Error(`negative control ${expected.id} lacks exact independent evidence`)
}
if (report.cleanup?.rootRemoved !== true) throw new Error('acceptance cleanup is not proven')
const state = await gitState()
if (report.git?.head !== state.head || report.git?.branch !== state.branch || report.git?.changeSha256 !== state.changeSha256) throw new Error('acceptance git identity or complete change manifest is stale')
const sourcePaths = [...new Set([...manifest.source, 'scripts/workflow-acceptance-manifest.json', 'scripts/workflow-acceptance-report.mjs', ...state.changedPaths])].filter(path => existsSync(path)).sort()
if (JSON.stringify(report.sourcePaths) !== JSON.stringify(sourcePaths) || !report.sourceHashes || Object.keys(report.sourceHashes).sort().join('\0') !== sourcePaths.join('\0')) throw new Error('acceptance source manifest is incomplete or stale')
for (const source of sourcePaths) if (hash(await readFile(source)) !== report.sourceHashes[source]) throw new Error(`source hash mismatch: ${source}`)
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`${report.name}: ${report.status}`)
  for (const command of report.commands) console.log(`${command.id}: ${command.status} exit=${command.exitCode} durationMs=${command.durationMs}`)
  for (const control of report.negativeControls) console.log(`${control.id}: ${control.status}`)
  console.log(`cleanup: rootRemoved=${report.cleanup.rootRemoved}`)
  console.log(`unverified: ${report.unverified.join(', ')}`)
}
