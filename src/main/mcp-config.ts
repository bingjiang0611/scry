import { spawn } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface McpConfigItem {
  name: string
  scope: string
  transport: string
  detail: string
  enabled: boolean
}

export interface McpTestResult {
  ok: boolean
  tools?: number
  toolNames?: string[]
  error?: string
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export function mcpDisabledSet(cwd: string | undefined, homeDir: string): Set<string> {
  if (!cwd) return new Set()
  const disabled = new Set<string>()
  const enabled = new Set<string>()
  const add = (set: Set<string>, a: unknown): void => {
    if (Array.isArray(a)) for (const n of a) set.add(String(n))
  }
  const claudeJson = readJson(join(homeDir, '.claude.json'))
  add(disabled, (claudeJson?.projects as Record<string, Record<string, unknown>> | undefined)?.[cwd]?.disabledMcpjsonServers)
  add(disabled, (claudeJson?.projects as Record<string, Record<string, unknown>> | undefined)?.[cwd]?.disabledMcpServers)
  add(enabled, (claudeJson?.projects as Record<string, Record<string, unknown>> | undefined)?.[cwd]?.enabledMcpjsonServers)

  const localSettings = readJson(join(cwd, '.claude', 'settings.local.json'))
  add(disabled, localSettings?.disabledMcpjsonServers)
  add(enabled, localSettings?.enabledMcpjsonServers)

  for (const n of enabled) disabled.delete(n)
  return disabled
}

export function listMcp(cwd: string | undefined, homeDir: string): McpConfigItem[] {
  const disabled = mcpDisabledSet(cwd, homeDir)
  const result: McpConfigItem[] = []
  const add = (name: string, cfg: Record<string, unknown>, scope: string): void => {
    const transport = cfg?.url || cfg?.type === 'http' || cfg?.type === 'sse' ? 'http' : 'stdio'
    result.push({
      name,
      scope,
      transport,
      detail: String(cfg?.url || cfg?.command || ''),
      enabled: !disabled.has(name)
    })
  }

  const claudeJson = readJson(join(homeDir, '.claude.json'))
  for (const [n, c] of Object.entries((claudeJson?.mcpServers as Record<string, unknown> | undefined) || {})) {
    add(n, c as Record<string, unknown>, 'user')
  }
  const projectServers = cwd
    ? (claudeJson?.projects as Record<string, { mcpServers?: Record<string, unknown> }> | undefined)?.[cwd]?.mcpServers
    : undefined
  if (projectServers) for (const [n, c] of Object.entries(projectServers)) add(n, c as Record<string, unknown>, 'project')

  const projectMcp = cwd ? readJson(join(cwd, '.mcp.json')) : null
  for (const [n, c] of Object.entries((projectMcp?.mcpServers as Record<string, unknown> | undefined) || {})) {
    add(n, c as Record<string, unknown>, '.mcp.json')
  }
  return result
}

export function findMcpConfig(name: string, cwd: string | undefined, homeDir: string): Record<string, unknown> | null {
  const claudeJson = readJson(join(homeDir, '.claude.json'))
  const userServers = claudeJson?.mcpServers as Record<string, unknown> | undefined
  if (userServers?.[name]) return userServers[name] as Record<string, unknown>
  const projectServers = cwd
    ? (claudeJson?.projects as Record<string, { mcpServers?: Record<string, unknown> }> | undefined)?.[cwd]?.mcpServers
    : undefined
  if (projectServers?.[name]) return projectServers[name] as Record<string, unknown>

  const projectMcp = cwd ? readJson(join(cwd, '.mcp.json')) : null
  const mcpJsonServers = projectMcp?.mcpServers as Record<string, unknown> | undefined
  return (mcpJsonServers?.[name] as Record<string, unknown> | undefined) ?? null
}

export function parseToolNames(text: string): string[] {
  const out: string[] = []
  const grab = (o: unknown): void => {
    const tools = (o as { result?: { tools?: Array<{ name?: string }> } })?.result?.tools
    if (Array.isArray(tools)) for (const t of tools) if (t.name) out.push(t.name)
  }
  try {
    grab(JSON.parse(text))
    if (out.length) return out
  } catch {
    /* not direct JSON; try SSE data lines below */
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^data:\s*(.+)$/)
    if (m) {
      try {
        grab(JSON.parse(m[1]))
      } catch {
        /* ignore invalid SSE frame */
      }
    }
  }
  return out
}

