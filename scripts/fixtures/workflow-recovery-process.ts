import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkflowControlFrame } from '../../src/shared/workflow'
import { WorkflowRunner, type WorkflowProviderExecutionRequest } from '../../src/main/workflow-runner'
import { FileWorkflowStore, type WorkflowStoreRecord } from '../../src/main/workflow-store'

const [root, mode] = process.argv.slice(2)
const children = new Set<Promise<unknown>>()
process.on('message', message => {
  // Cleanup uses the owned IPC channel, not a stale PID or a broad signal.
  if (message === 'terminate') void Promise.allSettled([...children]).then(() => process.exit(75))
})
class Store extends FileWorkflowStore {
  override async save(record: WorkflowStoreRecord) {
    await super.save(record)
    if (mode === 'intent' && record.intents.length && !record.outcomes.length) process.exit(74)
  }
  override async saveFrame(frame: Omit<WorkflowControlFrame, 'revision'>, revision: number) {
    if (frame.nodeId === 'root' && ((mode === 'crash' && frame.cursor === 1) || (mode === 'crash-two' && frame.cursor === 2) || (mode === 'crash-control' && frame.cursor === 4))) process.exit(73)
    if (mode === 'live' && frame.nodeId === 'root' && frame.cursor === 1) {
      process.send!({ type: 'checkpoint', pid: process.pid })
      await new Promise<void>(resolve => process.once('message', message => { if (message === 'continue') resolve() }))
    }
    const result = await super.saveFrame(frame, revision)
    if (mode === 'reenter' && frame.nodeId === 'first' && frame.phase === 'entered') process.exit(77)
    if (mode === 'loop' && frame.loop?.stage === 'ready' && frame.loop.iteration === 2) process.exit(76)
    return result
  }
}
// A real local child process, deliberately not a Provider account or SDK. Its
// effect ledger proves what ran; close(0) is separate from controller exit.
const cli = `const fs = require('node:fs');
const [path, input] = process.argv.slice(1); const request = JSON.parse(input);
const previous = fs.existsSync(path) ? fs.readFileSync(path, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : [];
const node = request.taskId.split(':').at(-1);
const round = previous.filter(row => row.node === node).length + 1;
fs.appendFileSync(path, JSON.stringify({...request, node, pid:process.pid})+'\\n');
process.stdout.write(node === 'revise' ? JSON.stringify({candidate:'candidate-'+round, done:false, feedback:'repeat', improved:false}) : node+'-result');`
function execute(request: WorkflowProviderExecutionRequest) {
  const child = spawn(process.execPath, ['-e', cli, join(root, 'effects.jsonl'), JSON.stringify({ taskId: request.taskId, attemptId: request.attemptId, prompt: request.prompt })], { env: { HOME: root, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', error = ''
  child.stdout.setEncoding('utf8').on('data', text => { output += text })
  child.stderr.setEncoding('utf8').on('data', text => { error += text })
  const result = new Promise<{ runId: string; status: 'completed' | 'failed'; settled: true; output: string; error?: string }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => resolve({ runId: 'fixture-' + child.pid, status: code === 0 ? 'completed' : 'failed', settled: true, output, ...(error ? { error } : {}) }))
  })
  children.add(result)
  void result.finally(() => children.delete(result))
  return { result, settled: result.then(() => undefined), stop: () => child.kill('SIGTERM') }
}
try {
  const preview = JSON.parse(await readFile(join(root, 'preview.json'), 'utf8'))
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  const runner = new WorkflowRunner({ store: new Store(root), execute })
  runner.approve(preview, approval)
  const result = mode === 'resume' || mode === 'reenter' ? await runner.resume(preview, approval, 'process-' + mode) : await runner.start(preview, approval)
  await writeFile(join(root, 'result.json'), JSON.stringify({ pid: process.pid, result }))
} catch (error) {
  await writeFile(join(root, 'result.json'), JSON.stringify({ pid: process.pid, error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 2
} finally { if (process.connected) process.disconnect() }
