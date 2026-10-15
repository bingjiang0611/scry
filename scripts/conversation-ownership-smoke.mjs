import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const hash = value => createHash('sha256').update(value).digest('hex')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const archiveFile = (userData, cwd, sessionId, providerTurnId) => join(userData, 'trace-archive-turns-v1', 'codex',
  `cwd-${hash(cwd)}`, `sid-${hash(sessionId)}`, `turn-${hash(`provider\0${providerTurnId}`)}.json`)

export function seedConversationOwnership({ userData, cwd, otherCwd }) {
  const sessions = [
    { cwd, sessionId: 'owned-native', runId: 'owned-run', providerTurnId: 'owned-turn' },
    { cwd, sessionId: 'owned-archive', runId: 'owned-run', providerTurnId: 'owned-turn' },
    { cwd, sessionId: 'control-native', runId: 'control-run', providerTurnId: 'control-turn' },
    { cwd: otherCwd, sessionId: 'orphan-candidate', runId: 'candidate-run', providerTurnId: 'candidate-turn' }
  ]
  const archivePaths = []
  for (const session of sessions) {
    const file = archiveFile(userData, session.cwd, session.sessionId, session.providerTurnId)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 3, cwd: session.cwd, sessionId: session.sessionId,
      externalSessionId: session.sessionId, providerId: 'codex', runtimeProvider: 'codex_cli',
      turns: [{ runId: session.runId, providerTurnId: session.providerTurnId, forkTurnId: session.providerTurnId,
        userText: 'isolated ownership source', items: [], done: true, status: 'completed', ts: Date.now() }]
    }))
    archivePaths.push(file)
  }
  writeFileSync(join(userData, 'app-sessions.json'), JSON.stringify(sessions.map(session => ({
    ...session, externalSessionId: session.sessionId, providerId: 'codex', runtimeProvider: 'codex_cli',
    preview: 'ownership IPC fixture', ts: Date.now()
  }))))
  const directory = join(userData, 'conversations')
  mkdirSync(directory, { recursive: true })
  const binding = { id: randomUUID(), providerId: 'codex', continuationKey: 'isolated-smoke-home', nativeSessionId: 'owned-native' }
  const ownedId = randomUUID()
  const ownedPath = join(directory, `${ownedId}.json`)
  writeFileSync(ownedPath, JSON.stringify({ version: 1, id: ownedId, cwd, revision: 0,
    bindings: [binding], turns: [{ ordinal: 1, runId: 'owned-run', bindingId: binding.id,
      origin: 'imported', items: [], nativeItems: [], archive: { sessionId: 'owned-archive', providerTurnId: 'owned-turn' } }]
  }))
  const orphanId = randomUUID()
  const orphanBinding = { id: randomUUID(), providerId: 'codex', continuationKey: 'isolated-smoke-home' }
  const orphanPath = join(directory, `${orphanId}.json`)
  writeFileSync(orphanPath, JSON.stringify({ version: 1, id: orphanId, cwd: otherCwd, revision: 1,
    bindings: [orphanBinding], turns: [{ ordinal: 1, runId: 'orphan-run', bindingId: orphanBinding.id,
      origin: 'dispatch', items: [], commandId: 'orphan-command', intentHash: hash('isolated orphan input'),
      resumeSessionId: null, importedItems: [], omittedItems: [], delivery: { status: 'pending' } }]
  }))
  return { userData, cwd, otherCwd, ownedPath, orphanPath, protectedPaths: [ownedPath, ...archivePaths.slice(0, 2)],
    callsFile: join(userData, 'smoke-provider-calls.jsonl') }
}

export function prepareOwnershipRecoveryFailure(fixture) {
  // Simulate an orphan from a previous process in this isolated userData only.
  const orphan = json(fixture.orphanPath)
  orphan.turns[0].delivery = { status: 'pending' }
  orphan.revision = 1
  writeFileSync(fixture.orphanPath, JSON.stringify(orphan))
  const directory = dirname(fixture.orphanPath)
  chmodSync(directory, 0o500)
  assert.throws(() => accessSync(directory, constants.W_OK), 'fixture must actually deny atomic publication')
  return () => chmodSync(directory, 0o700)
}

