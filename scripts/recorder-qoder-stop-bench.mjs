// Isolated comparison of persisted records, with a controlled clock for the 180 s grace period.
// node scripts/recorder-qoder-stop-bench.mjs <baseline dist> <candidate dist>
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const RealDate = Date
const origin = Date.now()
let now = origin
class FixtureDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [now])) }
  static now() { return now }
}

const [baseline, candidate] = process.argv.slice(2)
assert(baseline && candidate, 'expected baseline and candidate recorder dist directories')
for (const [build, dist] of [['baseline', baseline], ['candidate', candidate]]) {
  const load = name => import(pathToFileURL(resolve(dist, 'core/turn-recorder', `${name}.js`)))
  const { handleRecorderHook, recoverRecorder } = await load('recorder')
  const { listRecords } = await load('store')
  for (const scenario of ['short_answer', 'superseded_late_reply']) {
    const workspace = await mkdtemp(join(tmpdir(), 'scry-qoder-stop-bench-'))
    const dataRoot = join(workspace, '.scry')
    const transcript = join(workspace, 'fixture.jsonl')
    const env = { SCRY_AUTO_UPDATE: '0' }
    const stamp = () => new Date().toISOString()
    const sessionId = 'synthetic-qoder'
    const row = value => appendFile(transcript, JSON.stringify({ sessionId, timestamp: stamp(), ...value }) + '\n')
    const user = (id, parentUuid) => row({ type: 'user', promptId: id, uuid: id, parentUuid,
      message: { role: 'user', content: `synthetic ${id}` } })
    const reply = () => row({ type: 'assistant', uuid: 'reply', parentUuid: 'target',
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'synthetic answer' }] } })
    const hook = (event, payload = {}) => handleRecorderHook({ provider: 'qoder', event, workspace, env, deferDelivery: true,
      payload: { session_id: sessionId, transcript_path: transcript, ...payload } })
    const start = id => hook('UserPromptSubmit', { promptId: id, prompt: `synthetic ${id}`, timestamp: stamp() })
    const sealed = async () => (await listRecords(dataRoot)).some(record => record.providerTurnId === 'target' && record.status === 'completed')
    try {
      now = origin
      globalThis.Date = FixtureDate
      await writeFile(join(workspace, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, enabled: true,
        workspaceId: 'qoder-stop-bench', dataDir: '.scry', capture: { diff: false, toolOutput: 'summary' } }))
      if (scenario === 'superseded_late_reply') {
        await user('old', null)
        await start('old')
        now += 2_000
      }
      await user('target', scenario === 'short_answer' ? null : 'old')
      await start('target')
      now += 2_000
      if (scenario === 'short_answer') await reply()
      else await hook('PostToolUse', { promptId: 'target', tool_name: 'Read', tool_use_id: 'fixture' })
      const arrivedAt = now
      const startWall = performance.now()
      const hookStatus = (await hook('Stop')).status
      let committedAt = await sealed() ? 0 : undefined
      for (let elapsed = 1_000; committedAt === undefined && elapsed <= 181_000; elapsed += 1_000) {
        now = arrivedAt + elapsed
        if (scenario === 'superseded_late_reply' && elapsed === 2_000) await reply()
        await recoverRecorder(workspace, env, undefined, undefined, { incremental: true })
        if (await sealed()) committedAt = elapsed
      }
      assert(committedAt !== undefined, `${build} ${scenario} did not commit`)
      console.log(JSON.stringify({ build, scenario, hookStatus, stopToCommitFixtureMs: committedAt,
        runnerElapsedMs: Math.round(performance.now() - startWall) }))
    } finally {
      globalThis.Date = RealDate
      await rm(workspace, { recursive: true, force: true })
    }
  }
}
