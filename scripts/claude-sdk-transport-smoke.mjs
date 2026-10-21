#!/usr/bin/env node
// macOS-only, OS-network-denied codec fixture. No real CLI/account/tool/recorder execution.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, connect } from 'node:net'
import { once } from 'node:events'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, renameSync, existsSync, realpathSync, watch as watchFile } from 'node:fs'
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
const session = '00000000-0000-4000-8000-000000000001'
const promptId = '00000000-0000-4000-8000-000000000002'
const prompt = 'synthetic prompt with spaces\nand newline'
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
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
  const root = mkdtempSync(join(tmpdir(), 'scry-claude-wire-'))
  const sdkEntry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')
  const runnerEntry = join(root, 'runner-entry.ts')
  const runnerBundle = join(root, 'runner-bundle.mjs')
  writeFileSync(runnerEntry, [
    `export { runAgent } from ${JSON.stringify(join(dirname(script), '../src/main/agent-runner.ts'))}`,
    `export { WorkflowLiveObservationTracker } from ${JSON.stringify(join(dirname(script), '../src/main/workflow-live-observation.ts'))}`
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
    bundle: bundleEvidence, sdk: 'real query, no mocks', cases: ['complete', 'interrupt', 'negative', 'runner-complete', 'runner-interrupt', 'runner-plain'], synthetic: true }))
  console.log('Fixture evidence: ' + root)
  const server = createServer(socket => socket.end())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  try {
    assert.equal(await networkProbe(port), 'CONNECTED', 'Loopback positive control failed')
    const reports = []
    for (const mode of ['complete', 'interrupt', 'negative', 'runner-complete', 'runner-interrupt', 'runner-plain']) {
      const dir = join(root, mode)
      mkdirSync(dir, { mode: 0o700 })
      for (const name of ['home', 'tmp', 'workspace with spaces']) mkdirSync(join(dir, name), { mode: 0o700 })
      writeFileSync(join(dir, 'fake claude'), `#!${node}\n` + readFileSync(join(dirname(script), 'fixtures/claude-sdk-transport-cli.cjs'), 'utf8'), { mode: 0o700 })
      const expectedFakeHash = hash(join(dir, 'fake claude'))
      const env = { HOME: join(dir, 'home'), TMPDIR: join(dir, 'tmp'), PATH: '/usr/bin:/bin', LANG: 'C',
        SCRY_WIRE_CASE: dir, SCRY_WIRE_MODE: mode, SCRY_WIRE_PORT: String(port),
        ...(mode.startsWith('runner-') ? { SCRY_RUNNER_BUNDLE: runnerBundle } : {}) }
      let rejectRegistration
      const registrationFailure = new Promise((_, reject) => { rejectRegistration = reject })
      let stdout = '', stderr = '', timer, buffer = '', wireWatch
      try {
        wireWatch = mode.startsWith('runner-') ? watchWire(dir, event => {
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
