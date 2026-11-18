import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 一次 run 的阶段绝对时间戳（NDJSON），用于跨进程对齐首 token 的每一段耗时。
 *
 * 为什么不能只用各进程内部的 `performance.now()`：daemon 与 App 是两个进程，
 * `now()` 的起点不同，减出来的差没有意义。`performance.timeOrigin` 是本进程时钟的
 * epoch，`timeOrigin + now()` 因此是墙钟绝对毫秒，同一台机器上的两个进程可以直接相减。
 *
 * 几条约束：
 * - 默认关闭。只有显式设置环境变量才写盘；这是测量代码，不参与产品行为。
 * - fail-open。写入失败只停用记录，绝不打断 run。
 * - 每个 (runId, stage) 只记第一次，因为要测的是「第一次到达」，不是最后一次。
 * - 同步写入：异步排队会把时间戳挪到软盘之后，测出来的就不是被测的那件事。
 */

export const RUN_STAGE_TIMING_ENV = 'SCRY_RUN_TIMING'

export type RunStage =
  | 'submit'
  | 'intentDurable'
  | 'dispatch'
  | 'providerStart'
  | 'firstOutput'
  | 'traceRead'
  | 'watchReply'
  | 'rendererPush'
  // F1: where a read goes between the daemon's answer and the window. The first of each
  // is what matters: the queue is when the bridge accepted the text, the flush is when
  // the batch left for the renderer.
  | 'bridgeQueue'
  | 'bridgeFlush'

let target: string | null = null
let recorded = new Set<string>()

export function configureRunStageTiming(userDataDir: string | null): void {
  if (userDataDir === null || process.env[RUN_STAGE_TIMING_ENV] !== '1') { target = null; return }
  try {
    mkdirSync(join(userDataDir, 'diagnostics'), { recursive: true })
    target = join(userDataDir, 'diagnostics', 'run-timing.ndjson')
  } catch { target = null }
}

export function runStageTimingEnabled(): boolean { return target !== null }

export function recordRunStage(runId: string, stage: RunStage): void {
  if (target === null || typeof runId !== 'string' || runId.length === 0) return
  const key = `${runId}\u0000${stage}`
  if (recorded.has(key)) return
  // Bounded: a long-lived daemon must not grow this set for every run it ever ran.
  if (recorded.size >= 8_192) recorded = new Set()
  recorded.add(key)
  try {
    appendFileSync(target, `${JSON.stringify({
      runId, stage, at: performance.timeOrigin + performance.now(), pid: process.pid
    })}\n`)
  } catch { /* observation must never block a run */ }
}
