import { stat, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { readJson } from './io.js'

export const STOP_WAIT_MS = 1_000

export interface DaemonOwner {
  schemaVersion: 1
  pid: number
  instanceId: string
  state: 'starting' | 'running'
  createdAt: number
  recorderVersion: string
  socketPath: string
}

export function processAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function ownerPath(socketPath: string): string {
  return `${socketPath}.owner.json`
}

export function legacyStartingPath(socketPath: string): string {
  return join(dirname(socketPath), 'daemon-starting.json')
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function waitForProcessExit(pid: number, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs
  while (processAlive(pid) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
  }
  return !processAlive(pid)
}

export async function waitForOwner(path: string, instanceId: string, deadlineMs: number): Promise<DaemonOwner | null> {
  const deadline = Date.now() + deadlineMs
  do {
    const owner = await readJson<DaemonOwner>(path)
    if (owner?.instanceId === instanceId && processAlive(owner.pid)) return owner
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  } while (Date.now() < deadline)
  return null
}

export async function removeOwnedMarker(path: string, instanceId: string): Promise<void> {
  const current = await readJson<DaemonOwner>(path)
  if (current?.instanceId === instanceId) await rm(path, { force: true })
}

export async function stopOwner(owner: DaemonOwner): Promise<void> {
  if (!processAlive(owner.pid)) return
  try { process.kill(owner.pid, 'SIGTERM') } catch { return }
  if (await waitForProcessExit(owner.pid, STOP_WAIT_MS)) return
  try { process.kill(owner.pid, 'SIGKILL') } catch { return }
  await waitForProcessExit(owner.pid, STOP_WAIT_MS)
}
