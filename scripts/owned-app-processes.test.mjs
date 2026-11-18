import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { inspectOwnedApp, stopOwnedApp } from './owned-app-processes.mjs'

describe('smoke-owned process cleanup', () => {
  it('reclaims a TERM-resistant child after intentionally crashing its parent', async () => {
    const grandchildScript = "process.on('SIGTERM',()=>{});process.send({ready:true});setInterval(()=>{},1000)"
    const parentScript = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(grandchildScript)}],{stdio:['ignore','ignore','ignore','ipc']});c.on('message',()=>process.send({pid:c.pid}));setInterval(()=>{},1000)`
    const child = spawn(process.execPath, ['-e', parentScript], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    let descendant
    try {
      const [message] = await once(child, 'message')
      descendant = message.pid
      const snapshot = inspectOwnedApp(child)
      expect(snapshot.state).toBe('observed')
      expect(snapshot.truncated).toBe(false)
      expect(snapshot.processes.map(row => row.pid).sort()).toEqual([child.pid, descendant].sort())
      const result = await stopOwnedApp(child, { crash: true })
      expect(result.tracked).toBe(2)
      expect(() => process.kill(descendant, 0)).toThrow()
      expect(child.signalCode).toBe('SIGKILL')
      expect(inspectOwnedApp(child)).toMatchObject({ state: 'exited', descendants: 'unknown' })
    } finally {
      // Exact children created by this fixture only; never a name-based sweep.
      if (child.exitCode === null && child.signalCode === null) await stopOwnedApp(child, { crash: true })
    }
  // The cleanup contract itself allows up to 5s, plus two Node launches and process snapshots.
  }, 15_000)

  it('leaves an excluded subtree (a detached daemon) to its own verified stop', async () => {
    const grandchildScript = "process.send({ready:true});setInterval(()=>{},1000)"
    const parentScript = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(grandchildScript)}],{stdio:['ignore','ignore','ignore','ipc']});c.on('message',()=>process.send({pid:c.pid}));setInterval(()=>{},1000)`
    const child = spawn(process.execPath, ['-e', parentScript], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    let excluded
    try {
      const [message] = await once(child, 'message')
      excluded = message.pid
      const result = await stopOwnedApp(child, { exclude: [excluded] })
      expect(result.tracked).toBe(1)
      expect(() => process.kill(excluded, 0)).not.toThrow()
    } finally {
      if (child.exitCode === null && child.signalCode === null) await stopOwnedApp(child, { crash: true })
      // The exact pid this fixture's own child reported; never a name-based sweep.
      if (excluded) try { process.kill(excluded, 'SIGKILL') } catch { /* already gone */ }
    }
  }, 15_000)
})
