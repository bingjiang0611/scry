#!/usr/bin/env node
// OS-network-denied synthetic Provider peer; actual private recorder CLI only in its dedicated case.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, connect } from 'node:net'
import { once } from 'node:events'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, renameSync, existsSync, realpathSync, readdirSync, lstatSync, watch as watchFile } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { builtinModules, createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { build, stop as stopBuild } from 'esbuild'

const script = fileURLToPath(import.meta.url)
const node = process.execPath
const sandbox = '/usr/bin/sandbox-exec'
const profile = '(version 1)(allow default)(deny network*)'
const budgetMs = 8_000
const cap = 16 * 1024
const cases = ['complete', 'interrupt', 'negative', 'runner-complete', 'runner-interrupt', 'runner-plain', 'recorder-complete', 'recorder-interrupt', 'recorder-failed']
const privateRecorderRoot = join(dirname(script), '../packages/turn-recorder-cli')
const privateRecorderCli = join(privateRecorderRoot, 'dist/cli/scry.js')
const privateRecorderCliHash = '1457bd9e30b87e8617571019ea59112182a77fae0f45255ec587bdcbaab6c274'
const privateRecorderPackage = join(privateRecorderRoot, 'package.json')
const privateRecorderPackageHash = '6be1c01c0c86c930467448d88c98c1f5f5a498d269cacfa1ba733d89bc04edae'
const privateRecorderPackageVersion = '0.2.49'
const privateRecorderManifest = {
  'package.json': privateRecorderPackageHash,
  'dist/cli/pi-integration.js': 'c9d33f78dd884178e5ac126bdcdff9785254ba9c4c35a64ffd2d398a4057bb69',
  'dist/cli/scry.js': privateRecorderCliHash,
  'dist/cli/status.js': '0427bd86d742a16368e436659724deac6c0332f746df9e6b7a08d218545b7f38',
  'dist/cli/support-bundle.js': 'c5bb807de2d93b5adc9fc0f2abf1d1b2a8bdbc9e68641baeb1ef5fa09fb0c60d',
  'dist/cli/update.js': '6fe806fc90a423ae79f8aea2a6c397d44ea5054aee10a8e2b60f852341387d85',
  'dist/cli/workspace-init.js': 'cd4c4bc47891416f4ee1d01e40a9ef437b98d6919db7ffec3b66b5c6f3d8930c',
  'dist/core/turn-recorder/aggregate.js': 'eeae285ed6d1066d648f7edf09aa4d890f54323b0cd9c8d0b3c97defa14aa359',
  'dist/core/turn-recorder/change-journal.js': '1080a2cb1ebedab273ce27603d9f715f604987f665c437cb35275cbbf65f48da',
  'dist/core/turn-recorder/commit-hook-grant.js': '192503d305a08a9aaf933055357c7eb21fca0b19dbb895c191b67203086d4998',
  'dist/core/turn-recorder/config.js': 'd507d1409624d636dd7dd5ba0a35bb9d458b5376fe9198539c538eabcfdc833a',
  'dist/core/turn-recorder/content-store.js': '25eb0a4ebe7965d50000d3d0009c2dd829c00fc69ce8a35abcca89760a710b25',
  'dist/core/turn-recorder/daemon.js': '7e9f717c3cdeaf8c55c3864bd02fdf217708c750486092ee33656438c2d435f0',
  'dist/core/turn-recorder/git.js': '5cf99846159a6db7442fc5ada45ec0b654f66871773bacb2ae8139f1852e1b0b',
  'dist/core/turn-recorder/io.js': 'd0774238765b8859963dd0355cfc6d3d5f49a9d747ac8c87545f81218b7696f1',
  'dist/core/turn-recorder/maintenance.js': '00ec8576db533fbc7d5791d2c78759fa4614fbe829b9d31c27789f40b53d230a',
  'dist/core/turn-recorder/managed-interruption.js': '59bc39cb0ee0dfc535611a04b071a04c87b22461423c4edd9532b829b2bac7f5',
  'dist/core/turn-recorder/managed.js': '9afcc12dc9f5e155cd8651e11308c0b045db00d84499db5e571c5144eb6b49d5',
  'dist/core/turn-recorder/provider-activity.js': '05a5930316f2aea29e6f7cc5610baf6974027ecfa9b224c530367fa8d0899ef1',
  'dist/core/turn-recorder/recorder.js': '2becf01d99678e9225a5b29794bfd1dfdfc215dec9161aabb60f52466cafe426',
  'dist/core/turn-recorder/runtime-state.js': 'd46bb62674b774beb11b4b8c3a3e250e8c3cb370d0e93af12672b5f2832e67c5',
  'dist/core/turn-recorder/store.js': 'b6117deb23910a28a25dbdb88d279cb8d67568110ab93262385eba3fb5c9ccc7',
  'dist/core/turn-recorder/tool-content.js': 'b8d8722f66d08a36c639f9f14e31d6e1ae430de75bb2a473f02b145b74722488',
  'dist/core/turn-recorder/turns-summary.js': '89802445f5214073f648f8a90f5c793c532ab4c2e2a86842522ce68da27fee4f',
  'dist/main/danger.js': '8dbea1a5104dac715a60ef66bbcba9f389e985b50fff917246c3ba70ac351b77',
  'dist/main/normalize.js': '6a7f0e921b539bc5ca5a7e3a07ef62a60dedaa99f0c36cdcdf5fd3c6536040db',
  'dist/shared/background-work.js': '42c79b277fd50d4a6b7fbb3f04ff8c32dba68eecabfcb1fe7cad422941bb5b23',
  'dist/shared/billing.js': 'c430809d26eeb88037266802d8d308a50f8b6646de3fbeb1849203200a368dd6',
  'dist/shared/credit-usage.js': '1f5ae4ec23e71cf71a37626526705124efecfc5206833c3104ca53ad5df23185',
  'dist/shared/file-evidence.js': 'c5d4a1f91234bc037df4ff08342b71ec1972f0f529514af8ea61f3ae7c141462',
  'dist/shared/llm-performance.js': '0c3b1429013f323ac6ce7ce52361af52e3fee61880cbc63cab1d1bbfc7117295',
  'dist/shared/logical-calls.js': '9bed0b362071242f870ae883c803c0c97f015f08a0b23821cb8e85c2e2176d38',
  'dist/shared/model-timing.js': '5471bdacc25c474ccef6ec5e00db020a13691debbc01132412381b6228167ea8',
  'dist/shared/provider-compatibility.js': '96a56b5551d0c9fac727494a89c546ee05c2581b5bb5a5cfffa928d787b078f5',
  'dist/shared/provider.js': '4ff0b9d5117871888bfd6d50cf23d1ac5a82b2a44e7ec2cb2f6909c5a79cc8e1',
  'dist/shared/qoder-credit-requests.js': '94442e079e12912029c50d1e796caba378948e20e8aeff042625258a8aa5a8df',
  'dist/shared/result-timing.js': '13a768adec92e6ad1630528f13ffaddffe39587ecd81b1f6a4b6946eac6f7f22',
  'dist/shared/runtime.js': '2dd48eb8a2207629ca25c7052b5e00fa839c9e5fc6ccc9d189a70e47f0a044da',
  'dist/shared/session-attention.js': 'c9012033f4923c0404c4b11b14e890bdaef846d84aee7aa6bb513fdcbcf312d2',
  'dist/shared/tool-content.js': '13aba1f5530ae574cb2b08a88e8b3f5b01d839c25802f54a478c958a02865d11',
  'dist/shared/trace.js': '137b79a6fa6a9823326683f353a797c8f8a6fb8e19f1753480b6767bd7ec3ff4',
  'dist/shared/turn-record.js': '464bcfceb366305177fbf22e7cadd541fbeb4fde3b747aff77167db10d9d8b1a',
  'dist/shared/usage-dedupe.js': 'ac5fec849ccc85a3df65ecc95be75e2001eee35fdcbb1e73c009d217954f5055'
}
const privateRecorderManifestHash = 'e80a9d3fc68dd2e514a551a46657266b85f6e5ffb940b8d2f3f449dba357ed70'
const session = '00000000-0000-4000-8000-000000000001'
const promptId = '00000000-0000-4000-8000-000000000002'
const prompt = 'synthetic prompt with spaces\nand newline'
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
// Read only this fixture's native session, never global history. Bound snapshot
// size so rejection/recovery checks do not grow with unrelated workspaces.
function runtimeFiles(root) {
  const files = {}
  let bytes = 0, entries = 0
  const visit = (dir, prefix = '') => {
    for (const name of readdirSync(dir).sort()) {
      assert(++entries <= 128, 'Runtime snapshot exceeds fixture entry budget')
      const file = join(dir, name), relative = prefix + name, stat = lstatSync(file)
      assert(!stat.isSymbolicLink(), 'Unexpected runtime symlink')
      // This index is explicitly derived from committed records, not lifecycle
      // authority; a rejected lookup may legitimately build its empty cache.
      if (relative === 'provider-turn-index.json') continue
      if (stat.isDirectory()) visit(file, relative + '/')
      else {
        assert(stat.isFile())
        bytes += stat.size
        assert(bytes <= 1024 * 1024, 'Runtime snapshot exceeds fixture byte budget')
        files[relative] = hash(file)
      }
    }
  }
  visit(root)
  return files
}
function assertRecorderIntegrity() {
  assert.equal(hash(privateRecorderCli), privateRecorderCliHash, 'Pinned recorder CLI entry hash changed')
  const packageJson = JSON.parse(readFileSync(privateRecorderPackage, 'utf8'))
  assert.equal(packageJson.version, privateRecorderPackageVersion, 'Pinned recorder package version changed')
  assert.equal(hash(privateRecorderPackage), privateRecorderPackageHash, 'Pinned recorder package hash changed')
  const root = dirname(dirname(dirname(privateRecorderCli)))
  const entries = Object.entries(privateRecorderManifest)
  const actual = entries.map(([relative, expected]) => {
    const file = join(root, relative)
    assert.equal(hash(file), expected, `Pinned recorder dependency hash changed: ${relative}`)
    return `${relative} ${expected}`
  }).join('\n') + '\n'
  assert.equal(createHash('sha256').update(actual).digest('hex'), privateRecorderManifestHash, 'Pinned recorder dependency manifest changed')
  return { entry: privateRecorderCli, entryHash: privateRecorderCliHash, package: privateRecorderPackage,
    packageHash: privateRecorderPackageHash, packageVersion: packageJson.version, manifestHash: privateRecorderManifestHash,
    files: Object.fromEntries(entries) }
}
const log = (root, event, data = {}) => appendFileSync(join(root, 'harness.jsonl'), JSON.stringify({ event, ...data }) + '\n')
const birth = pid => execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim()
const register = (root, kind, pid, file) => {
  const identity = { kind, pid, file, hash: hash(file), node, uid: process.getuid(), root }
  // macOS blocks ps inside the sandbox. The outer owner obtains the OS birth
  // identity; do not weaken the profile to enable process inspection inside it.
  if (process.argv[2] === '--harness') process.stdout.write(JSON.stringify({ event: 'register', identity }) + '\n')
  else appendFileSync(join(root, 'registered.jsonl'), JSON.stringify({ ...identity, birth: birth(pid) }) + '\n')
  return identity
}
const observeExit = child => new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('close', (code, signal) => resolve({ code, signal }))
})
const networkProbe = port => new Promise(resolve => {
  const socket = connect({ host: '127.0.0.1', port })
  socket.once('connect', () => { socket.destroy(); resolve('CONNECTED') })
  socket.once('error', error => { socket.destroy(); resolve(error.code) })
})

