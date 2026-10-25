import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkflowControlFrame } from '../../src/shared/workflow'
import { WorkflowDispatch, WorkflowRunner, type WorkflowProviderExecutionRequest } from '../../src/main/workflow-runner'
import { FileWorkflowStore, type WorkflowFrameValueCheckpoint, type WorkflowStoreRecord } from '../../src/main/workflow-store'
import { runNativeRevision } from './workflow-native-recovery-process'

const [root, mode] = process.argv.slice(2)
const nativeProtocol = mode === 'native-revision-crash' || mode === 'native-revision-resume'
const traceEnabled = process.env.SCRY_WORKFLOW_RECOVERY_TRACE === '1'
const traceStarted = performance.now()
let traceCount = 0
function trace(event: string, detail: Record<string, string | number | null | undefined> = {}) {
  if (!traceEnabled) return
  traceCount++
  if (traceCount > 129) return
  const payload = traceCount === 129 ? { event: 'trace_truncated', limit: 128 } : { event, ...detail }
  process.stderr.write(JSON.stringify({ ...payload, ms: Math.round(performance.now() - traceStarted) }) + '\n')
}
trace('controller_boot')
const children = new Set<Promise<unknown>>()
let cleanup: (() => Promise<boolean>) | undefined
process.on('message', message => {
  // Cleanup uses the owned IPC channel, not a stale PID or a broad signal.
  if (message === 'terminate') {
    trace('ipc_termination')
    void (async () => {
      if (cleanup && !await cleanup()) { trace('cleanup_unconfirmed'); return }
      await Promise.allSettled([...children])
      process.exit(75)
    })().catch(error => trace('cleanup_error', { error: String(error).slice(0, 512) }))
  }
})
class Store extends FileWorkflowStore {
  override async save(record: WorkflowStoreRecord) {
    trace('record_persistence_begin', { state: record.progress.state })
    await super.save(record)
    trace('record_persistence_end', { state: record.progress.state })
    if (mode === 'intent' && record.intents.length && !record.outcomes.length) process.exit(74)
  }
  override async saveFrame(frame: Omit<WorkflowControlFrame, 'revision'>, revision: number) {
    trace('frame_persistence_begin', { node: frame.nodeId, phase: frame.phase, cursor: frame.cursor })
    if (frame.nodeId === 'root' && ((mode === 'crash' && frame.cursor === 1) || (mode === 'crash-two' && frame.cursor === 2) || (mode === 'crash-control' && frame.cursor === 4) || (mode === 'retry-crash' && frame.cursor === 2))) process.exit(73)
    if (mode === 'live' && frame.nodeId === 'root' && frame.cursor === 1) {
      process.send!({ type: 'checkpoint', pid: process.pid })
      await new Promise<void>(resolve => process.once('message', message => { if (message === 'continue') resolve() }))
    }
    const result = await super.saveFrame(frame, revision)
    trace('frame_persistence_end', { node: frame.nodeId, phase: frame.phase, cursor: frame.cursor })
    if (mode === 'reenter' && frame.nodeId === 'first' && frame.phase === 'entered') process.exit(77)
    if (mode === 'loop' && frame.loop?.stage === 'ready' && frame.loop.iteration === 2) process.exit(76)
    return result
  }
  override async saveFrameWithValue(frame: Omit<WorkflowControlFrame, 'revision'>, revision: number, checkpoint: WorkflowFrameValueCheckpoint) {
    if (mode === 'native-revision-crash' && frame.nodeId === 'terminal-parent' && frame.phase === 'completed') {
      await writeFile(join(root, 'native-checkpoint.json'), JSON.stringify({ pid: process.pid, frameId: frame.frameId }), { flush: true })
      trace('native_parent_checkpoint_exit')
      process.exit(73)
    }
    return super.saveFrameWithValue(frame, revision, checkpoint)
  }
}
// A real local child process, deliberately not a Provider account or SDK. Its
// effect ledger proves what ran; close(0) is separate from controller exit.
const cli = `const fs = require('node:fs');
const [path, input] = process.argv.slice(1); const request = JSON.parse(input);
const previous = fs.existsSync(path) ? fs.readFileSync(path, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : [];
const node = request.taskId.split(':').at(-1);
const round = previous.filter(row => row.node === node).length + 1;
const finish = network => {
  fs.appendFileSync(path, JSON.stringify({...request, node, pid:process.pid, cwd:process.cwd(), network})+'\\n');
  const output = node === 'revise' ? JSON.stringify({candidate:'candidate-'+round, done:false, feedback:'repeat', improved:false}) : node+'-result';
  process.stdout.write(request.fixtureProtocol ? JSON.stringify({actualModel:'local-cli-fixture',output}) : output);
};
if (request.fixtureProtocol && process.platform === 'darwin') {
  const server = require('node:net').createServer();
  server.once('error', error => { if (error.code !== 'EPERM') throw error; finish(error.code); });
  server.listen(0, '127.0.0.1', () => server.close(() => { throw new Error('CLI network unexpectedly allowed'); }));
} else finish('not_requested');`
function execute(request: WorkflowProviderExecutionRequest) {
  if (mode === 'retry-refusal' && request.taskId.endsWith(':second')) return {
    result: Promise.reject(new WorkflowDispatch().rejected(new Error('fixture pre-Provider refusal'))), stop: () => true
  }
  trace('native_child_spawn_request')
  const child = spawn(process.execPath, ['-e', cli, join(root, 'effects.jsonl'), JSON.stringify({ taskId: request.taskId, attemptId: request.attemptId, prompt: request.prompt, fixtureProtocol: nativeProtocol })], { cwd: request.cwd, env: { HOME: root, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.once('spawn', () => trace('native_child_spawn', { pid: child.pid! }))
  let output = '', error = ''
  child.stdout.setEncoding('utf8').on('data', text => { output += text })
  child.stderr.setEncoding('utf8').on('data', text => { error += text })
  const result = new Promise<{ runId: string; status: 'completed' | 'failed'; settled: true; output: string; actualModel?: string; error?: string }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => {
      trace('native_child_close', { code, signal: child.signalCode })
      const payload: { output: string; actualModel?: string } = nativeProtocol && code === 0 ? JSON.parse(output) : { output }
      resolve({ runId: 'fixture-' + child.pid, status: code === 0 ? 'completed' : 'failed', settled: true, ...payload, ...(error ? { error } : {}) })
    })
  })
  children.add(result)
  void result.finally(() => children.delete(result))
  return { result, settled: result.then(() => undefined), stop: () => child.kill('SIGTERM') }
}
try {
  const store = new Store(root)
  let result: unknown
  if (mode === 'native-revision-crash' || mode === 'native-revision-resume') {
    result = await runNativeRevision(root, mode, store, execute, current => { cleanup = current })
  } else {
    const preview = JSON.parse(await readFile(join(root, 'preview.json'), 'utf8'))
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    const runner = new WorkflowRunner({ store, execute })
    runner.approve(preview, approval)
    const retry = async () => runner.retry(preview, approval, JSON.parse(await readFile(join(root, 'retry-target.json'), 'utf8')), 'process-retry')
    result = mode === 'retry-crash' ? await retry()
      : mode === 'resume' || mode === 'reenter' ? await runner.resume(preview, approval, 'process-' + mode) : await runner.start(preview, approval)
    if (mode === 'retry-refusal') {
      const record = (await store.load(preview.workflowId))!, outcome = record.outcomes.find(value => value.nodeId === 'second')!
      await writeFile(join(root, 'retry-target.json'), JSON.stringify({ taskId: outcome.taskId, attemptId: outcome.attemptId, expectedRevision: record.progress.revision! }))
    }
    if (mode === 'resume' && (await store.load(preview.workflowId))!.execution!.segments.some(segment => segment.commandId === 'process-retry')) await retry()
  }
  await writeFile(join(root, 'result.json'), JSON.stringify({ pid: process.pid, result }))
  trace('top_level_completion', { outcome: 'returned' })
} catch (error) {
  await writeFile(join(root, 'result.json'), JSON.stringify({ pid: process.pid, error: error instanceof Error ? error.message : String(error) }))
  trace('top_level_completion', { outcome: 'error' })
  process.exitCode = 2
} finally { if (process.connected) process.disconnect() }