async function verifyCompletedControl(evaluate, fixture, runId) {
  const providerTurnId = `${runId}:provider-turn`
  const page = await evaluate(`window.scry.loadSession(${JSON.stringify({
    providerId: 'codex', cwd: fixture.cwd, externalSessionId: 'control-native'
  })})`)
  const archived = json(archiveFile(fixture.userData, fixture.cwd, 'control-native', providerTurnId))
  assert.equal(archived.turns.find(turn => turn.runId === runId)?.status, 'completed',
    'persisted archive must confirm success, not merely that the run stopped')
  for (const [source, turns] of [['production history IPC', page.turns], ['persisted archive', archived.turns]]) {
    const turn = turns.find(item => item.runId === runId)
    assert.ok(turn, `${source}: completed control turn missing`)
    assert.equal(turn.providerTurnId, providerTurnId, `${source}: wrong native turn`)
    // LoadedSessionTurn projects done/error/errorHint, not the archive status field.
    assert.equal(turn.done, true, `${source}: turn is not terminal`)
    assert.equal(turn.error, undefined, `${source}: run failed`)
    assert.equal(turn.errorHint, undefined, `${source}: run has an interruption or error hint`)
    assert.ok(turn.items.some(item => item.kind === 'harness' && item.stage === 'result' &&
      item.text === 'smoke fixture completed' && !item.isError), `${source}: successful result evidence missing`)
    assert.equal(turn.userText, 'desktop remote write one', `${source}: input changed`)
    assert.ok(turn.items.some(item => item.kind === 'model' && item.text === 'isolated remote assistant evidence'),
      `${source}: assistant evidence missing`)
    assert.ok(turn.items.some(item => item.kind === 'tool' && item.fileOp === 'write' && item.filePath === 'remote-first.txt'),
      `${source}: write evidence missing`)
  }
  assert.equal(readFileSync(join(fixture.cwd, 'remote-first.txt'), 'utf8'), 'remote-first.txt\n',
    'test Provider must actually write the isolated workspace file')
}

export async function exerciseOwnershipRecoveryFailure(evaluate, fixture, { completedRunId, providerCalls }) {
  const before = readFileSync(fixture.callsFile, 'utf8')
  assert.deepEqual(before.trim().split('\n').map(JSON.parse), providerCalls,
    'restart must not replay the completed input')
  await verifyCompletedControl(evaluate, fixture, completedRunId)
  await evaluate(`window.scry.setCwd(${JSON.stringify(fixture.otherCwd)})`)
  const result = await evaluate(`(async () => {
    try { return { value: await window.scry.start(${JSON.stringify({ providerId: 'codex', cwd: fixture.otherCwd,
      commandId: randomUUID(), expectedExternalSessionId: null, prompt: 'fresh input must not bypass failed startup recovery' })}) } }
    catch (error) { return { error: String(error) } }
  })()`)
  assert.match(result.error ?? '', /EACCES|EPERM|permission denied/, `fresh input bypassed failed startup: ${JSON.stringify(result)}`)
  assert.equal(readFileSync(fixture.callsFile, 'utf8'), before, 'failed startup reached the Provider')
  assert.equal(json(fixture.orphanPath).turns[0].delivery.status, 'pending', 'failed publication must not claim unknown was persisted')
  assert.equal(json(fixture.orphanPath).revision, 1, 'failed publication must retain the original revision')
  return { freshStartRejected: true, providerCallsUnchanged: true, failedPublicationRetained: true,
    completedTurnReloadedAfterRestart: true }
}

