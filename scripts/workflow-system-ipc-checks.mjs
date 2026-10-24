import assert from 'node:assert/strict'
import { glob, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Production trusted preload/main -> Service -> canonical Runner/Interpreter.
 * Only a local Node fixture executes, inside a registered private copy. */
export async function exerciseWorkflowSystemSteps(evaluate, fixture) {
  const templates = (method, ...args) => evaluate(`window.scry.workflow.templates.${method}(...${JSON.stringify(args)})`)
  const workflow = (method, ...args) => evaluate(`window.scry.workflow.${method}(...${JSON.stringify(args)})`)
  const results = []
  for (const exitCode of [0, 17]) {
    const script = 'scry-owned-check-fixture.cjs', marker = 'scry-owned-check-count'
    await writeFile(join(fixture.templateWorkspace, script), `const fs = require('node:fs'); let count = 0; try { count = Number(fs.readFileSync(${JSON.stringify(marker)}, 'utf8')) } catch(e) { if(e.code !== 'ENOENT') throw e } fs.writeFileSync(${JSON.stringify(marker)}, String(count + 1)); console.log('PRODUCTION-CHECK-OBSERVED'); process.exitCode = ${exitCode}`)
    const definition = { schemaVersion: 1, name: 'Main check fixture ' + exitCode, description: '', parameters: {}, roles: [], body: { kind: 'sequence', blockId: 'system_root', blocks: [
      { kind: 'replica', blockId: 'owned_copy' },
      { kind: 'check', blockId: 'native_check', replica: { kind: 'ref', name: 'owned_copy' }, check: { argv: [process.execPath, script], cwd: '.', timeoutMs: 2000, parser: 'exit_code' } },
      { kind: 'return', blockId: 'system_report', ref: { nodeId: 'native_check', path: ['passed'] } }
    ] } }
    const draft = await templates('saveDraft', { scope: { kind: 'personal' }, source: JSON.stringify(definition) })
    assert.equal(draft.validation.state, 'valid', JSON.stringify(draft.validation))
    const preview = await workflow('instantiateTemplate', { source: { kind: 'draft', draftId: draft.draftId, draftRevision: draft.draftRevision, candidateHash: draft.candidateHash }, commandId: 'system-instance-' + exitCode,
      cwd: fixture.templateWorkspace, userGoal: 'Observe native check ' + exitCode, parameters: {}, orchestrator: { role: 'orchestrator', providerId: 'codex' }, roles: [] })
    assert.equal(preview.state, 'ready', JSON.stringify(preview.unavailableReasons))
    assert.equal(preview.plannedCalls, 0)
    const check = preview.program.body.blocks[1]
    assert.ok(check.authorization.executableHash)
    assert.ok(check.authorization.entrypoint.hash)
    await assert.rejects(readFile(join(fixture.templateWorkspace, marker)), { code: 'ENOENT' })
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await workflow('approve', approval)
    const progress = await workflow('start', preview.workflowId, approval, 'system-start-' + exitCode)
    assert.equal(progress.state, 'completed', JSON.stringify(progress))
    assert.equal(progress.finalReport, exitCode === 0 ? 'true' : 'false')
    assert.equal(progress.dispatchAttempts, 0)
    assert.equal(progress.attempts.length, 0)
    const record = JSON.parse(await readFile(join(fixture.userData, 'workflows', preview.workflowId + '.json'), 'utf8'))
    assert.deepEqual(record.systemIntents.map(intent => intent.kind), ['prepare_replica', 'check'])
    assert.ok(record.systemOutcomes.every(outcome => outcome.settled))
    const native = record.systemOutcomes[1].check
    assert.equal(native.exitCode, exitCode)
    assert.equal(native.state, exitCode === 0 ? 'passed' : 'failed')
    assert.equal(native.evidence, 'exact')
    assert.ok(native.stdoutRef?.hash)
    const reference = record.systemOutcomes[0].replica
    const receipt = JSON.parse(await readFile(join(fixture.userData, 'workflow-replicas', preview.workflowId, reference.replicaId + '.replica.json'), 'utf8'))
    assert.equal(await readFile(join(receipt.directory, marker), 'utf8'), '1')
    await assert.rejects(readFile(join(fixture.templateWorkspace, marker)), { code: 'ENOENT' })
    const repeated = await workflow('start', preview.workflowId, approval, 'system-start-' + exitCode)
    assert.equal(repeated.finalReport, progress.finalReport)
    assert.equal(await readFile(join(receipt.directory, marker), 'utf8'), '1', 'receipt replay must not spawn the check again')
    results.push({ exitCode, observed: native.state, agentAttempts: 0, nativeExecutions: 1, sourceUnchanged: true })
  }
  const diagnosticConsumption = await exerciseWorkflowDiagnosticConsumption(evaluate, fixture)
  return { test: 'main-owned SystemSteps production preload/main IPC', results, diagnosticConsumption }
}

async function exerciseWorkflowDiagnosticConsumption(evaluate, fixture) {
  const templates = (method, ...args) => evaluate(`window.scry.workflow.templates.${method}(...${JSON.stringify(args)})`)
  const workflow = (method, ...args) => evaluate(`window.scry.workflow.${method}(...${JSON.stringify(args)})`)
  const script = 'scry-diagnostics-fixture.cjs', marker = 'scry-diagnostics-count'
  const output = 'src/a.ts(2,3): error TS2322: wrong type\nsrc/b.ts(4,5): error TS7006: missing type'
  await writeFile(join(fixture.templateWorkspace, script), `
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict')
const directory = ${JSON.stringify(join(fixture.userData, 'workflows'))}
const hash = text => crypto.createHash('sha256').update(text).digest('hex')
const load = ref => {
  const text = fs.readFileSync(path.join(directory, ref.workflowId + '.' + hash(ref.key) + '.' + ref.hash + '.value.json'), 'utf8')
  assert.equal(hash(text), ref.hash)
  const value = JSON.parse(text)
  assert.equal(value.state, 'known')
  return value.value
}
let intent
for (const name of fs.readdirSync(directory)) {
  if (!/^workflow-[a-f0-9]{64}\\.json$/.test(name)) continue
  const record = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))
  intent = record.systemIntents?.find(item => item.nodeId === 'verify_inputs' && !record.systemOutcomes?.some(outcome => outcome.stepId === item.stepId))
  if (intent) break
}
assert.ok(intent?.inputSnapshot, 'native invocation preceded its input-intent checkpoint')
const header = load(intent.inputSnapshot.reference)
assert.equal(hash(header.parts.map(load).join('')), intent.inputSnapshot.inputHash)
let n = 0
try { n = Number(fs.readFileSync(${JSON.stringify(marker)}, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
fs.writeFileSync(${JSON.stringify(marker)}, String(n + 1))
console.log(${JSON.stringify(output)})
process.exitCode = 1
`)
  const definition = { schemaVersion: 1, name: 'Diagnostic dataflow fixture', description: '', parameters: {}, roles: [], body: { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'replica', blockId: 'copy' },
    { kind: 'check', blockId: 'verify_inputs', replica: { kind: 'ref', name: 'copy' }, check: { argv: [process.execPath, script], cwd: '.', timeoutMs: 2000, parser: 'typescript' } },
    { kind: 'map', blockId: 'diagnostics', items: { kind: 'field', source: { kind: 'ref', name: 'verify_inputs' }, path: ['diagnostics', 'items'] }, item: 'diagnostic', key: ['code'], maxItems: 4,
      body: { kind: 'bind', blockId: 'entry', value: { kind: 'ref', name: 'diagnostic' } } },
    { kind: 'collect', blockId: 'collected', items: { kind: 'ref', name: 'diagnostics' } },
    { kind: 'bind', blockId: 'summary', value: { kind: 'concat', values: [
      { kind: 'ref', name: 'collected' },
      { kind: 'field', source: { kind: 'ref', name: 'verify_inputs' }, path: ['inputs', 'changes', 'items'] }
    ] } },
    { kind: 'return', blockId: 'report', ref: { nodeId: 'summary' } }
  ] } }
  const draft = await templates('saveDraft', { scope: { kind: 'personal' }, source: JSON.stringify(definition) })
  assert.equal(draft.validation.state, 'valid', JSON.stringify(draft.validation))
  const preview = await workflow('instantiateTemplate', { source: { kind: 'draft', draftId: draft.draftId, draftRevision: draft.draftRevision, candidateHash: draft.candidateHash }, commandId: 'diagnostic-instance',
    cwd: fixture.templateWorkspace, userGoal: 'Consume actual local compiler diagnostics without an Agent', parameters: {}, orchestrator: { role: 'orchestrator', providerId: 'codex' }, roles: [] })
  assert.equal(preview.state, 'ready', JSON.stringify(preview.unavailableReasons))
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  await workflow('approve', approval)
  const progress = await workflow('start', preview.workflowId, approval, 'diagnostic-start')
  assert.equal(progress.state, 'completed', JSON.stringify(progress))
  const report = JSON.parse(progress.finalReport)
  assert.deepEqual(report.slice(0, 2).map(row => row.value), [
    { file: 'src/a.ts', line: 2, column: 3, code: 'TS2322', message: 'wrong type' },
    { file: 'src/b.ts', line: 4, column: 5, code: 'TS7006', message: 'missing type' }
  ])
  assert.equal(progress.dispatchAttempts, 0)
  const record = JSON.parse(await readFile(join(fixture.userData, 'workflows', preview.workflowId + '.json'), 'utf8'))
  assert.equal(record.systemOutcomes[1].check.state, 'failed')
  assert.equal(record.systemOutcomes[1].check.diagnostics.count, 2)
  assert.deepEqual(report.slice(2), [{ path: marker, kind: 'added' }])
  assert.notEqual(record.systemOutcomes[1].check.inputs.before.inputHash, record.systemOutcomes[1].check.inputs.changes.after.inputHash)
  assert.deepEqual(record.systemIntents[1].inputSnapshot, record.systemOutcomes[1].check.inputs.before)
  assert.equal(record.systemOutcomes[1].check.inputs.changes.source, 'snapshot_comparison')
  const reference = record.systemOutcomes[0].replica
  const receipt = JSON.parse(await readFile(join(fixture.userData, 'workflow-replicas', preview.workflowId, reference.replicaId + '.replica.json'), 'utf8'))
  await workflow('start', preview.workflowId, approval, 'diagnostic-start')
  assert.equal(await readFile(join(receipt.directory, marker), 'utf8'), '1')
  await assert.rejects(readFile(join(fixture.templateWorkspace, marker)), { code: 'ENOENT' })
  return { actualCheckFailed: true, derivedDiagnosticsConsumed: 2, inputIntentReadByNative: true, observedChangesConsumed: 1, agentAttempts: 0, nativeExecutions: 1, sourceUnchanged: true }
}