// Watchers consume only complete NDJSON records. A malformed complete line is
// evidence failure, not an ignorable partial write.
function watchWire(root, onEvent, onError) {
  let offset = 0, pending = '', failed = false
  const scan = () => {
    if (failed || !existsSync(join(root, 'wire.jsonl'))) return
    try {
      const text = readFileSync(join(root, 'wire.jsonl'), 'utf8')
      assert(text.length <= cap, 'Wire evidence exceeded the bounded capture')
      pending += text.slice(offset)
      offset = text.length
      let newline
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        assert(line.length > 0, 'Empty wire evidence line')
        onEvent(JSON.parse(line))
      }
    } catch (error) { failed = true; watcher.close(); onError(error) }
  }
  const watcher = watchFile(root, scan)
  scan()
  return { close: () => watcher.close() }
}

function completeWire(root) {
  const text = readFileSync(join(root, 'wire.jsonl'), 'utf8')
  assert(text.length <= cap, 'Wire evidence exceeded the bounded capture')
  assert(text.endsWith('\n'), 'Wire evidence ended with an incomplete NDJSON line')
  return text.split('\n').slice(0, -1).map(line => {
    assert(line.length > 0, 'Empty wire evidence line')
    return JSON.parse(line)
  })
}

function waitForWireEvent(root, predicate, signal) {
  return new Promise((resolve, reject) => {
    let watched, settled = false
    const abort = () => finish(reject, signal.reason)
    const finish = (settle, value) => {
      if (settled) return
      settled = true
      watched?.close()
      signal.removeEventListener('abort', abort)
      settle(value)
    }
    signal.addEventListener('abort', abort, { once: true })
    watched = watchWire(root, event => {
      if (predicate(event)) finish(resolve, event)
    }, error => finish(reject, error))
    if (signal.aborted) abort()
    if (settled) watched.close()
  })
}

