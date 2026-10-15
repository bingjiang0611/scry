import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 原生 / 规范化双流事件日志（NDJSON）。
 *
 * 诊断「Scry 显示的和 Provider 实际说的不一致」时，唯一能定案的证据是两条流的对照：
 * Provider 原样发来的 native 记录，和 Scry 归一化后的 canonical 记录。它们由同一个
 * per-thread writer 写入同一文件并共享序号，所以可以直接看出某条 canonical 记录由哪条
 * native 记录派生，以及哪一步丢了信息。
 *
 * 几条硬约束：
 * - 默认关闭。只有显式设置环境变量才会落盘，因为记录里包含 prompt 与工具输出。
 * - fail-open：日志是观测附加路径，任何写入失败都只停用日志，绝不打断用户的 Agent。
 * - 不说谎：被瞬时白名单跳过、被尺寸上限截断、因错误停用的记录都会计数，并在收尾
 *   摘要里写明，不会表现为「这些事件没发生过」。
 */

export const PROVIDER_EVENT_LOG_ENV = 'SCRY_PROVIDER_EVENT_LOG'

export type ProviderEventStream = 'native' | 'canonical'

export interface ProviderEventLogLimits {
  /** 单个字符串值的字符上限。 */
  maxValueChars: number
  /** 单个对象/数组保留的字段数上限。 */
  maxFields: number
  /** 结构深度上限。 */
  maxDepth: number
  /** 缓冲达到该字节数即落盘。 */
  flushBytes: number
  /** 缓冲达到该记录数即落盘。 */
  flushRecords: number
  /** 单个日志分片的字节上限。 */
  maxFileBytes: number
  /** 每个线程保留的分片数量上限。 */
  maxFiles: number
  /** 日志根目录的总字节上限。 */
  maxTotalBytes: number
  /** 分片保留时长。 */
  retentionMs: number
  /** 两次清理之间的最小间隔。 */
  sweepIntervalMs: number
}

export const DEFAULT_PROVIDER_EVENT_LOG_LIMITS: ProviderEventLogLimits = {
  maxValueChars: 65_536,
  maxFields: 1_024,
  maxDepth: 16,
  flushBytes: 1_048_576,
  flushRecords: 512,
  maxFileBytes: 10 * 1024 * 1024,
  maxFiles: 10,
  maxTotalBytes: 512 * 1024 * 1024,
  retentionMs: 14 * 24 * 60 * 60 * 1_000,
  sweepIntervalMs: 5 * 60 * 1_000
}

/**
 * 瞬时事件：同一内容会在随后的完整事件里再出现一次，逐 token 落盘只会把日志撑爆而不
 * 增加证据。它们被计数后跳过，不写入文件。
 */
export const DEFAULT_TRANSIENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  // Claude Agent SDK
  'native:stream_event',
  // Codex app-server
  'native:item/agentMessage/delta',
  'native:item/reasoning/textDelta',
  'native:item/reasoning/summaryTextDelta',
  // Pi RPC
  'native:message_update',
  // OpenCode SSE
  'native:message.part.delta',
  'native:session.next.text.delta',
  'native:session.next.reasoning.delta',
  // Scry 规范化事件
  'canonical:model/text_delta',
  'canonical:model/thinking_delta'
])

export interface SanitizedRecord {
  value: unknown
  /** 是否因为字符、字段或深度上限而丢弃了内容。 */
  truncated: boolean
}

const DEPTH_LIMITED = '[depth-limited]'
const CIRCULAR = '[circular]'

export function sanitizeEventRecord(
  input: unknown,
  limits: ProviderEventLogLimits = DEFAULT_PROVIDER_EVENT_LOG_LIMITS
): SanitizedRecord {
  let truncated = false
  const seen = new Set<object>()

  const walk = (value: unknown, depth: number): unknown => {
    if (value === null) return null
    switch (typeof value) {
      case 'string':
        if (value.length <= limits.maxValueChars) return value
        truncated = true
        return `${value.slice(0, limits.maxValueChars)}…[+${value.length - limits.maxValueChars} chars]`
      case 'number':
        return Number.isFinite(value) ? value : String(value)
      case 'boolean':
        return value
      case 'bigint':
        return value.toString()
      case 'undefined':
      case 'function':
      case 'symbol':
        return undefined
      default:
        break
    }
    const object = value as object
    if (seen.has(object)) {
      truncated = true
      return CIRCULAR
    }
    if (depth >= limits.maxDepth) {
      truncated = true
      return DEPTH_LIMITED
    }
    seen.add(object)
    try {
      if (Array.isArray(value)) {
        const kept = value.slice(0, limits.maxFields).map((item) => walk(item, depth + 1))
        if (value.length > limits.maxFields) {
          truncated = true
          kept.push(`[+${value.length - limits.maxFields} items]`)
        }
        return kept
      }
      if (value instanceof Date) return value.toISOString()
      if (value instanceof Error) return { name: value.name, message: walk(value.message, depth + 1) }
      if (value instanceof Map || value instanceof Set) return walk([...value], depth)
      if (Buffer.isBuffer(value)) return `[buffer ${value.byteLength} bytes]`
      const entries = Object.entries(value as Record<string, unknown>)
      const result: Record<string, unknown> = {}
      for (const [key, item] of entries.slice(0, limits.maxFields)) {
        const walked = walk(item, depth + 1)
        if (walked !== undefined) result[key] = walked
      }
      if (entries.length > limits.maxFields) {
        truncated = true
        result.__droppedFields = entries.length - limits.maxFields
      }
      return result
    } finally {
      seen.delete(object)
    }
  }

  return { value: walk(input, 0), truncated }
}