export async function exerciseWorkflowReplicaAgent(evaluate, fixture) {
  const templates = (method, ...args) => evaluate(`window.scry.workflow.templates.${method}(...${JSON.stringify(args)})`)
  const workflow = (method, ...args) => evaluate(`window.scry.workflow.${method}(...${JSON.stringify(args)})`)
  const calls = async () => (await readFile(fixture.callsFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter(row => row.operation === 'run')
  const before = (await calls()).length
  await writeFile(join(fixture.templateWorkspace, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, enabled: true, workspaceId: 'owned-agent-recorder-fixture' }))
  const definition = { schemaVersion: 1, name: 'Copy Agent fixture', description: '', parameters: {}, roles: [{ role: 'orchestrator' }], body: { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'replica', blockId: 'copy' },
    { kind: 'call', blockId: 'work', role: 'orchestrator', prompt: 'desktop remote write one', replica: { kind: 'ref', name: 'copy' } },
    { kind: 'return', blockId: 'report', ref: { nodeId: 'work' } }
  ] } }
  const draft = await templates('saveDraft', { scope: { kind: 'personal' }, source: JSON.stringify(definition) })
  assert.equal(draft.validation.state, 'valid', JSON.stringify(draft.validation))
  const preview = await workflow('instantiateTemplate', { source: { kind: 'draft', draftId: draft.draftId, draftRevision: draft.draftRevision, candidateHash: draft.candidateHash }, commandId: 'copy-agent-instance',
    cwd: fixture.templateWorkspace, userGoal: 'Run the offline App adapter only in the registered copy', parameters: {}, orchestrator: { role: 'orchestrator', providerId: 'codex' }, roles: [] })
  assert.equal(preview.state, 'ready', JSON.stringify(preview.unavailableReasons))
  assert.equal(preview.plannedCalls, 1)
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  await workflow('approve', approval)
  const progress = await workflow('start', preview.workflowId, approval, 'copy-agent-start')
  assert.equal(progress.state, 'completed', JSON.stringify(progress))
  assert.equal(progress.dispatchAttempts, 1)
  const record = JSON.parse(await readFile(join(fixture.userData, 'workflows', preview.workflowId + '.json'), 'utf8'))
  const reference = record.systemOutcomes[0].replica
  assert.deepEqual(record.intents[0].replica, reference)
  assert.equal(record.outcomes[0].settled, true)
  assert.match(record.outcomes[0].archiveRef, /^run:.+:session:.+$/)
  const receipt = JSON.parse(await readFile(join(fixture.userData, 'workflow-replicas', preview.workflowId, reference.replicaId + '.replica.json'), 'utf8'))
  assert.equal(await readFile(join(receipt.directory, 'remote-first.txt'), 'utf8'), 'remote-first.txt\n')
  await assert.rejects(readFile(join(fixture.templateWorkspace, 'remote-first.txt')), { code: 'ENOENT' })
  const catalog = JSON.parse(await readFile(join(fixture.userData, 'app-sessions.json'), 'utf8'))
  const session = catalog.find(row => row.runId === record.outcomes[0].runId)
  assert.equal(session.cwd, receipt.directory)
  assert.equal(session.workspaceScope, 'workflow_replica')
  const turnFiles = []
  for await (const path of glob('**/*.json', { cwd: join(receipt.directory, '.scry', 'records') })) turnFiles.push(path)
  assert.equal(turnFiles.length, 1, 'managed recorder must produce one canonical copy turn')
  const turn = JSON.parse(await readFile(join(receipt.directory, '.scry', 'records', turnFiles[0]), 'utf8'))
  assert.equal(turn.status, 'completed')
  const archived = []
  for await (const path of glob('**/*.json', { cwd: join(fixture.userData, 'trace-archive-turns-v1') })) {
    const value = JSON.parse(await readFile(join(fixture.userData, 'trace-archive-turns-v1', path), 'utf8'))
    if (value.turns?.some(turn => turn.runId === record.outcomes[0].runId)) archived.push(value)
  }
  assert.equal(archived.length, 1, 'App archive must link the exact canonical attempt run')
  assert.equal(archived[0].cwd, receipt.directory)
  const denied = await evaluate(`window.scry.start(${JSON.stringify({ providerId: 'codex', cwd: receipt.directory, prompt: 'not an authorized project' })}).then(() => ({ rejected: false }), error => ({ rejected: true, message: String(error) }))`)
  assert.equal(denied.rejected, true, 'catalog evidence must not authorize ordinary starts in a private copy')
  await workflow('start', preview.workflowId, approval, 'copy-agent-start')
  assert.equal((await calls()).length - before, 1, 'duplicate start and rejected unscoped start must never invoke another Provider')
  return { test: 'owned-copy Agent production IPC/App executor/Recorder/archive', workflowId: preview.workflowId, approval, workspace: receipt.directory,
    agentAttempts: 1, offlineProviderInvocations: 1, sourceUnchanged: true, privateCopyNotGlobalGrant: true, recorderTurns: 1, archiveTurns: 1 }
}

export async function verifyWorkflowReplicaAgentRestart(evaluate, fixture, result) {
  const before = await readFile(fixture.callsFile, 'utf8')
  const denied = await evaluate(`window.scry.start(${JSON.stringify({ providerId: 'codex', cwd: result.workspace, prompt: 'not an authorized project after restart' })}).then(() => false, () => true)`)
  assert.equal(denied, true, 'cold catalog must preserve scoped provenance, not authorize the copy')
  const progress = await evaluate(`window.scry.workflow.start(${JSON.stringify(result.workflowId)}, ${JSON.stringify(result.approval)}, 'copy-agent-start')`)
  assert.equal(progress.state, 'completed')
  assert.equal(progress.dispatchAttempts, 1)
  assert.equal(await readFile(fixture.callsFile, 'utf8'), before, 'cold receipt replay and denied start cannot dispatch a Provider')
  return { coldScopedAuthorityPreserved: true, duplicateStartNoDispatch: true }
}
