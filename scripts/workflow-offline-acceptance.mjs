import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const exec = promisify(execFile)
const manifest = JSON.parse(await readFile(new URL('./workflow-acceptance-manifest.json', import.meta.url), 'utf8'))
const root = await mkdtemp(join(tmpdir(), 'scry-workflow-acceptance-'))
const home = join(root, 'home'), userData = join(root, 'userData'), workspace = join(root, 'workspace'), artifactRoot = join(root, 'results')
const reportPath = process.env.SCRY_WORKFLOW_ACCEPTANCE_REPORT || join(tmpdir(), `scry-workflow-acceptance-report-${Date.now()}.json`)
const hash = value => createHash('sha256').update(value).digest('hex')
async function gitState() {
  const [{ stdout: head }, { stdout: branch }, { stdout: status }, { stdout: untrackedText }] = await Promise.all([
    exec('git', ['rev-parse', 'HEAD']), exec('git', ['branch', '--show-current']), exec('git', ['diff', '--name-status', '--no-renames', '-z', 'HEAD']), exec('git', ['ls-files', '--others', '--exclude-standard'])
  ])
  const changes = []
  const parts = status.split('\0')
  for (let index = 0; index + 1 < parts.length; index += 2) if (parts[index] && parts[index + 1]) changes.push({ path: parts[index + 1], status: parts[index] })
  for (const path of untrackedText.split('\n').filter(Boolean)) changes.push({ path, status: '??' })
  const entries = []
  for (const change of changes.sort((a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status))) {
    entries.push({ ...change, hash: existsSync(change.path) ? hash(await readFile(change.path)) : null })
  }
  const identity = { head: head.trim(), branch: branch.trim(), changes: entries }
  return { head: identity.head, branch: identity.branch, changeSha256: hash(JSON.stringify(identity)), changedPaths: entries.map(entry => entry.path), entries }
}
const result = { schemaVersion: manifest.schemaVersion, name: manifest.name, startedAt: new Date().toISOString(), root, reportPath, commands: [], negativeControls: [], unverified: manifest.unverified, isolation: manifest.isolation }
try {
  const state = await gitState()
  result.git = { head: state.head, branch: state.branch, changeSha256: state.changeSha256 }
  result.sourcePaths = [...new Set([...manifest.source, 'scripts/workflow-acceptance-manifest.json', 'scripts/workflow-acceptance-report.mjs', ...state.changedPaths])].filter(path => existsSync(path)).sort()
  result.sourceHashes = Object.fromEntries(await Promise.all(result.sourcePaths.map(async path => [path, hash(await readFile(path))])))
  await Promise.all([home, userData, workspace, artifactRoot].map(path => mkdir(path, { recursive: true })))
  for (const entry of manifest.commands) {
    const started = Date.now()
    let exitCode = 0, stdout = '', stderr = ''
    try {
      const output = await exec(entry.command, entry.args, { env: { ...process.env, HOME: home, SCRY_USER_DATA: userData, SCRY_WORKFLOW_ACCEPTANCE_ROOT: root, SCRY_WORKFLOW_ACCEPTANCE_WORKSPACE: workspace } })
      stdout = output.stdout; stderr = output.stderr
    } catch (error) {
      exitCode = typeof error.code === 'number' ? error.code : 1
      stdout = error.stdout ?? ''; stderr = error.stderr ?? String(error)
    }
    const row = { id: entry.id, command: [entry.command, ...entry.args], status: exitCode === 0 ? 'passed' : 'failed', exitCode, durationMs: Date.now() - started, stdout, stderr, stdoutSha256: hash(stdout) }
    const artifact = join(artifactRoot, `${entry.id}.json`)
    await writeFile(artifact, JSON.stringify(row, null, 2) + '\n')
    result.commands.push({ ...row, artifact, artifactSha256: hash(await readFile(artifact)) })
  }
  result.negativeControls = manifest.negativeControls.map(control => {
    const command = result.commands.find(entry => entry.id === control.commandId)
    const token = control.testEvidenceToken
    const found = Boolean(command && command.exitCode === 0 && typeof token === 'string' && command.stdout.includes(token))
    return { id: control.id, commandId: control.commandId, status: found ? 'passed' : 'failed', testEvidenceToken: token, stdoutProof: command ? { text: command.stdout, sha256: command.stdoutSha256, tokenFound: found } : undefined, artifactSha256: command?.artifactSha256 }
  })
  result.status = result.commands.length === manifest.commands.length && result.commands.every(command => command.exitCode === 0) && result.negativeControls.every(control => control.status === 'passed') ? 'passed' : 'failed'
} finally {
  const keepRoot = process.env.SCRY_KEEP_ACCEPTANCE_ROOT === '1'
  if (!keepRoot) await rm(root, { recursive: true, force: true })
  result.cleanup = { rootRemoved: !keepRoot, completedAt: new Date().toISOString() }
  await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n')
}
if (result.status !== 'passed') process.exitCode = 1
console.log(JSON.stringify(result, null, 2))