// Only on a failed test: signal recorded fixture processes after rechecking OS
// birth, user and command identity. Unknown ownership is reported, never killed.
function stopRegistered(root) {
  const file = join(root, 'registered.jsonl')
  if (!existsSync(file)) return
  const records = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).reverse()
  for (const record of records) {
    try { process.kill(record.pid, 0) } catch (error) { if (error.code === 'ESRCH') continue; throw error }
    assert.equal(record.root, root)
    assert.equal(record.node, node)
    assert.equal(record.uid, process.getuid())
    assert.equal(hash(record.file), record.hash)
    assert.equal(birth(record.pid), record.birth, 'PID identity changed; refusing cleanup')
    const uid = execFileSync('/bin/ps', ['-p', String(record.pid), '-o', 'uid='], { encoding: 'utf8' }).trim()
    const command = execFileSync('/bin/ps', ['-p', String(record.pid), '-o', 'command='], { encoding: 'utf8' }).trim()
    assert.equal(Number(uid), record.uid)
    assert(command.startsWith(node + ' ') && command.includes(record.file), 'Executable/command changed; refusing cleanup')
    process.kill(record.pid, 'SIGTERM')
    log(root, 'failure-cleanup-signal', { pid: record.pid })
  }
}

async function runHarness(root, mode, port) {
  const denied = await networkProbe(port)
  log(root, 'sdk-network', { code: denied })
  assert.equal(denied, 'EPERM', 'SDK parent must be OS-network-denied')
  const fake = join(root, 'fake claude')
  const expectedHash = hash(fake)
  const messages = []
  let hook, query, child, childExit, spawnRecord, timer, timedOut = false
  if (mode.startsWith('runner-')) {
    const bundle = process.env.SCRY_RUNNER_BUNDLE
    assert(bundle, 'Production runner bundle is required')
    const production = await import(pathToFileURL(bundle).href)
    const lifetime = new AbortController()
    const work = async () => {
      const cwd = join(root, 'workspace with spaces')
      const observations = []
      const native = []
      const trace = []
      assert.equal(process.env.HOME, join(root, 'home'))
      assert(!Object.keys(process.env).some(key => /^(ANTHROPIC_|AWS_|GOOGLE_|AZURE_)/.test(key)), 'Credential environment leaked')
      const tracker = new production.WorkflowLiveObservationTracker({
        taskId: 'fixture-task', attemptId: mode, runId: `fixture-${mode}`, providerId: 'claude'
      })
      let activitySeen
      const activity = new Promise(resolve => { activitySeen = resolve })
      const handle = production.runAgent(prompt, `fixture-${mode}`, event => trace.push(structuredClone(event)), {
        cwd,
        claudePath: fake,
        env: { ...process.env },
        permissionMode: 'default',
        mcpServers: {},
        captureProviderTurnId: true,
        recordNative: (type, payload) => native.push({ type, payload: structuredClone(payload) }),
        onWorkflowObservation: mode === 'runner-plain' ? undefined : observation => {
          observations.push(observation)
          tracker.observe(observation)
          if (observation.kind === 'tool_activity') activitySeen()
        }
      })
      let settled = false
      const pending = handle.promise.then(() => { settled = true }, () => { settled = true })
      if (mode === 'runner-interrupt') {
        await Promise.race([activity, handle.promise.then(() => assert.fail('Runner ended before observed activity'))])
        handle.interrupt()
        await waitForWireEvent(root, event => event.event === 'interrupt-ack', lifetime.signal)
        assert.equal(settled, false, 'Runner promise settled before the fake interrupt gate')
        assert(!completeWire(root).some(event => event.event === 'terminal'), 'Fake emitted terminal evidence before release')
        writeFileSync(join(root, 'release.tmp'), 'release-after-ack\n')
        renameSync(join(root, 'release.tmp'), join(root, 'release'))
      }
      const result = await handle.promise
      await pending
      const wire = await waitForWireEvent(root, event => event.event === 'cli-exit', lifetime.signal)
      assert.equal(wire.code, 0, 'Fake CLI must exit cleanly')
      const evidence = completeWire(root)
      assert(evidence.some(event => event.event === 'stdin-eof' && event.ended), 'Clean stdin EOF missing')
      assert.equal(evidence.find(event => event.event === 'cli-network')?.code, 'EPERM')
      const cliStart = evidence.find(event => event.event === 'cli-start')
      assert(cliStart, 'Fake CLI start evidence missing')
      assert.equal(realpathSync(cliStart.executable), realpathSync(node))
      assert.equal(realpathSync(cliStart.cwd), realpathSync(cwd))
      assert.equal(cliStart.argv.slice(2).some(arg => arg.includes('dangerously-skip') || arg === 'bypassPermissions'), false)
      assert.equal(result.sessionId, session)
      assert.equal(result.providerTurnId, promptId)
      assert.equal(result.status, mode === 'runner-interrupt' ? 'interrupted' : 'completed')
      assert.equal(result.stopped, mode === 'runner-interrupt')
      assert.deepEqual(observations, mode === 'runner-plain' ? [] : [
        { source: 'claude_native', kind: 'model_progress', channel: 'text' },
        { source: 'claude_native', kind: 'model_progress', channel: 'thinking' },
        { source: 'claude_native', kind: 'tool_activity', toolCallId: 'fixture-tool-call' },
        { source: 'claude_native', kind: 'tool_returned', toolCallId: 'fixture-tool-call' }
      ])
      assert.deepEqual(tracker.snapshot().activeToolIds, [])
      assert.equal(tracker.snapshot().trackedToolCount, 0)
      assert.equal(tracker.snapshot().modelProgressCount, mode === 'runner-plain' ? 0 : 2)
      const nativeTypes = native.map(item => item.type)
      for (const type of ['system', 'stream_event', 'assistant', 'tool_progress', 'user', 'result']) assert(nativeTypes.includes(type), `Native ${type} evidence missing`)
      assert(trace.some(event => event.kind === 'model' && event.stage === 'text_delta' && event.text === 'synthetic text'))
      assert(native.some(event => event.type === 'stream_event' && event.payload.event.delta?.thinking === 'synthetic thinking'))
      assert(trace.some(event => event.kind === 'tool' && event.toolUseId === 'fixture-tool-call' && event.input?.synthetic === true))
      assert(trace.some(event => event.kind === 'tool' && event.stage === 'tool_result' && event.toolUseId === 'fixture-tool-call' && event.output === 'synthetic reply'))
      writeFileSync(join(root, 'runner.json'), JSON.stringify({ result, observations, native, trace, tracker: tracker.snapshot() }, null, 2))
      log(root, 'case-passed', { mode, status: result.status, cliExit: wire.code })
      return { mode, status: result.status, sessionId: result.sessionId, providerTurnId: result.providerTurnId, native: native.length, trace: trace.length, observations: observations.length, sdkNetwork: denied, cliNetwork: 'EPERM' }
    }
    try {
      return await Promise.race([work(), new Promise((_, reject) => {
        timer = setTimeout(() => { timedOut = true; reject(new Error('Production runner exceeded 8000ms')) }, budgetMs)
      })])
    } finally { clearTimeout(timer); lifetime.abort(new Error('Runner fixture decision finished')) }
  }
  if (mode.startsWith('recorder-')) {
    const bundle = process.env.SCRY_RUNNER_BUNDLE
    assert(bundle, 'Production adapter bundle is required')
    assert.equal(process.env.SCRY_CLAUDE_PATH, fake)
    assert.equal(process.env.SCRY_CLI_PATH, privateRecorderCli)
    assert.equal(process.env.SCRY_RECORDER_COMMIT_HOOK, undefined, 'Custom commit callbacks are forbidden')
    assertRecorderIntegrity()
    const production = await import(pathToFileURL(bundle).href)
    const cwd = realpathSync(join(root, 'workspace with spaces'))
    execFileSync('/usr/bin/git', ['init', '--quiet', '--initial-branch=main', cwd], { env: process.env, stdio: 'pipe' })
    assert.equal(execFileSync('/usr/bin/git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { env: process.env, encoding: 'utf8' }).trim(), cwd)
    const initialized = await production.initWorkspace({ workspace: cwd, providers: 'claude', cliPath: privateRecorderCli })
    assert.equal(initialized.workspace, cwd)
    assert.deepEqual(initialized.providers, ['claude'])
    const enabled = await production.resolveRecorderEnablement(cwd)
    assert.equal(enabled.enabled, true)
    const toolContentPolicy = { ...enabled.config.capture }
    const lifetime = new AbortController()
    const runId = `fixture-${mode}`
    const expectedStatus = mode === 'recorder-interrupt' ? 'interrupted' : mode === 'recorder-failed' ? 'failed' : 'completed'
    const native = []
    const trace = []
    const startedAt = new Date().toISOString()
    let activitySeen
    const activity = new Promise(resolve => { activitySeen = resolve })
    const adapter = production.createClaudeAdapter(join(root, 'home'))
    const handle = adapter.run({
      runId,
      prompt,
      cwd,
      attachments: [],
      permissionMode: 'default',
      managedRecorder: true,
      managedRecorderIdentity: { runId, promptHash: createHash('sha256').update(prompt).digest('hex') },
      emit: event => trace.push(structuredClone(event)),
      recordNative: (type, payload) => native.push({ type, payload: structuredClone(payload) }),
      onExternalSessionId: sessionId => log(root, 'adapter-session', { sessionId }),
      onWorkflowObservation: observation => { if (observation.kind === 'tool_activity') activitySeen() }
    })
    let timer, settled = false
    const settlement = handle.promise.then(() => { settled = true }, () => { settled = true })
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Managed recorder adapter exceeded 8000ms')
        lifetime.abort(error)
        reject(error)
      }, budgetMs)
    })
    try {
      if (mode === 'recorder-interrupt') {
        await Promise.race([activity, handle.promise.then(() => assert.fail('Adapter ended before native activity')), deadline])
        handle.interrupt()
        await Promise.race([waitForWireEvent(root, event => event.event === 'interrupt-ack', lifetime.signal), deadline])
        assert.equal(settled, false, 'Interrupt ACK is not adapter completion')
        const held = completeWire(root)
        assert(!held.some(event => event.event === 'terminal' || (event.event === 'recorder-hook' && event.hookEvent === 'Stop')))
        assert.deepEqual(await production.listRecords(join(cwd, '.scry')), [])
        assert.equal(await production.recorderHasOpenTurn(join(cwd, '.scry')), true)
        log(root, 'interrupt-ack-pending', { adapterSettled: settled, canonicalRecords: 0 })
        writeFileSync(join(root, 'release.tmp'), 'release-after-ack\n')
        renameSync(join(root, 'release.tmp'), join(root, 'release'))
      }
      const result = await Promise.race([handle.promise, deadline])
      await settlement
      assert.equal(result.externalSessionId, session)
      assert.equal(result.providerTurnId, promptId)
      assert.equal(result.status, expectedStatus)
      assert.equal(result.stopped, mode === 'recorder-interrupt')
      assert.equal(native.findLast(event => event.type === 'result').payload.is_error, expectedStatus !== 'completed')
      await waitForWireEvent(root, event => event.event === 'cli-exit', lifetime.signal)
      const wire = completeWire(root)
      assert(wire.some(event => event.event === 'cli-network' && event.code === 'EPERM'))
      assert(wire.some(event => event.event === 'stdin-eof' && event.ended))
      assert(wire.some(event => event.event === 'cli-exit' && event.code === 0))
      assert(!wire.some(event => event.event === 'signal'))
      const hooks = wire.filter(event => event.event === 'recorder-hook')
      assert.deepEqual(hooks.map(event => event.hookEvent), ['UserPromptSubmit', 'Stop'])
      for (const hook of hooks) {
        assert.equal(hook.executable, privateRecorderCli)
        assert.equal(hook.executableHash, privateRecorderCliHash)
        assert.equal(hook.command, node)
        assert.deepEqual(hook.argv, [node, privateRecorderCli,
          'recorder', 'hook', '--provider', 'claude', '--event', hook.hookEvent,
          '--workspace', cwd, '--stdin', '--verbose', '--managed'
        ])
        const exit = wire.find(event => event.event === 'recorder-hook-exit' && event.pid === hook.pid && event.hookEvent === hook.hookEvent)
        assert(exit, 'Recorder hook native exit evidence missing')
        assert.equal(exit.code, 0)
        assert.equal(exit.signal, null)
        assert.equal(JSON.parse(exit.stdout).status, hook.hookEvent === 'Stop' ? 'pending' : 'started')
      }
      assert.equal(process.env.SCRY_RECORDER_COMMIT_HOOK, undefined)
      const recordsBefore = await production.listRecords(join(cwd, '.scry'))
      assert.deepEqual(recordsBefore, [], 'Stop hook must not create a canonical record')
      assert.equal(await production.recorderHasOpenTurn(join(cwd, '.scry')), true, 'Managed Stop must leave pending lifecycle')
      const sessionRoot = production.recorderSessionRoot(join(cwd, '.scry'), 'claude', session)
      const beforeRecovery = runtimeFiles(sessionRoot)
      const recoveryBeforePrepare = await production.recoverManagedRecorderTurns(cwd, process.env, { provider: 'claude', sessionId: session })
      assert.deepEqual(recoveryBeforePrepare, { recovered: 0, pending: 1 })
      assert.deepEqual(runtimeFiles(sessionRoot), beforeRecovery, 'Recovery altered an unprepared native lifecycle')
      assert.equal((await production.readHealth(join(cwd, '.scry'))).pendingCount, 1)
      assert.deepEqual(await production.listRecords(join(cwd, '.scry')), [])
      const completedAt = new Date().toISOString()
      const timing = { startedAt, completedAt, durationMs: Date.parse(completedAt) - Date.parse(startedAt) }
      assert(timing.durationMs >= 0)
      const aggregate = production.aggregateTurnEvidence({ userText: prompt, events: trace, source: 'scry_provider_adapter', toolContentPolicy })
      // Bind a real standalone evidence artifact, not a claimed App archive commit.
      assert.equal(aggregate.hooks.quality, 'exact')
      assert.deepEqual(aggregate.hooks.value.map(hook => hook.event), ['UserPromptSubmit', 'Stop'])
      const archive = { scope: 'standalone-fake-cli', runId, status: result.status, evidence: aggregate, timing, toolContentPolicy, sessionId: result.externalSessionId, providerTurnId: result.providerTurnId }
      writeFileSync(join(root, 'archive.tmp'), JSON.stringify(archive))
      renameSync(join(root, 'archive.tmp'), join(root, 'archive.json'))
      const archived = JSON.parse(readFileSync(join(root, 'archive.json'), 'utf8'))
      const evidence = archived.evidence
      const archiveFingerprint = production.stableHash(archived)
      const turnInput = {
        workspace: cwd, provider: 'claude', sessionId: result.externalSessionId, runId,
        providerTurnId: result.providerTurnId, userText: prompt, evidence, timing, toolContentPolicy,
        status: result.status, archiveFingerprint
      }
      await assert.rejects(production.prepareManagedRecorderTurn({ ...turnInput, providerTurnId: '00000000-0000-4000-8000-000000000003' }), /Provider turn id differs from the open lifecycle identity/)
      assert.deepEqual(runtimeFiles(sessionRoot), beforeRecovery, 'Rejected identity changed native lifecycle')
      assert.deepEqual(JSON.parse(readFileSync(join(sessionRoot, 'provider-turn-index.json'), 'utf8')), {
        schemaVersion: 1, stamp: { count: 0, maxSequence: 0 }, providerTurnRecordIds: {}
      }, 'Rejected identity must not index a nonexistent canonical record')
      assert.deepEqual(await production.listRecords(join(cwd, '.scry')), [])
      const prepared = await production.prepareManagedRecorderTurn(turnInput)
      assert.equal(prepared.status, 'prepared')
      assert.deepEqual(await production.listRecords(join(cwd, '.scry')), [], 'Prepare must not commit a record')
      assert.equal(await production.recorderHasOpenTurn(join(cwd, '.scry')), true, 'Prepare must retain pending lifecycle')
      const preparedFiles = runtimeFiles(sessionRoot)
      const recoveryPrepared = await production.recoverManagedRecorderTurns(cwd, process.env, { provider: 'claude', sessionId: session })
      assert.deepEqual(recoveryPrepared, { recovered: 0, pending: 1 })
      assert.deepEqual(runtimeFiles(sessionRoot), preparedFiles, 'Recovery promoted a prepared handoff without archive commit')
      assert.equal((await production.readHealth(join(cwd, '.scry'))).pendingCount, 1)
      assert.deepEqual(await production.listRecords(join(cwd, '.scry')), [])
      const commitInput = { ...turnInput, recordId: prepared.recordId }
      await assert.rejects(production.commitManagedRecorderTurn({ ...commitInput, archiveFingerprint: production.stableHash({ unrelated: true }) }), /commit identity differs from prepared handoff/)
      assert.deepEqual(runtimeFiles(sessionRoot), preparedFiles, 'Rejected archive identity changed the handoff')
      assert.deepEqual(await production.listRecords(join(cwd, '.scry')), [])
      const committed = await production.commitManagedRecorderTurn(commitInput)
      assert.equal(committed.status, 'committed')
      const records = await production.listRecords(join(cwd, '.scry'))
      assert.equal(records.length, 1)
      const [record] = records
      assert.equal(record.recordId, prepared.recordId)
      assert.equal(record.status, result.status)
      assert.equal(record.workspace.root, cwd)
      assert.equal(record.provider.id, 'claude')
      assert.equal(record.sessionId, result.externalSessionId)
      assert.equal(record.providerTurnId, result.providerTurnId)
      for (const key of ['user', 'assistant', 'tools', 'skills', 'mcps', 'hooks', 'usage', 'files', 'diff', 'dangerousOperations', 'errors']) {
        assert.deepEqual(record[key], evidence[key], `Canonical ${key} evidence differs from aggregate`)
      }
      const repeated = await production.commitManagedRecorderTurn(commitInput)
      assert.equal(repeated.status, 'duplicate')
      assert.deepEqual(await production.listRecords(join(cwd, '.scry')), records, 'Idempotent commit altered canonical records')
      assert.equal(await production.recorderHasOpenTurn(join(cwd, '.scry')), false)
      assert.equal((await production.verifyStore(join(cwd, '.scry'))).ok, true)
      assert.equal((await production.readHealth(join(cwd, '.scry'))).pendingCount, 0)
      writeFileSync(join(root, 'recorder.json'), JSON.stringify({ result, timing, evidence, native, trace, committed, repeated, recoveryBeforePrepare, recoveryPrepared, identityRejected: true, archiveRejected: true }, null, 2))
      log(root, 'case-passed', { mode, status: result.status, records: 1, hookCount: hooks.length })
      return { mode, status: result.status, sessionId: result.externalSessionId, providerTurnId: result.providerTurnId, native: native.length, trace: trace.length, records: 1, sdkNetwork: denied, cliNetwork: 'EPERM' }
    } finally { clearTimeout(timer); lifetime.abort(new Error('Managed recorder fixture decision finished')) }
  }
  // SDK is imported only by the already-sandboxed process.
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  const work = async () => {
    query = sdk.query({ prompt, options: {
      cwd: join(root, 'workspace with spaces'),
      env: { ...process.env }, pathToClaudeCodeExecutable: fake,
      permissionMode: 'default', tools: [], mcpServers: {}, settingSources: [], includePartialMessages: true,
      hooks: { UserPromptSubmit: [{ hooks: [async input => { hook = input; return { continue: true } }] }] },
      spawnClaudeCodeProcess: options => {
        assert.equal(child, undefined, 'Unexpected second spawn')
        assert.equal(options.command, fake, 'SDK tried another executable')
        assert.equal(hash(fake), expectedHash)
        assert.equal(options.cwd, join(root, 'workspace with spaces'))
        assert.equal(options.env.HOME, join(root, 'home'))
        assert(!Object.keys(options.env).some(key => /^(ANTHROPIC_|AWS_|GOOGLE_|AZURE_)/.test(key)), 'Credential environment leaked')
        spawnRecord = { command: options.command, args: options.args, cwd: options.cwd, envKeys: Object.keys(options.env).sort() }
        log(root, 'sdk-spawn', spawnRecord)
        child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'] })
        childExit = observeExit(child)
        register(root, 'fake', child.pid, fake)
        let stderr = ''
        child.stderr.on('data', data => { stderr = (stderr + data).slice(-cap); writeFileSync(join(root, 'cli.stderr'), stderr) })
        return child
      }
    } })
    let ack = false, consumed = false, progressSeen
    const progress = new Promise(resolve => { progressSeen = resolve })
    const consuming = (async () => {
      for await (const message of query) {
        messages.push(message)
        log(root, 'sdk-message', { message })
        if (message.type === 'tool_progress') progressSeen()
      }
      consumed = true
    })()
    if (mode === 'interrupt') {
      // Keep consuming concurrently; pausing the iterator while awaiting ACK
      // would make a no-terminal assertion vacuous.
      await Promise.race([progress, consuming.then(() => assert.fail('SDK ended before interrupt activity'))])
      await query.interrupt()
      ack = true
      assert(!consumed && !messages.some(m => m.type === 'result'), 'ACK must not be terminal evidence')
      const beforeRelease = readFileSync(join(root, 'wire.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      assert(!beforeRelease.some(e => e.event === 'terminal'), 'Fake emitted terminal evidence before release')
      log(root, 'ack-before-result')
      writeFileSync(join(root, 'release.tmp'), 'release-after-ack\n')
      renameSync(join(root, 'release.tmp'), join(root, 'release'))
    }
    await consuming
    assert(!timedOut, 'Transport exceeded original case deadline')
    const exit = await childExit
    assert.deepEqual(exit, { code: 0, signal: null }, 'CLI must exit by EOF, never a signal')
    const wire = readFileSync(join(root, 'wire.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert(wire.some(e => e.event === 'stdin-eof' && e.ended), 'Clean stdin EOF missing')
    assert.equal(wire.find(e => e.event === 'cli-network')?.code, 'EPERM')
    const cliStart = wire.find(e => e.event === 'cli-start')
    assert.equal(realpathSync(cliStart.cwd), realpathSync(spawnRecord.cwd))
    assert.equal(realpathSync(cliStart.executable), realpathSync(node))
    const actualArgv = cliStart.argv.slice(2)
    assert.deepEqual(actualArgv, spawnRecord.args, 'CLI argv boundaries changed')
    for (const option of ['--output-format', '--input-format']) assert.equal(actualArgv[actualArgv.indexOf(option) + 1], 'stream-json')
    assert(actualArgv.includes('--verbose'))
    assert.equal(actualArgv[actualArgv.indexOf('--tools') + 1], '')
    assert.equal(actualArgv[actualArgv.indexOf('--permission-mode') + 1], 'default')
    assert(actualArgv.includes('--setting-sources='))
    assert(!actualArgv.some(a => a.includes('dangerously-skip') || a === 'bypassPermissions'))
    const result = messages.find(m => m.type === 'result')
    assert(result, 'No actual SDK terminal frame')
    assert.equal(result.session_id, session)
    if (mode === 'negative') {
      assert.equal(hook, undefined, 'Wrong hook ID invoked a registered callback')
      assert(wire.some(e => e.event === 'negative-rejected'))
      assert.equal(result.is_error, true)
    } else {
      assert.equal(hook.prompt_id, promptId)
      assert.equal(hook.session_id, session)
      assert.equal(hook.prompt, prompt)
      assert(messages.some(m => m.type === 'stream_event' && m.event.delta?.text === 'synthetic text'))
      assert(messages.some(m => m.type === 'stream_event' && m.event.delta?.thinking === 'synthetic thinking'))
      assert(messages.some(m => m.type === 'assistant' && m.message.content.some(b => b.type === 'tool_use' && b.id === 'fixture-tool-call')))
      assert(messages.some(m => m.type === 'tool_progress' && m.tool_use_id === 'fixture-tool-call'))
      assert(messages.some(m => m.type === 'user' && m.message.content.some(b => b.type === 'tool_result' && b.tool_use_id === 'fixture-tool-call')))
      assert.equal(result.is_error, mode === 'interrupt')
      assert.equal(ack, mode === 'interrupt')
    }
    log(root, 'case-passed', { mode, exit })
    return { mode, exit, messages: messages.length, sdkNetwork: denied, cliNetwork: 'EPERM' }
  }
  try {
    return await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => { timedOut = true; query?.close(); reject(new Error('SDK case exceeded 8000ms')) }, budgetMs)
    })])
  } finally { clearTimeout(timer); query?.close() }
}

