#!/usr/bin/env node
// macOS-only, OS-network-denied codec fixture. No real CLI/account/tool/recorder execution.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, connect } from 'node:net'
import { once } from 'node:events'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, renameSync, existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'

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
  writeFileSync(join(root, 'scope.json'), JSON.stringify({ node, profile, scriptHash: hash(script),
    cliSourceHash: hash(join(dirname(script), 'fixtures/claude-sdk-transport-cli.cjs')),
    sdkEntry, sdkHash: hash(sdkEntry), sdkVersion: JSON.parse(readFileSync(join(dirname(sdkEntry), 'package.json'), 'utf8')).version,
    sdk: 'real query, no mocks', cases: ['complete', 'interrupt', 'negative'], synthetic: true }))
  console.log('Fixture evidence: ' + root)
  const server = createServer(socket => socket.end())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  try {
    assert.equal(await networkProbe(port), 'CONNECTED', 'Loopback positive control failed')
    const reports = []
    for (const mode of ['complete', 'interrupt', 'negative']) {
      const dir = join(root, mode)
      mkdirSync(dir, { mode: 0o700 })
      for (const name of ['home', 'tmp', 'workspace with spaces']) mkdirSync(join(dir, name), { mode: 0o700 })
      writeFileSync(join(dir, 'fake claude'), `#!${node}\n` + readFileSync(join(dirname(script), 'fixtures/claude-sdk-transport-cli.cjs'), 'utf8'), { mode: 0o700 })
      const env = { HOME: join(dir, 'home'), TMPDIR: join(dir, 'tmp'), PATH: '/usr/bin:/bin', LANG: 'C',
        SCRY_WIRE_CASE: dir, SCRY_WIRE_MODE: mode, SCRY_WIRE_PORT: String(port) }
      const child = spawn(sandbox, ['-p', profile, node, script, '--harness', dir, mode, String(port)], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
      const done = observeExit(child)
      if (child.pid === undefined) await done // surface pre-dispatch spawn errors
      register(dir, 'harness', child.pid, script)
      let stdout = '', stderr = '', timer, buffer = '', rejectRegistration
      const registrationFailure = new Promise((_, reject) => { rejectRegistration = reject })
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
          }
        } catch (error) { rejectRegistration(error) }
      })
      child.stderr.on('data', data => { stderr = (stderr + data).slice(-cap) })
      try {
        const exit = await Promise.race([done, registrationFailure, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Sandbox harness exceeded 8000ms')), budgetMs)
        })])
        writeFileSync(join(dir, 'stdout.log'), stdout)
        writeFileSync(join(dir, 'stderr.log'), stderr)
        assert.deepEqual(exit, { code: 0, signal: null }, `Sandbox harness failed: ${stderr}`)
        reports.push(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')))
      } catch (error) {
        writeFileSync(join(dir, 'stdout.log'), stdout)
        writeFileSync(join(dir, 'stderr.log'), stderr)
        stopRegistered(dir)
        throw error
      } finally { clearTimeout(timer) }
    }
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
