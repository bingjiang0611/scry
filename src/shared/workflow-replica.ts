export type WorkflowReplicaReference = {
  workflowId: string
  replicaId: string
  inputHash: string
}

export type WorkflowReplicaReceipt = WorkflowReplicaReference & {
  version: 1
  state: 'preparing' | 'ready'
  sourceRoot: string
  directory: string
  identity: { device: number; inode: number }
  createdAt: number
  manifestEntries: number
  manifestBytes: number
  contentBytes: number
}

export type WorkflowReplicaManifestEntry = {
  path: string
  hash: string
  mode: number
  bytes: number
  kind: 'file' | 'directory' | 'symlink'
  target?: string
}
