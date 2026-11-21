import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sessionId = '01a1338c-3d8b-775b-8645-fd964faa29a3'
const profile = 'pi:rotom'
const time = '2026-10-13T04:36:31Z'
const body = '历史内容🙂'.repeat(100_000)
const turnCount = 8

export function seedPiHistory({ home, workspace, userDataDir }) {
  const directory = join(home, '.pi', 'agent', 'sessions', `--${workspace.slice(1).replaceAll('/', '-')}--`)
  mkdirSync(directory, { recursive: true })
  const lines = [{ type: 'session', version: 3, id: sessionId, cwd: workspace, timestamp: time }]
  let parentId = null
  for (let turn = 1; turn <= turnCount; turn++) {
    const userId = `u${turn}`
    lines.push({ type: 'message', id: userId, parentId, timestamp: time,
      message: { role: 'user', content: [{ type: 'text', text: `Existing Pi turn ${turn}` }] } })
    parentId = `a${turn}`
    lines.push({ type: 'message', id: parentId, parentId: userId, timestamp: time,
      message: { role: 'assistant', content: [{ type: 'text', text: `${turn}:${body}` }] } })
  }
  writeFileSync(join(directory, `fixture_${sessionId}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  writeFileSync(join(userDataDir, 'app-sessions.json'), JSON.stringify([{
    sessionId, externalSessionId: sessionId, runId: 'pi-fixture', providerId: 'pi', agentProfileId: profile,
    cwd: workspace, ts: Date.parse(time), preview: 'Existing Pi history'
  }]))
}

export async function checkPiHistory(evaluate, workspace) {
  const context = JSON.stringify({ providerId: 'pi', agentProfileId: profile, cwd: workspace, externalSessionId: sessionId })
  return evaluate(`(async () => {
    const context = ${context};
    const first = await window.scry.loadSession(context, { limit: 4 });
    const older = await window.scry.loadSessionOlder(context, { before: first.offset, limit: 4 });
    const turns = [...older.turns, ...first.turns];
    const ok = turns.length === ${turnCount} && first.hasOlder && !older.hasOlder &&
      turns.every((turn, index) => turn.userText === 'Existing Pi turn ' + (index + 1) &&
        turn.items.some(event => event.stage === 'text' && event.text === (index + 1) + ':' + '历史内容🙂'.repeat(100000)));
    return { ok, turns: turns.length, firstBytes: new TextEncoder().encode(JSON.stringify(first)).length };
  })()`)
}
