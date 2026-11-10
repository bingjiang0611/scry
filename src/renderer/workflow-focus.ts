// Which workflow run the Workflow surface should select.
//
// The entry point lives in a chat tool card (deep in the transcript) while the surface is
// mounted by the shell, and the existing transcript chain already carries callbacks only
// downward. A two-value external store keeps the request in one place instead of threading
// state through the shell and a callback through the transcript.
import { useSyncExternalStore } from 'react'

let requested: string | null = null
const listeners = new Set<() => void>()

/** Ask the Workflow surface to select the run started by this `Workflow` tool_use. */
export function requestWorkflowRun(toolUseId: string | undefined): void {
  requested = toolUseId ?? null
  for (const listener of listeners) listener()
}

export function workflowRunRequest(): string | null {
  return requested
}

export function subscribeWorkflowRunRequest(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useWorkflowRunRequest(): string | null {
  return useSyncExternalStore(subscribeWorkflowRunRequest, workflowRunRequest, workflowRunRequest)
}
