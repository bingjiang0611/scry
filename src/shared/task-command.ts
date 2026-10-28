import type { CapabilityState, ProviderCommand, ProviderId } from './provider'
import type { WorkflowSizeGuideline } from './workflow-size'

/** A public selector, not an execution/authoring or fee authorization token.
 * Main resolves this ID against its own current catalogue. */
export const SCRY_WORKFLOW_COMMAND_ID = 'scry:workflow'

export type TaskCommandOrigin = Readonly<
  { kind: 'scry_workflow' } |
  { kind: 'provider'; providerId: ProviderId; agentProfileId?: string }
>
export type TaskCommandDescriptor = Readonly<{
  id: string
  name: string
  description: string
  argumentHint?: string
  origin: TaskCommandOrigin
  /** Provider-supplied metadata, not authority to identify a Scry command. */
  nativeSource?: ProviderCommand['source']
  ambiguous: boolean
}>
export type TaskCommandCatalog = Readonly<{
  /** Native binding identity only, not a complete model/config fingerprint. */
  scope: string
  provider: Readonly<{ state: CapabilityState; complete: boolean; reason?: string; reasonTruncated?: true; observedAt?: number }>
  commands: readonly TaskCommandDescriptor[]
}>

/** Requests only. None of these values grants authoring, fees or execution. */
export type ScryTaskCommand = Readonly<
  { kind: 'list' } |
  { kind: 'size'; value: WorkflowSizeGuideline | 'default' } |
  { kind: 'mode'; mode: 'off' | 'manual' | 'auto' } |
  { kind: 'run' | 'direct' | 'research'; goal: string } |
  { kind: 'template'; scope?: 'builtin' | 'personal' | 'project'; templateId: string; input: string } |
  { kind: 'edit'; scope?: 'builtin' | 'personal' | 'project'; templateId: string; input: string }
>
export type ResolvedTaskCommand = Readonly<
  { kind: 'plain' } |
  { kind: 'scry_workflow'; command: ScryTaskCommand; descriptor: TaskCommandDescriptor } |
  { kind: 'provider'; descriptor: TaskCommandDescriptor }
>
