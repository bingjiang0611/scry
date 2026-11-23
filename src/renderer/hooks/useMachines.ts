// 机器页的数据入口（P8 §6）：打开页面读一次，手动刷新再读一次，不轮询。
// 静态检查禁止 renderer 出现远程轮询循环，所以这里只提供一次性读取。
import { useSyncExternalStore } from 'react'
import type { HostMetricsSnapshot } from '@shared/host-metrics'

export type MachineRead =
  | { status: 'unread' }
  | { status: 'loading'; stale?: HostMetricsSnapshot | null }
  | { status: 'ready'; snapshot: HostMetricsSnapshot }
  /** `stale` 保留上次成功读取的数据：失败不等于「这台机器没有资源」。 */
  | { status: 'failed'; detail: string; stale: HostMetricsSnapshot | null }

export interface TargetMachineRead {
  read: MachineRead
  /** 宿主明确不声明 hostMetrics 能力：卡片写「请升级」。 */
  unsupported?: boolean
}

export interface MachinesState {
  local: MachineRead
  targets: ReadonlyMap<string, TargetMachineRead>
  /** 最近一次成功读取的采样时间，用于页头「x 秒前更新」。 */
  updatedAt: number | null
  refreshing: boolean
}

let state: MachinesState = { local: { status: 'unread' }, targets: new Map(), updatedAt: null, refreshing: false }
const listeners = new Set<() => void>()
const inFlight = new Map<string, Promise<void>>()

function set(next: Partial<MachinesState>): void {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useMachines(): MachinesState {
  return useSyncExternalStore(subscribe, () => state, () => state)
}

/** 最近一次成功读取的快照；读不到时是 null，界面据此决定显示数字还是原因。 */
export function latestSnapshot(read: MachineRead): HostMetricsSnapshot | null {
  if (read.status === 'ready') return read.snapshot
  if (read.status === 'failed' || read.status === 'loading') return read.stale ?? null
  return null
}

export function machinesSnapshot(): MachinesState {
  return state
}

/** Test seam: forget every read without touching the real machine. */
export function resetMachines(): void {
  inFlight.clear()
  state = { local: { status: 'unread' }, targets: new Map(), updatedAt: null, refreshing: false }
  for (const listener of listeners) listener()
}

function detailOf(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message : String(reason)
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
    .replace(/^(?:[A-Za-z_$][\w$]*)?Error:\s+/, '')
    .trim() || '远程操作失败，未返回原因。'
}

function staleOf(read: MachineRead): HostMetricsSnapshot | null {
  if (read.status === 'ready') return read.snapshot
  if (read.status === 'failed') return read.stale
  if (read.status === 'loading') return read.stale ?? null
  return null
}

async function readLocal(): Promise<void> {
  const stale = staleOf(state.local)
  set({ local: stale ? { status: 'loading', stale } : { status: 'loading' } })
  try {
    const snapshot = await window.scry.hostMetricsRead()
    set({ local: { status: 'ready', snapshot }, updatedAt: snapshot.sampledAt })
  } catch (reason) {
    set({ local: { status: 'failed', detail: detailOf(reason), stale } })
  }
}

async function readTarget(connectionId: string): Promise<void> {
  const previous = state.targets.get(connectionId)
  const stale = previous ? staleOf(previous.read) : null
  set({ targets: new Map(state.targets).set(connectionId, {
    ...previous, read: stale ? { status: 'loading', stale } : { status: 'loading' }
  }) })
  try {
    const snapshot = await window.scry.desktopRemote.hostMetrics(connectionId)
    set({ targets: new Map(state.targets).set(connectionId, { read: { status: 'ready', snapshot } }), updatedAt: snapshot.sampledAt })
  } catch (reason) {
    const detail = detailOf(reason)
    const unsupported = detail.includes('desktop_host_metrics_unsupported')
    set({ targets: new Map(state.targets).set(connectionId, { read: { status: 'failed', detail, stale }, ...(unsupported ? { unsupported: true } : {}) }) })
  }
}

function once(key: string, work: () => Promise<void>): Promise<void> {
  const running = inFlight.get(key)
  if (running) return running
  const promise = work().finally(() => { inFlight.delete(key) })
  inFlight.set(key, promise)
  return promise
}

export function refreshLocalMetrics(): Promise<void> {
  return once('local', readLocal)
}

export function refreshTargetMetrics(connectionId: string): Promise<void> {
  return once(`target:${connectionId}`, () => readTarget(connectionId))
}

/** Reads the local machine and every saved target; one press of 刷新 does all of it. */
export async function refreshMachines(connectionIds: readonly string[]): Promise<void> {
  set({ refreshing: true })
  try {
    await Promise.all([refreshLocalMetrics(), ...connectionIds.map((id) => refreshTargetMetrics(id))])
  } finally { set({ refreshing: false }) }
}

/** The page reads once on open; already-read data is kept (switching views is not a refresh). */
export function ensureMachinesRead(connectionIds: readonly string[]): void {
  if (state.local.status === 'unread') void refreshLocalMetrics()
  for (const id of connectionIds) {
    if (!state.targets.has(id)) void refreshTargetMetrics(id)
  }
}