export interface ProviderEventWriterSummary {
  thread: string
  written: number
  transientSkipped: number
  truncated: number
  failed: boolean
}

export interface ProviderEventWriter {
  /** 记录一条事件。永不抛错，永不阻塞调用方。 */
  record(stream: ProviderEventStream, type: string, payload: unknown): void
  /** 把缓冲写入磁盘。 */
  flush(): Promise<void>
  /** 写出收尾摘要并落盘。 */
  close(): Promise<ProviderEventWriterSummary>
  /** 当前计数，用于诊断与测试。 */
  summary(): ProviderEventWriterSummary
}

interface ProviderEventLogOptions {
  root: string
  limits?: Partial<ProviderEventLogLimits>
  transientTypes?: ReadonlySet<string>
  now?: () => number
}

const safeSegment = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'thread'

export class ProviderEventLog {
  readonly root: string
  readonly limits: ProviderEventLogLimits
  private readonly transientTypes: ReadonlySet<string>
  private readonly now: () => number
  private lastSweepAt = 0
  private sweeping: Promise<void> | null = null

  constructor(options: ProviderEventLogOptions) {
    this.root = options.root
    this.limits = { ...DEFAULT_PROVIDER_EVENT_LOG_LIMITS, ...options.limits }
    this.transientTypes = options.transientTypes ?? DEFAULT_TRANSIENT_EVENT_TYPES
    this.now = options.now ?? Date.now
  }

  /**
   * `SCRY_PROVIDER_EVENT_LOG=1` 写到 `<userData>/provider-event-log`；
   * 设为绝对路径则写到该目录。其他取值（含未设置）表示关闭。
   */
  static fromEnvironment(
    env: NodeJS.ProcessEnv,
    defaultRoot: string,
    options: Omit<ProviderEventLogOptions, 'root'> = {}
  ): ProviderEventLog | null {
    const value = env[PROVIDER_EVENT_LOG_ENV]?.trim()
    if (!value || value === '0') return null
    if (value === '1') return new ProviderEventLog({ ...options, root: join(defaultRoot, 'provider-event-log') })
    if (!value.startsWith('/')) return null
    return new ProviderEventLog({ ...options, root: value })
  }

