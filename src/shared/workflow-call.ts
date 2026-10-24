import type { WorkflowFrameReference, WorkflowValueReference } from './workflow'

/** Main-issued call input evidence. These refs are not replica/path grants. */
export type WorkflowCallContext =
  | { kind: 'branch'; frameId: string; blockId: string; arm: 'then' | 'else' | 'unknown'; decisionRef: WorkflowValueReference }
  | { kind: 'map'; frameId: string; blockId: string; key: string | number | boolean | null; itemRef: WorkflowValueReference; collection: boolean }
  | { kind: 'loop'; frameId: string; blockId: string; iteration: number; semanticStateRef: WorkflowValueReference; invariantSemanticRef: WorkflowValueReference; stateRefs: Record<string, WorkflowValueReference>; invariantRefs: Record<string, WorkflowValueReference> }

export interface WorkflowCallReuseSource {
  programRevision: string
  attemptId: string
  inputRef: WorkflowValueReference
  reference: WorkflowFrameReference
}
