export type WorkflowCheckRequest = {
  argv: string[]
  cwd: string
  timeoutMs: number
  parser: 'exit_code' | 'typescript'
}

/** Main resolves and fingerprints these fields before plan approval. */
export type WorkflowFrozenCheck = WorkflowCheckRequest & {
  executable: string
  executableHash: string
  entrypoint?: { path: string; hash: string }
  interpreters: Array<{ path: string; hash: string }>
  launch: { executable: string; args: string[] }
  replicaRoot: string
  /** Present only on the main-derived binding to an owned materialized copy. */
  sourceRoot?: string
  replicaIdentity: { device: number; inode: number }
  workingDirectory: string
  environmentHash: string
  repositoryCode: true
}

export type WorkflowCheckDiagnostic = {
  file: string
  line: number
  column: number
  code: string
  message: string
}

export type WorkflowCheckResult = {
  state: 'passed' | 'failed' | 'timed_out' | 'cancelled' | 'unknown' | 'rejected'
  startedAt: number
  /** Main result observation time; not proof that every native scope exited. */
  finishedAt: number
  exitCode: number | null
  signal: string | null
  /** Proven closure of the registered process group, not a sandbox guarantee. */
  settled: boolean
  stdout: string
  stderr: string
  truncated: boolean
  evidence: 'exact'
  diagnostics: { state: 'available'; source: 'derived'; items: WorkflowCheckDiagnostic[] } | { state: 'unavailable'; reason: string }
  error?: string
}
