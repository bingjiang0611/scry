// Isolated comparison of persisted records, with a controlled clock for the 180 s grace period.
// node scripts/recorder-qoder-stop-bench.mjs <baseline dist> <candidate dist> [--wall]
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const RealDate = Date
const origin = Date.now()
let now = origin
class FixtureDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [now])) }
  static now() { return now }
}

const [baseline, candidate, mode] = process.argv.slice(2)
const realClock = mode === '--wall'
assert(baseline && candidate, 'expected baseline and candidate recorder dist directories')
for (const [build, dist] of realClock ? [['candidate', candidate]] : [['baseline', baseline], ['candidate', candidate]]) {
  const load = name => import(pathToFileURL(resolve(dist, 'core/turn-recorder', `${name}.js`)))
  const { handleRecorderHook, recoverRecorder } = await load('recorder')
  const { listRecords } = await load('store')
  const { listenRecorderDaemon } = await load('daemon-listen')
  for (const scenario of ['short_answer', 'interrupted_resend']) {
    const workspace = await mkdtemp(join(tmpdir(), 'scry-qoder-stop-bench-'))
    const dataRoot = join(workspace, '.scry')
    const transcript = join(workspace, 'fixture.jsonl')
    const env = { SCRY_AUTO_UPDATE: '0' }
    const stamp = () => new Date().toISOString()
    const sessionId = 'synthetic-qoder'
    const row = value => appendFile(transcript, JSON.stringify({ sessionId, timestamp: stamp(), ...value }) + '\n')
    const user = (id, parentUuid) => row({ type: 'user', promptId: id, requestSetId: `request-${id}`, uuid: id, parentUuid,
      message: { role: 'user', content: `synthetic ${id}` } })
    const reply = id => row({ type: 'assistant', uuid: `reply-${id}`, parentUuid: id,
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'synthetic answer' }] } })
    const hook = (event, payload = {}) => handleRecorderHook({ provider: 'qoder', event, workspace, env, deferDelivery: true,
      payload: { session_id: sessionId, transcript_path: transcript, cwd: workspace, hook_event_name: event,
        workspace_dirs: [workspace], permission_mode: 'default', ...payload } })
    const start = id => hook('UserPromptSubmit', { request_set_id: `request-${id}`, prompt: `synthetic ${id}` })
    const stop = id => hook('Stop', { parent_request_set_id: `request-${id}`, stop_hook_active: false,
      last_assistant_message: 'synthetic answer', model: 'synthetic', parent_business_info: {} })
    const sealed = async () => {
      const record = (await listRecords(dataRoot)).find(r => r.turnIndex === (scenario === 'short_answer' ? 1 : 2))
      if (!record) return false
      assert.equal(record.status, 'completed')
      assert.equal(record.providerTurnId, 'target')
      assert.equal(record.assistant.value?.text, 'synthetic answer')
      assert.equal(record.transcript?.status, 'available')
      return true
    }
    let daemon
    try {
      now = origin
      if (!realClock) globalThis.Date = FixtureDate
      await writeFile(join(workspace, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, enabled: true,
        workspaceId: 'qoder-stop-bench', dataDir: '.scry', capture: { diff: false, toolOutput: 'full' } }))
      let oldStopStatus
      if (scenario === 'interrupted_resend') {
        await user('old', null)
        await start('old')
        await reply('old')
        now += 2_000
      }
      await start('target')
      now += 2_000
      if (scenario === 'interrupted_resend') {
        await user('target', 'reply-old')
        await hook('PostToolUse', { tool_name: 'Read', tool_use_id: 'fixture' })
        await reply('target')
        oldStopStatus = (await stop('old')).status
        assert(!await sealed(), `${build} sealed the replacement on an old Stop`)
        now += 1_000
      }
      const arrivedAt = now
      const startWall = performance.now()
      const hookStatus = (await stop('target')).status
      const hookWallMs = Math.round(performance.now() - startWall)
      if (realClock) {
        const pollAtMs = []
        const millis = () => Math.round(performance.now() - startWall)
        let changedAtMs
        let committed = await sealed()
        if (!committed) {
          daemon = await listenRecorderDaemon({ workspace, env, recoveryProbe: () => { pollAtMs.push(millis()) } })
          if (scenario === 'short_answer') {
            await delay(1_000)
            await user('target', null)
            await reply('target')
            changedAtMs = millis()
          }
          while (!committed && millis() < 25_000) {
            committed = await sealed()
            if (!committed) await delay(20)
          }
        }
        assert(committed, `${build} ${scenario} did not commit`)
        console.log(JSON.stringify({ build, scenario, oldStopStatus, hookStatus, hookWallMs, stopToCommitWallMs: millis(), changedAtMs, pollAtMs }))
        continue
      }
      let committedAt = await sealed() ? 0 : undefined
      for (let elapsed = 1_000; committedAt === undefined && elapsed <= 181_000; elapsed += 1_000) {
        now = arrivedAt + elapsed
        if (scenario === 'short_answer' && elapsed === 1_000) {
          await user('target', null)
          await reply('target')
        }
        await recoverRecorder(workspace, env, undefined, undefined, { incremental: true })
        if (await sealed()) committedAt = elapsed
      }
      assert(committedAt !== undefined, `${build} ${scenario} did not commit`)
      console.log(JSON.stringify({ build, scenario, oldStopStatus, hookStatus, hookWallMs, stopToCommitFixtureMs: committedAt }))
    } finally {
      globalThis.Date = RealDate
      await daemon?.close()
      await rm(workspace, { recursive: true, force: true })
    }
  }
}