export function testStdioMcp(cfg: Record<string, unknown>): Promise<McpTestResult> {
  return new Promise((resolve) => {
    let done = false
    let proc: ReturnType<typeof spawn>
    const finish = (r: McpTestResult): void => {
      if (done) return
      done = true
      try {
        proc?.kill()
      } catch {
        /* ignore */
      }
      resolve(r)
    }
    try {
      proc = spawn(String(cfg.command), (cfg.args as string[]) || [], {
        env: { ...process.env, ...((cfg.env as Record<string, string>) || {}) },
        stdio: ['pipe', 'pipe', 'ignore']
      })
    } catch (e) {
      resolve({ ok: false, error: String((e as Error).message) })
      return
    }
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout 8s' }), 8000)
    let buf = ''
    proc.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        try {
          const o = JSON.parse(line)
          if (o.id === 1 && o.result) {
            proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
          } else if (o.id === 2 && o.result) {
            clearTimeout(timer)
            const names = ((o.result.tools || []) as Array<{ name?: string }>).map((t) => t.name).filter(Boolean) as string[]
            finish({ ok: true, tools: names.length, toolNames: names })
          }
        } catch {
          /* partial frame */
        }
      }
    })
    proc.on('error', (e: Error) => {
      clearTimeout(timer)
      finish({ ok: false, error: String(e.message) })
    })
    proc.on('exit', (code: number | null) => {
      if (code) {
        clearTimeout(timer)
        finish({ ok: false, error: `exit ${code}` })
      }
    })
    proc.stdin?.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'scry', version: '1' } }
      }) + '\n'
    )
    setTimeout(() => {
      try {
        proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
      } catch {
        /* ignore */
      }
    }, 100)
  })
}

export async function testHttpMcp(cfg: Record<string, unknown>): Promise<McpTestResult> {
  const url = String(cfg.url)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...((cfg.headers as Record<string, string>) || {})
  }
  const rpc = (id: number | undefined, method: string, h: Record<string, string>): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        jsonrpc: '2.0',
        ...(id != null ? { id } : {}),
        method,
        ...(method === 'initialize'
          ? { params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'scry', version: '1' } } }
          : {})
      }),
      signal: AbortSignal.timeout(8000)
    })
  try {
    const initRes = await rpc(1, 'initialize', headers)
    if (!initRes.ok) return { ok: false, error: `HTTP ${initRes.status}` }
    const sid = initRes.headers.get('mcp-session-id')
    const h2 = sid ? { ...headers, 'mcp-session-id': sid } : headers
    try {
      await rpc(undefined, 'notifications/initialized', h2)
    } catch {
      /* ignore */
    }
    const toolsRes = await rpc(2, 'tools/list', h2)
    const names = parseToolNames(await toolsRes.text())
    return { ok: true, tools: names.length, toolNames: names }
  } catch (e) {
    return { ok: false, error: String((e as Error).message) }
  }
}

export function testMcpConfig(cfg: Record<string, unknown>): Promise<McpTestResult> {
  if (cfg.url || cfg.type === 'http' || cfg.type === 'sse') return testHttpMcp(cfg)
  return testStdioMcp(cfg)
}

export function toggleMcp(name: string, enabled: boolean, cwd: string | undefined, homeDir: string): boolean {
  if (!cwd) return false
  const file = join(homeDir, '.claude.json')
  const cj = readJson(file)
  if (!cj) return false
  const projects = (cj.projects && typeof cj.projects === 'object' ? cj.projects : {}) as Record<string, Record<string, unknown>>
  const proj = (projects[cwd] && typeof projects[cwd] === 'object' ? projects[cwd] : {}) as Record<string, unknown>
  const disabled = new Set(Array.isArray(proj.disabledMcpjsonServers) ? (proj.disabledMcpjsonServers as string[]) : [])
  const enabledJson = new Set(Array.isArray(proj.enabledMcpjsonServers) ? (proj.enabledMcpjsonServers as string[]) : [])
  const disabledUser = new Set(Array.isArray(proj.disabledMcpServers) ? (proj.disabledMcpServers as string[]) : [])
  if (enabled) {
    disabled.delete(name)
    enabledJson.add(name)
    disabledUser.delete(name)
  } else {
    enabledJson.delete(name)
    disabled.add(name)
    disabledUser.add(name)
  }
  proj.disabledMcpjsonServers = [...disabled]
  proj.enabledMcpjsonServers = [...enabledJson]
  proj.disabledMcpServers = [...disabledUser]
  projects[cwd] = proj
  cj.projects = projects
  try {
    const tmp = file + '.scry.tmp'
    writeFileSync(tmp, JSON.stringify(cj, null, 2))
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}
