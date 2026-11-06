import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createPiAdapter } from './pi'
import { listRecords } from '../../core/turn-recorder/store'
import { recoverManagedRecorderTurns } from '../../core/turn-recorder/managed'
import { shouldUseManagedTerminalPersistence } from '../trace-turn-progress'
import { withFixture, withCommandFixture } from './pi-test-fixture'
import type { TraceEvent } from '../../shared/trace'

describe('Pi RPC Provider', () => {
  it('proves an explicit skill through get_commands and emits a skill event', async () => {
    await withFixture(async (profile, cwd) => {
      const events: TraceEvent[] = []
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-skill', prompt: '/skill:rate-workflow 85781174', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => events.push(event)
      })

      await expect(handle.promise).resolves.toMatchObject({ providerTurnId: 'pi-user-1' })
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'skill', stage: 'skill:rate-workflow', tool: 'Skill', name: 'rate-workflow',
          input: expect.objectContaining({ source: 'explicit_user_input' })
        })
      ]))
    })
  }, 15_000)

  it.each([false, true])('finishes a menu-only command (cancelled=%s), clears its provisional record and accepts the next turn', async (cancelled) => {
    await withCommandFixture(async (profile, cwd) => {
      writeFileSync(join(cwd, 'scry.config.json'), JSON.stringify({
        schemaVersion: 1, enabled: true, workspaceId: 'pi-menu-fixture', dataDir: '.scry',
        repositories: { mode: 'workspace-only' },
        capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
      }))
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const events: TraceEvent[] = []
      const questions: string[] = []
      const handle = adapter.run({
        runId: 'menu-run', prompt: '/fixture-menu', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', managedRecorder: true,
        managedRecorderIdentity: { runId: 'menu-run', promptHash: createHash('sha256').update('/fixture-menu').digest('hex') },
        emit: (event) => events.push(event),
        requestUserInput: async (request) => {
          questions.push(request.questionId)
          if (request.questionId === 'menu-editor') expect(request.questions[0].initialValue).toBe('Existing objective')
          if (cancelled) return { runId: request.runId, questionId: request.questionId, behavior: 'cancelled' }
          const answer = request.questionId === 'menu-select' ? 'Edit' : request.questionId === 'menu-confirm' ? '确认' : 'Updated objective'
          return { runId: request.runId, questionId: request.questionId, behavior: 'answered', answers: { [request.questions[0].question]: answer } }
        }
      })
      let terminal = false
      void handle.promise.then(() => { terminal = true }, () => { terminal = true })
      try {
        await vi.waitFor(() => expect(terminal).toBe(true), { timeout: 3_000 })
        const result = await handle.promise
        expect(result).toMatchObject({ externalSessionId: 'pi-session-1', status: 'completed' })
        expect(result.providerTurnId).toBeUndefined()
        expect(questions).toEqual(cancelled ? ['menu-select'] : ['menu-select', 'menu-editor', 'menu-confirm'])
        const end = events.find((event) => event.stage === 'result')
        expect(end).toMatchObject({ providerCommand: { name: 'fixture-menu', source: 'extension', modelTurn: 'unobserved' } })
        expect(end?.tokensIn).toBeUndefined()
        expect(end?.costUsd).toBeUndefined()
        expect(shouldUseManagedTerminalPersistence(true, { status: 'completed', items: events })).toBe(false)
        expect(await listRecords(join(cwd, '.scry'))).toEqual([])
        expect(await recoverManagedRecorderTurns(cwd, process.env, { provider: 'pi' })).toEqual({ recovered: 0, pending: 0 })
        const next = await adapter.run({
          runId: 'after-menu', prompt: 'next instruction', cwd, resume: result.externalSessionId,
          agentProfileId: profile.id, attachments: [], permissionMode: 'full_access', emit: () => {}
        }).promise
        expect(next).toMatchObject({ status: 'completed', providerTurnId: 'pi-user-1' })
        expect(readFileSync(join(cwd, 'fixture-starts'), 'utf8').trim().split('\n')).toHaveLength(1)
      } finally {
        handle.forceKill()
        await handle.promise.catch(() => {})
        await adapter.dispose?.()
      }
    })
  }, 15_000)

  it.each(['custom', 'custom-sentinel', 'custom-option', 'custom-preview', 'custom-legacy', 'option', 'cancel-select', 'unrelated-input', 'unrelated-context'])('round-trips the native questionnaire protocol: %s', async (scenario) => {
    await withCommandFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const questions: string[] = []
      const events: TraceEvent[] = []
      const promptSuffix = scenario === 'unrelated-input' ? '-unrelated'
        : scenario === 'unrelated-context' ? '-unrelated-context'
        : scenario === 'custom-preview' ? '-preview'
        : scenario === 'custom-legacy' ? '-legacy' : ''
      const customAnswer = scenario === 'custom-sentinel' ? '2. Type something.'
        : scenario === 'custom-option' ? '1. Continue' : '提交所有改动 保证工作区干净 然后构建并安装'
      const handle = adapter.run({
        runId: 'question-run', prompt: `/fixture-menu question${promptSuffix}`, cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => events.push(event),
        requestUserInput: async (request) => {
          questions.push(request.questionId)
          if (scenario === 'cancel-select' || request.questionId === 'question-input') {
            return { runId: request.runId, questionId: request.questionId, behavior: 'cancelled' }
          }
          const question = request.questions[0]
          expect(question.allowCustomAnswer).toBe(true)
          expect(question.options.map((option) => option.label)).toEqual(['1. Continue'])
          const answer = scenario === 'option' ? question.options[0].label : customAnswer
          return {
            runId: request.runId, questionId: request.questionId, behavior: 'answered', answers: { [question.question]: answer },
            ...(scenario === 'custom-option' ? { nativeCustomAnswer: true } : {})
          }
        }
      })
      try {
        await expect(handle.promise).resolves.toMatchObject({ status: 'completed' })
        expect(events.some((event) => event.isError)).toBe(false)
        expect(questions).toEqual(scenario.startsWith('unrelated') ? ['question-select', 'question-input'] : ['question-select'])
        const responses = readFileSync(join(cwd, 'question-responses'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
        if (scenario.startsWith('custom')) expect(responses.map((response) => response.value)).toEqual(['2. Type something.', customAnswer])
        if (scenario === 'option') expect(responses[0].value).toBe('1. Continue')
        if (scenario === 'cancel-select' || scenario.startsWith('unrelated')) expect(responses.at(-1)).toMatchObject({ cancelled: true })
      } finally {
        handle.forceKill()
        await handle.promise.catch(() => {})
        await adapter.dispose?.()
      }
    })
  }, 15_000)

  it.each(['option', 'custom', 'labels', 'cancel', 'changed'])('reviews the whole native question group before replying: %s', async (scenario) => {
    await withCommandFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const asked: string[] = []
      const handle = adapter.run({
        runId: 'batch-run', prompt: `/fixture-menu batch${scenario === 'changed' ? '-changed' : ''}`, cwd,
        agentProfileId: profile.id, attachments: [], permissionMode: 'full_access', emit: () => {},
        requestUserInput: async (request) => {
          asked.push(request.questionId)
          if (request.questionId === 'batch-second') {
            expect(request.questions[0].question).toBe('Unrelated secret')
            return { runId: request.runId, questionId: request.questionId, behavior: 'cancelled' }
          }
          expect(request.questionId).toBe('batch-tool')
          expect(request.questions.map((question) => question.question)).toEqual(['What matters?', 'When to review?'])
          expect(existsSync(join(cwd, 'batch-responses'))).toBe(false)
          if (scenario === 'cancel') return { runId: request.runId, questionId: request.questionId, behavior: 'cancelled' }
          return {
            runId: request.runId, questionId: request.questionId, behavior: 'answered',
            answers: scenario === 'labels'
              ? { 'What matters?': 'Speed', 'When to review?': 'Later' }
              : { 'What matters?': '2', 'When to review?': scenario === 'custom' ? '1' : '2' },
            ...(scenario === 'labels' ? {} : { nativeCustomAnswers: scenario === 'custom' ? ['When to review?'] : [] })
          }
        }
      })
      try {
        await expect(handle.promise).resolves.toMatchObject({ status: 'completed' })
        expect(asked).toEqual(scenario === 'changed' ? ['batch-tool', 'batch-second'] : ['batch-tool'])
        const replies = readFileSync(join(cwd, 'batch-responses'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
        if (scenario === 'cancel') expect(replies).toEqual([{ type: 'extension_ui_response', id: 'batch-first', cancelled: true }])
        else {
          expect(replies[0].value).toBe('2. Speed — Finish sooner')
          if (scenario === 'changed') expect(replies[1]).toMatchObject({ cancelled: true })
          else expect(replies.map((reply) => reply.value)).toEqual(scenario === 'custom' ? ['2. Speed — Finish sooner', '3. Type something.', '1'] : ['2. Speed — Finish sooner', '2. Later — At the end'])
        }
      } finally {
        handle.forceKill()
        await handle.promise.catch(() => {})
        await adapter.dispose?.()
      }
    })
  }, 15_000)

  // These verify command completion/evidence, not a three-second cold-start budget.
  // Await the native result within the existing 15-second test timeout.
  it('preserves visible custom command messages without inventing a model turn', async () => {
    await withCommandFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const events: TraceEvent[] = []
      const handle = adapter.run({
        runId: 'command-status', prompt: '/fixture-menu status', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => events.push(event)
      })
      try {
        expect(await handle.promise).toMatchObject({ status: 'completed' })
        expect(events.some((event) => event.kind === 'model')).toBe(false)
        expect(events.find((event) => event.stage === 'runtime:extension_message')).toMatchObject({ text: 'Custom command status' })
      } finally {
        handle.forceKill()
        await handle.promise.catch(() => {})
        await adapter.dispose?.()
      }
    })
  }, 15_000)

  it('does not turn an extension handler error into a successful command acknowledgement', async () => {
    await withCommandFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const events: TraceEvent[] = []
      const handle = adapter.run({
        runId: 'menu-error', prompt: '/fixture-menu error', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => events.push(event)
      })
      try {
        expect(await handle.promise).toMatchObject({ status: 'failed' })
        expect(events.find((event) => event.stage === 'result')).toMatchObject({ isError: true, text: 'menu failed' })
      } finally {
        handle.forceKill()
        await handle.promise.catch(() => {})
        await adapter.dispose?.()
      }
    })
  }, 15_000)

  it('keeps a command-triggered model run on the native turn and settlement path', async () => {
    await withCommandFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const events: TraceEvent[] = []
      expect(await adapter.run({
        runId: 'menu-model', prompt: '/fixture-menu run', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => events.push(event)
      }).promise).toMatchObject({ status: 'completed', providerTurnId: 'pi-user-1' })
      expect(events.find((event) => event.stage === 'result')?.providerCommand).toBeUndefined()
      await adapter.dispose?.()
    })
  }, 15_000)

})
