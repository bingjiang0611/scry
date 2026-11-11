import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { handleRecorderHook } from '../recorder'
import { listRecords } from '../store'
import { workspace, payload } from './fixture.test'

// Sanitized rows from the 2026-11-10 session where Codex compacted the context inside turn 5
// and wrote only a top-level `compacted` row: no `event_msg/context_compacted`, and turn 5
// never reached `task_complete`. Message bodies, replacement history and cwd are redacted;
// timestamps, row types, turn IDs and ordinals are the incident's.
const turn5 = '01a1c625-33b7-7ee2-bd86-ff91de37d6eb'
const turn6 = '01a1c63f-d0bf-7092-8697-bd9e4d9283eb'

const turn5Head = [
  {
    timestamp: '2026-11-10T15:48:09.904Z', ordinal: 1131, type: 'event_msg',
    payload: {
      type: 'task_started', turn_id: turn5, root_turn_id: turn5,
      started_at: 1794325689, model_context_window: 475000, collaboration_mode_kind: 'default'
    }
  },
  {
    timestamp: '2026-11-10T15:48:13.273Z', ordinal: 1132, type: 'turn_context',
    payload: { turn_id: turn5, cwd: '/workspace/fixture', model: 'gpt-fixture', effort: 'high' }
  },
  {
    timestamp: '2026-11-10T15:48:27.274Z', ordinal: 1133, type: 'response_item',
    payload: { type: 'message', id: 'msg-redacted-1', role: 'user', content: [{ type: 'input_text', text: 'redacted prompt' }] }
  }
]

const turn5Compacted = [
  {
    timestamp: '2026-11-10T16:00:16.138Z', ordinal: 1328, type: 'compacted',
    payload: {
      message: '', replacement_history: [], window_number: 1,
      window_id: 'window-redacted', compaction_response_id: 'resp-redacted'
    }
  },
  {
    timestamp: '2026-11-10T16:00:16.155Z', ordinal: 1333, type: 'event_msg',
    payload: {
      type: 'item_completed', turn_id: turn5, item: { type: 'ContextCompaction', id: 'item-redacted' },
      started_at_ms: 1794326264424, completed_at_ms: 1794326416155
    }
  }
]

const turn6Head = [
  {
    timestamp: '2026-11-10T16:17:13.503Z', ordinal: 1667, type: 'event_msg',
    payload: {
      type: 'task_started', turn_id: turn6, root_turn_id: turn6,
      started_at: 1794327433, model_context_window: 475000, collaboration_mode_kind: 'default'
    }
  },
  {
    timestamp: '2026-11-10T16:17:20.000Z', ordinal: 1668, type: 'response_item',
    payload: { type: 'message', id: 'msg-redacted-2', role: 'user', content: [{ type: 'input_text', text: 'redacted follow-up' }] }
  }
]

const turn6Complete = {
  timestamp: '2026-11-10T16:23:28.181Z', ordinal: 1824, type: 'event_msg',
  payload: {
    type: 'task_complete', turn_id: turn6, root_turn_id: turn6, last_agent_message: 'redacted answer',
    started_at: 1794327433, completed_at: 1794327808, duration_ms: 374680, time_to_first_token_ms: 18359
  }
}

const jsonl = (rows: unknown[]): string => `${rows.map((line) => JSON.stringify(line)).join('\n')}\n`

export function registerSuite23(): void {

  it('把现场 rollout 的顶层 compacted 只记到第 5 轮，第 6 轮重叠读到也不重复', async () => {
    const root = await workspace()
    const rollout = join(root, 'rollout-compacted.jsonl')
    await writeFile(rollout, jsonl(turn5Head))
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('codex-compacted-session', { prompt: 'redacted prompt', turn_id: turn5, rollout_path: rollout })
    })

    await appendFile(rollout, jsonl(turn5Compacted))
    await appendFile(rollout, jsonl(turn6Head))
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('codex-compacted-session', { prompt: 'redacted follow-up', turn_id: turn6, rollout_path: rollout })
    })

    await appendFile(rollout, jsonl([turn6Complete]))
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('codex-compacted-session', { turn_id: turn6, rollout_path: rollout, timestamp: turn6Complete.timestamp })
    })

    const records = await listRecords(join(root, '.scry'))
    expect(records.map((record) => record.providerTurnId)).toEqual([turn5, turn6])
    expect(records[0].compactions).toMatchObject({ value: [{ at: '2026-11-10T16:00:16.138Z' }] })
    expect(records[1].compactions).toMatchObject({ value: [] })
  })
}