async function runParent() {
  assert.equal(process.platform, 'darwin', 'Unavailable: OS network-denied fixture currently requires macOS sandbox-exec')
  assert(!node.includes(' '), 'Unavailable: fixture shebang requires a Node path without spaces')
  const recorderEvidence = assertRecorderIntegrity()
  const root = mkdtempSync(join(tmpdir(), 'scry-claude-wire-'))
  const sdkEntry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')
  const runnerEntry = join(root, 'runner-entry.ts')
  const runnerBundle = join(root, 'runner-bundle.mjs')
  writeFileSync(runnerEntry, [
    `export { runAgent } from ${JSON.stringify(join(dirname(script), '../src/main/agent-runner.ts'))}`,
    `export { createClaudeAdapter } from ${JSON.stringify(join(dirname(script), '../src/main/providers/claude.ts'))}`,
    `export { WorkflowLiveObservationTracker } from ${JSON.stringify(join(dirname(script), '../src/main/workflow-live-observation.ts'))}`,
    `export { aggregateTurnEvidence } from ${JSON.stringify(join(dirname(script), '../src/core/turn-recorder/aggregate.ts'))}`,
    `export { commitManagedRecorderTurn, prepareManagedRecorderTurn, recoverManagedRecorderTurns } from ${JSON.stringify(join(dirname(script), '../src/core/turn-recorder/managed.ts'))}`,
    `export { initWorkspace } from ${JSON.stringify(join(dirname(script), '../src/cli/workspace-init.ts'))}`,
    `export { resolveRecorderEnablement } from ${JSON.stringify(join(dirname(script), '../src/core/turn-recorder/config.ts'))}`,
    `export { recorderHasOpenTurn, recorderSessionRoot } from ${JSON.stringify(join(dirname(script), '../src/core/turn-recorder/runtime-state.ts'))}`,
    `export { listRecords, stableHash, verifyStore, readHealth } from ${JSON.stringify(join(dirname(script), '../src/core/turn-recorder/store.ts'))}`
  ].join('\n') + '\n')
  let bundleResult
  try { bundleResult = await build({
    entryPoints: [runnerEntry], outfile: runnerBundle, bundle: true, platform: 'node', format: 'esm', target: 'node20',
    external: [sdkEntry], alias: { '@anthropic-ai/claude-agent-sdk': sdkEntry }, metafile: true, logLevel: 'silent',
    banner: { js: "import { createRequire as __fixtureCreateRequire } from 'node:module'; const require = __fixtureCreateRequire(import.meta.url);" }
  }) } finally { stopBuild() }
  const outputs = Object.values(bundleResult.metafile.outputs)
  assert.equal(outputs.length, 1)
  const [output] = outputs
  assert.equal(realpathSync(output.entryPoint), realpathSync(runnerEntry), 'Production runner entry mismatch')
  const externalImports = output.imports.filter(item => item.external).map(item => item.path)
  assert(externalImports.includes(sdkEntry), 'SDK must remain external to the production bundle')
  for (const item of externalImports) {
    const builtin = item.startsWith('node:') ? item.slice(5) : item
    assert(item.startsWith('node:') || builtinModules.includes(builtin) || realpathSync(item) === realpathSync(sdkEntry), `Unexpected bundle external: ${item}`)
  }
  const inputHashes = Object.fromEntries(Object.keys(bundleResult.metafile.inputs).map(input => {
    const file = input.startsWith('/') ? input : join(process.cwd(), input)
    return [input, hash(file)]
  }))
  const bundleEvidence = { metafileInputs: inputHashes, bundleHash: hash(runnerBundle), sdkEntry, sdkHash: hash(sdkEntry), externalImports }
  writeFileSync(join(root, 'bundle.json'), JSON.stringify(bundleEvidence, null, 2))
  writeFileSync(join(root, 'scope.json'), JSON.stringify({ node, nodeVersion: process.version, profile, scriptHash: hash(script),
    cliSourceHash: hash(join(dirname(script), 'fixtures/claude-sdk-transport-cli.cjs')),
    sdkEntry, sdkHash: hash(sdkEntry), sdkVersion: JSON.parse(readFileSync(join(dirname(sdkEntry), 'package.json'), 'utf8')).version,
    bundle: bundleEvidence, recorder: recorderEvidence, sdk: 'real query, no mocks', cases, synthetic: true }))
  console.log('Fixture evidence: ' + root)
  const server = createServer(socket => socket.end())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  try {
    assert.equal(await networkProbe(port), 'CONNECTED', 'Loopback positive control failed')
    const reports = []
    for (const mode of cases) {
      const dir = join(root, mode)
      mkdirSync(dir, { mode: 0o700 })
      for (const name of ['home', 'tmp', 'workspace with spaces']) mkdirSync(join(dir, name), { mode: 0o700 })
      writeFileSync(join(dir, 'fake claude'), `#!${node}\n` + readFileSync(join(dirname(script), 'fixtures/claude-sdk-transport-cli.cjs'), 'utf8'), { mode: 0o700 })
      const expectedFakeHash = hash(join(dir, 'fake claude'))
      const env = { HOME: join(dir, 'home'), TMPDIR: join(dir, 'tmp'), PATH: `${dirname(node)}:/usr/bin:/bin`, LANG: 'C',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
        SCRY_CLAUDE_PATH: join(dir, 'fake claude'), SCRY_CLI_PATH: privateRecorderCli,
        SCRY_WIRE_RECORDER_ENTRY_HASH: privateRecorderCliHash,
        SCRY_WIRE_CASE: dir, SCRY_WIRE_MODE: mode, SCRY_WIRE_PORT: String(port),
        ...(mode.startsWith('runner-') || mode.startsWith('recorder-') ? { SCRY_RUNNER_BUNDLE: runnerBundle } : {}) }
      let rejectRegistration
      const registrationFailure = new Promise((_, reject) => { rejectRegistration = reject })
      let stdout = '', stderr = '', timer, buffer = '', wireWatch
      try {
        wireWatch = mode.startsWith('runner-') || mode.startsWith('recorder-') ? watchWire(dir, event => {
          if (event.event !== 'cli-start' || existsSync(join(dir, 'fake-registered'))) return
          assert.equal(typeof event.pid, 'number')
          assert(Array.isArray(event.argv))
          assert.equal(realpathSync(event.executable), realpathSync(node))
          assert.equal(realpathSync(event.argv[0]), realpathSync(node))
          assert.equal(realpathSync(event.argv[1]), realpathSync(join(dir, 'fake claude')))
          assert.equal(realpathSync(event.cwd), realpathSync(join(dir, 'workspace with spaces')))
          assert.equal(hash(join(dir, 'fake claude')), expectedFakeHash)
          register(dir, 'fake', event.pid, join(dir, 'fake claude'))
          writeFileSync(join(dir, 'fake-registered'), 'registered\n')
        }, rejectRegistration) : undefined
        const child = spawn(sandbox, ['-p', profile, node, script, '--harness', dir, mode, String(port)], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
        const done = observeExit(child)
        if (child.pid === undefined) await done // surface pre-dispatch spawn errors
        register(dir, 'harness', child.pid, script)
        child.stdout.on('data', data => {
          stdout = (stdout + data).slice(-cap)
          buffer += data
          try {
            assert(buffer.length < cap, 'Registration frame exceeded limit')
            let newline
            while ((newline = buffer.indexOf('\n')) !== -1) {
              const packet = JSON.parse(buffer.slice(0, newline))
              buffer = buffer.slice(newline + 1)
              assert.equal(packet.event, 'register')
              const record = packet.identity
              assert.equal(record.kind, 'fake')
              assert.equal(record.root, dir)
              assert.equal(record.node, node)
              assert.equal(record.uid, process.getuid())
              assert.equal(record.file, record.kind === 'harness' ? script : join(dir, 'fake claude'))
              assert.equal(hash(record.file), record.hash)
              appendFileSync(join(dir, 'registered.jsonl'), JSON.stringify({ ...record, birth: birth(record.pid) }) + '\n')
              writeFileSync(join(dir, 'fake-registered'), 'registered\n')
            }
          } catch (error) { rejectRegistration(error) }
        })
        child.stderr.on('data', data => { stderr = (stderr + data).slice(-cap) })
        const exit = await Promise.race([done, registrationFailure, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Sandbox harness exceeded 8000ms')), budgetMs)
        })])
        writeFileSync(join(dir, 'stdout.log'), stdout)
        writeFileSync(join(dir, 'stderr.log'), stderr)
        assert.deepEqual(exit, { code: 0, signal: null }, `Sandbox harness failed: ${stderr}`)
        if (wireWatch) {
          wireWatch.close()
          assert(existsSync(join(dir, 'fake-registered')), 'Runner fake identity was not registered from cli-start evidence')
        }
        reports.push(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')))
      } catch (error) {
        writeFileSync(join(dir, 'stdout.log'), stdout)
        writeFileSync(join(dir, 'stderr.log'), stderr)
        writeFileSync(join(dir, 'failure.json'), JSON.stringify({ error: error.stack }, null, 2))
        try { stopRegistered(dir) } catch (cleanupError) {
          writeFileSync(join(dir, 'cleanup-error.json'), JSON.stringify({ error: cleanupError.stack }, null, 2))
          throw new AggregateError([error, cleanupError], 'Fixture failed; cleanup also refused or failed')
        }
        throw error
      } finally { clearTimeout(timer); wireWatch?.close() }
    }
    const observed = JSON.parse(readFileSync(join(root, 'runner-complete/runner.json'), 'utf8'))
    const plain = JSON.parse(readFileSync(join(root, 'runner-plain/runner.json'), 'utf8'))
    // Remove only per-case transport identity and local clock fields. Preserve
    // model/message/tool IDs, tool metadata, usage and the entire response body.
    const traceContent = evidence => evidence.trace.map(({ id, ts, runId, ...content }) => content)
    const nativeContent = evidence => evidence.native.map(({ type, payload }) => {
      const { uuid, ...content } = payload
      if (type === 'system' && content.subtype === 'init') content.cwd = '<case-workspace>'
      return { type, payload: content }
    })
    assert.deepEqual(traceContent(observed), traceContent(plain), 'Observations altered trace content')
    assert.deepEqual(nativeContent(observed), nativeContent(plain), 'Observations altered native recording')
    writeFileSync(join(root, 'noninterference.json'), JSON.stringify({ trace: true, native: true, excluded: ['trace.id', 'trace.ts', 'trace.runId', 'native.uuid', 'native.init.cwd'] }))
    writeFileSync(join(root, 'result.json'), JSON.stringify({ ok: true, reports }, null, 2))
    console.log(JSON.stringify({ ok: true, root, reports }))
  } finally { await new Promise(resolve => server.close(resolve)) }
}

if (process.argv[2] === '--harness') {
  const [, , , root, mode, port] = process.argv
  runHarness(root, mode, Number(port)).then(report => writeFileSync(join(root, 'result.json'), JSON.stringify(report)), error => {
    log(root, 'case-failed', { message: error.stack })
    process.stderr.write(error.stack + '\n')
    process.exitCode = 1
  })
} else {
  runParent().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1 })
}