export async function exerciseConversationOwnership(evaluate, fixture) {
  const { cwd, otherCwd, callsFile, ownedPath, orphanPath, protectedPaths } = fixture
  const calls = () => existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse) : []
  const evidence = () => protectedPaths.map(path => ({ path, hash: hash(readFileSync(path)) }))
  const originalEvidence = evidence()
  const blocked = []
  const context = (sessionId, directory = cwd) => ({ providerId: 'codex', cwd: directory, externalSessionId: sessionId })
  const open = async (sessionId, directory = cwd) => {
    await evaluate(`window.scry.setCwd(${JSON.stringify(directory)})`)
    const page = await evaluate(`window.scry.loadSession(${JSON.stringify(context(sessionId, directory))})`)
    assert.ok(page?.turns?.length, `production history failed to open ${sessionId}`)
  }
  const deny = async (name, expression, reason) => {
    const before = calls()
    const result = await evaluate(`(async () => {
      try { return { value: await (${expression}) } }
      catch (error) { return { error: String(error) } }
    })()`)
    assert.match(result.error ?? '', reason, `${name}: expected ownership refusal, got ${JSON.stringify(result)}; adapter calls=${JSON.stringify(calls())}`)
    assert.deepEqual(calls(), before, `${name}: production IPC reached the Provider adapter`)
    assert.deepEqual(evidence(), originalEvidence, `${name}: owned source evidence changed`)
    blocked.push(name)
  }
  const start = (sessionId, directory = cwd, prompt = 'ownership IPC verification') => `window.scry.start(${JSON.stringify({
    providerId: 'codex', cwd: directory, expectedExternalSessionId: sessionId,
    commandId: randomUUID(), prompt
  })})`
  const fork = (sessionId, runId, turnId) => `window.scry.forkSession(${JSON.stringify({ providerId: 'codex', cwd,
    sourceSessionId: sessionId, sourceRunId: runId, sourceProviderTurnId: turnId, sourceForkTurnId: turnId })})`

  await open('owned-native')
  await deny('owned resume', start('owned-native'), /归属统一对话/)
  await deny('owned fork', fork('owned-native', 'owned-run', 'owned-turn'), /归属统一对话/)
  for (const alias of ['owned-native', 'owned-run', 'owned-archive']) {
    await deny(`owned deletion: ${alias}`, `window.scry.deleteSession(${JSON.stringify(context(alias))})`, /归属统一对话/)
  }
  assert.equal(calls().length, 0, 'blocked operations must never enter the adapter')

  await open('orphan-candidate', otherCwd)
  await deny('orphan unknown resume', start('orphan-candidate', otherCwd), /未确认投递/)
  const orphan = json(orphanPath)
  assert.equal(orphan.turns[0].delivery.status, 'unknown', 'production startup must recover orphan pending before allowing writes')
  assert.equal(orphan.revision, 2)
  assert.equal(json(ownedPath).revision, 0, 'startup must not rewrite confirmed ownership')

  // Positive controls use the same preload, trusted main wrapper and adapter. A
  // missing/broken IPC route or globally disabled Provider cannot satisfy this test.
  await open('control-native')
  const forked = await evaluate(fork('control-native', 'control-run', 'control-turn'))
  assert.equal(forked.externalSessionId, 'smoke-fork-control-run')
  assert.deepEqual(calls(), [{ operation: 'fork', identity: 'control-native' }])
  const deleted = await evaluate(`window.scry.deleteSession(${JSON.stringify(context(forked.externalSessionId))})`)
  assert.equal(deleted.ok, true, `unowned deletion must still work: ${JSON.stringify(deleted)}`)

  await open('control-native')
  const started = await evaluate(start('control-native', cwd, 'desktop remote write one'))
  assert.ok(started.runId)
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (calls().some(call => call.operation === 'run' && call.identity === started.runId) &&
      await evaluate('window.scry.focusedRunSnapshot()') === null) break
    await delay(50)
  }
  assert.deepEqual(calls(), [{ operation: 'fork', identity: 'control-native' }, { operation: 'run', identity: started.runId }])
  assert.equal(await evaluate('window.scry.focusedRunSnapshot()'), null, 'positive run must settle before fixture shutdown')
  await verifyCompletedControl(evaluate, fixture, started.runId)
  assert.deepEqual(evidence(), originalEvidence, 'positive controls changed another conversation source')
  return { test: 'conversation ownership production IPC', blocked, providerCalls: calls(),
    completedRunId: started.runId, completedArchiveAndWorkspaceWriteVerified: true,
    positiveControls: ['unowned fork', 'unowned deletion', 'unowned resume'],
    orphanRecovery: 'pending -> unknown, revision 1 -> 2', ownedEvidenceUnchanged: true }
}
