import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CERT, grantedController, MemoryLedgerStore, routing } from './host-controller-fixtures'
import { LedgerProjectionMirror } from '../../host-runtime/orchestration/ledger-projection-mirror'

describe('P4-1 question answer peer side-channel (no peer fingerprint in persistent H1 poll)', () => {
  it('propagates answering peer to shadow answered_by via memory side-channel without leaking peer SHA in H1 poll()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-q-peer-e2e-'))
    const mirror = LedgerProjectionMirror.open({ userDataDir: dir })
    try {
      let releaseQuestion: (() => void) | undefined
      const questionOpened = new Promise<void>((resolve) => {
        releaseQuestion = resolve
      })

      const ledgerStore = new MemoryLedgerStore()
      const { controller } = await grantedController(async () => undefined, undefined, {
        ledgerStore,
        runProvider: async ({ runId, requestUserInput, stopSignal }) => {
          const pending = requestUserInput(
            {
              runId,
              questionId: 'q-e2e-1',
              providerId: 'codex',
              questionKind: 'permission',
              source: 'provider',
              questions: [
                {
                  question: 'Allow?',
                  header: 'Approve',
                  options: [{ label: 'Allow', description: 'Yes' }],
                  multiSelect: false
                }
              ]
            },
            stopSignal
          )
          releaseQuestion?.()
          await pending
        },
        onLedgerEvent: (event, meta) => mirror.onLedgerEvent(event, meta)
      })

      const sub = controller.submitIntent(CERT, {
        intentId: randomUUID(),
        detail: routing({ prompt: 'ask me' })
      })
      await questionOpened

      const answerId = randomUUID()
      const receipt = controller.answerQuestion(CERT, {
        runId: sub.runId,
        answerId,
        response: {
          runId: sub.runId,
          questionId: 'q-e2e-1',
          behavior: 'answered',
          answers: { 'Allow?': 'Allow' }
        }
      })
      expect(receipt).toEqual({ status: 'answered' })
      await controller.idle()

      // 1. Shadow interaction MUST record answering peer in answered_by (and outbox question.respond is done/shadowOnly)
      const interaction = mirror.sink!.getInteraction(sub.runId, 'q-e2e-1')
      expect(interaction?.answeredBy).toBe(`peer:${CERT}`)
      expect(interaction?.answerId).toBe(answerId)
      expect(mirror.stats().deviations).toBe(0)
      for (const row of mirror.sink!.listOutbox()) {
        expect(row.state).toBe('done')
        expect(row.payload.shadowOnly).toBe(true)
      }

      // 2. The original recorded H1 event has no peer fingerprint.
      const answeredEvt = ledgerStore.log.find(
        (evt) => evt.kind === 'run_progress' && evt.detail?.includes('question_answered')
      )
      expect(answeredEvt).toBeDefined()
      expect(answeredEvt!.detail).not.toContain(CERT)
      expect(answeredEvt!.detail).not.toContain('answeredByPeer')
    } finally {
      mirror.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