  writer(thread: string): ProviderEventWriter {
    const limits = this.limits
    const safeThread = safeSegment(thread)
    const dir = join(this.root, safeThread)
    const startedAt = this.now()
    let shard = 0
    let shardBytes = 0
    let buffer: string[] = []
    let bufferBytes = 0
    let sequence = 0
    let written = 0
    let transientSkipped = 0
    let truncatedRecords = 0
    let failed = false
    let closed = false
    // 写入串行化：NDJSON 的每条记录必须完整且有序，并发 append 会把行劈开。
    let tail: Promise<void> = Promise.resolve()

    const shardPath = (): string => join(dir, `events-${String(shard).padStart(3, '0')}.ndjson`)

    const writeOut = async (chunk: string): Promise<void> => {
      if (failed || !chunk) return
      try {
        await mkdir(dir, { recursive: true })
        const bytes = Buffer.byteLength(chunk)
        if (shardBytes > 0 && shardBytes + bytes > limits.maxFileBytes) {
          shard += 1
          shardBytes = 0
        }
        await appendFile(shardPath(), chunk)
        shardBytes += bytes
      } catch (error) {
        // 观测路径 fail-open：停用这个 writer，并让摘要诚实地标记失败。
        failed = true
        console.warn('[scry] provider event log disabled after a write failure:', (error as Error).message)
      }
    }

    const enqueueFlush = (): Promise<void> => {
      if (buffer.length === 0) return tail
      const chunk = buffer.join('')
      buffer = []
      bufferBytes = 0
      tail = tail.then(() => writeOut(chunk))
      return tail
    }

    const append = (stream: ProviderEventStream | 'log', type: string, payload: unknown, afterClose = false): void => {
      if (failed || (closed && !afterClose)) return
      const sanitized = sanitizeEventRecord(payload, limits)
      if (sanitized.truncated) truncatedRecords += 1
      const line = `${JSON.stringify({
        seq: ++sequence,
        ts: new Date(this.now()).toISOString(),
        thread: safeThread,
        stream,
        type,
        truncated: sanitized.truncated || undefined,
        payload: sanitized.value
      })}\n`
      // 收尾摘要本身不算事件记录，否则摘要里的计数会和它自己矛盾。
      if (stream !== 'log') written += 1
      buffer.push(line)
      bufferBytes += Buffer.byteLength(line)
      if (bufferBytes >= limits.flushBytes || buffer.length >= limits.flushRecords) void enqueueFlush()
    }

    void this.sweep()

    return {
      record: (stream, type, payload) => {
        if (this.transientTypes.has(`${stream}:${type}`)) {
          transientSkipped += 1
          return
        }
        append(stream, type, payload)
      },
      flush: () => enqueueFlush(),
      close: async () => {
        if (!closed) {
          closed = true
          // 收尾摘要是日志的诚实声明：跳过和截断的数量必须留在文件里。
          append('log', 'summary', {
            thread: safeThread,
            written,
            transientSkipped,
            truncated: truncatedRecords,
            durationMs: this.now() - startedAt
          }, true)
        }
        await enqueueFlush()
        await tail
        return { thread: safeThread, written, transientSkipped, truncated: truncatedRecords, failed }
      },
      summary: () => ({ thread: safeThread, written, transientSkipped, truncated: truncatedRecords, failed })
    }
  }

  /** 按分片数、总量和保留期回收旧日志。最多每 sweepIntervalMs 执行一次。 */
  async sweep(force = false): Promise<void> {
    const now = this.now()
    if (!force && now - this.lastSweepAt < this.limits.sweepIntervalMs) return
    if (this.sweeping) return this.sweeping
    this.lastSweepAt = now
    this.sweeping = (async () => {
      try {
        const files: Array<{ path: string; thread: string; mtimeMs: number; size: number }> = []
        for (const threadEntry of await readdir(this.root, { withFileTypes: true })) {
          if (!threadEntry.isDirectory() || threadEntry.isSymbolicLink()) continue
          const threadDir = join(this.root, threadEntry.name)
          for (const fileEntry of await readdir(threadDir, { withFileTypes: true })) {
            if (!fileEntry.isFile() || fileEntry.isSymbolicLink() || !/^events-\d{3}\.ndjson$/.test(fileEntry.name)) continue
            const path = join(threadDir, fileEntry.name)
            const info = await stat(path)
            files.push({ path, thread: threadEntry.name, mtimeMs: info.mtimeMs, size: info.size })
          }
        }
        const doomed = new Set<string>()
        for (const file of files) {
          if (now - file.mtimeMs > this.limits.retentionMs) doomed.add(file.path)
        }
        const byThread = new Map<string, typeof files>()
        for (const file of files) {
          const list = byThread.get(file.thread) ?? []
          list.push(file)
          byThread.set(file.thread, list)
        }
        for (const list of byThread.values()) {
          list.sort((left, right) => right.mtimeMs - left.mtimeMs)
          list.slice(this.limits.maxFiles).forEach((file) => doomed.add(file.path))
        }
        const survivors = files.filter((file) => !doomed.has(file.path)).sort((left, right) => right.mtimeMs - left.mtimeMs)
        let total = 0
        for (const file of survivors) {
          total += file.size
          if (total > this.limits.maxTotalBytes) doomed.add(file.path)
        }
        for (const path of doomed) {
          try { await rm(path, { force: true }) } catch { /* 清理是尽力而为 */ }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('[scry] provider event log sweep failed:', (error as Error).message)
        }
      } finally {
        this.sweeping = null
      }
    })()
    return this.sweeping
  }
}

let configured: ProviderEventLog | null = null

/** 在主进程启动时按环境变量装配；未启用时保持 null。 */
export function configureProviderEventLog(env: NodeJS.ProcessEnv, defaultRoot: string): ProviderEventLog | null {
  configured = ProviderEventLog.fromEnvironment(env, defaultRoot)
  return configured
}

/** 取得当前进程的日志；未启用时返回 undefined，调用方用可选链跳过。 */
export function openProviderEventWriter(thread: string): ProviderEventWriter | undefined {
  return configured?.writer(thread)
}
