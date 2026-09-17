import { parentPort, workerData } from 'node:worker_threads'
import type { TerminalExitEvent, TerminalRecordingListRequest, TerminalRecordingRequest, TerminalSessionInfo } from '../shared/terminal'
import { TerminalRecordingStore } from './terminal-recording'

interface Request { requestId: number; op: 'start' | 'append' | 'finish' | 'read' | 'list' | 'delete'; value: unknown }
interface Reply { requestId: number; ok: boolean; value?: unknown; error?: string; failures?: Array<{ id: string; error: string }> }

if (!parentPort || !workerData || typeof workerData.directory !== 'string') {
  throw new Error('terminal_recording_worker_invalid_startup')
}
const store = new TerminalRecordingStore(workerData.directory, (id, error) => {
  parentPort!.postMessage({ event: 'failure', id, error: error instanceof Error ? error.message : String(error) })
})

parentPort.on('message', async (request: Request) => {
  const reply: Reply = { requestId: request.requestId, ok: true }
  try {
    switch (request.op) {
      case 'start': store.start(request.value as TerminalSessionInfo); break
      case 'append':
        for (const entry of (request.value as { entries: Array<{ id: string; data: string }> }).entries) store.append(entry.id, entry.data)
        break
      case 'finish': store.finish(request.value as TerminalExitEvent); break
      case 'read': {
        const value = request.value as { request: TerminalRecordingRequest; cwd: string }
        reply.value = store.read(value.request, value.cwd)
        break
      }
      case 'list': {
        const value = request.value as { request: TerminalRecordingListRequest; cwd: string }
        reply.value = await store.list(value.request, value.cwd)
        break
      }
      case 'delete': {
        const value = request.value as { id: string; cwd: string }
        store.delete(value.id, value.cwd)
        break
      }
    }
  } catch (error) {
    reply.ok = false
    reply.error = error instanceof Error ? error.message : String(error)
  }
  parentPort!.postMessage(reply)
})
