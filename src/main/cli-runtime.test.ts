import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentRuntimeError, assertRuntimeCliSurface, captureCliMcpStatus, runCliAgent } from './cli-runtime'
import type { TraceEvent } from '../shared/trace'

function fakeCli(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'scry-cli-probe-'))
  const file = join(dir, 'fake-cli')
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

describe('CLI runtime probes', () => {
  it('accepts the required Codex exec flag surface', () => {
    const cli = fakeCli(`
if [ "$1" = "--version" ]; then echo "codex-cli 0.142.5"; exit 0; fi
if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then echo "--json --cd --add-dir --sandbox --skip-git-repo-check"; exit 0; fi
exit 2
`)
    expect(() =>
      assertRuntimeCliSurface({ runtimeProvider: 'codex_cli', executablePath: cli, env: process.env as Record<string, string> })
    ).not.toThrow()
  })

  it('accepts the required Qoder npm flag surface without relying on hanging --help', () => {
    const cli = fakeCli(`
# local bundle strings: --output-format --cwd --permission-mode --add-dir --mcp-config
if [ "$1" = "-v" ]; then echo "1.0.2"; exit 0; fi
if [ "$1" = "--help" ]; then sleep 30; fi
exit 2
`)
    expect(() =>
      assertRuntimeCliSurface({ runtimeProvider: 'qoder_cli', executablePath: cli, env: process.env as Record<string, string> })
    ).not.toThrow()
  })

  it('rejects non-target Qoder versions as version_probe failures', () => {
    const cli = fakeCli(`
if [ "$1" = "-v" ]; then echo "2.0.0"; exit 0; fi
exit 2
`)
    expect(() =>
      assertRuntimeCliSurface({ runtimeProvider: 'qoder_cli', executablePath: cli, env: process.env as Record<string, string> })
    ).toThrow(AgentRuntimeError)
  })

  it('rejects Qoder bundles missing required local flags', () => {
    const cli = fakeCli(`
# local bundle strings: --output-format --cwd --permission-mode --mcp-config
if [ "$1" = "-v" ]; then echo "1.0.2"; exit 0; fi
exit 2
`)
    let err: unknown
    try {
      assertRuntimeCliSurface({ runtimeProvider: 'qoder_cli', executablePath: cli, env: process.env as Record<string, string> })
    } catch (caught) {
      err = caught
    }
    expect(err).toBeInstanceOf(AgentRuntimeError)
    expect((err as AgentRuntimeError).brief).toMatchObject({ provider: 'qoder_cli', stage: 'version_probe' })
    expect(String((err as Error).message)).toContain('missing flags: --add-dir')
  })

  it('captures version_probe failure evidence under the provider sample directory', () => {
    const cli = fakeCli(`
if [ "$1" = "--version" ]; then echo "probe died" >&2; exit 137; fi
if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then echo "--json --cd --add-dir --sandbox --skip-git-repo-check"; exit 0; fi
exit 2
`)
    const sampleRoot = mkdtempSync(join(tmpdir(), 'scry-runtime-probe-samples-'))
    let err: unknown
    try {
      assertRuntimeCliSurface({
        runtimeProvider: 'codex_cli',
        executablePath: cli,
        env: process.env as Record<string, string>,
        sampleRoot
      })
    } catch (caught) {
      err = caught
    }
    expect(err).toBeInstanceOf(AgentRuntimeError)
    const runtimeErr = err as AgentRuntimeError
    expect(runtimeErr.brief).toMatchObject({ stage: 'version_probe' })
    expect(runtimeErr.brief.evidencePath).toMatch(/\/codex\/\d{4}-\d{2}-\d{2}T/)
    expect(runtimeErr.brief.evidencePath).toContain(sampleRoot)
    const commandSummary = readFileSync(join(runtimeErr.brief.evidencePath!, 'command-summary.json'), 'utf8')
    const probeResults = readFileSync(join(runtimeErr.brief.evidencePath!, 'probe-results.json'), 'utf8')
    expect(commandSummary).toContain('"phase": "version_probe"')
    expect(commandSummary).toContain('"promptCaptured": false')
    expect(probeResults).toContain('"exitCode": 137')
    expect(probeResults).toContain('probe died')
  })
})

describe('CLI runtime JSONL normalization', () => {
  it('normalizes Codex JSON events into Scry TraceEvents', async () => {
    const cli = fakeCli(`
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-1"}'
printf '%s\\n' '{"type":"item.started","item":{"type":"command_execution","id":"cmd-1","command":"pwd"}}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"command_execution","id":"cmd-1","command":"pwd","aggregated_output":"/tmp","exit_code":0}}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":4,"cached_input_tokens":2}}'
`)
    const events: TraceEvent[] = []
    const handle = runCliAgent('hello', 'run-codex', (event) => events.push(event), {
      runtimeProvider: 'codex_cli',
      executablePath: cli,
      env: process.env as Record<string, string>
    })
    await expect(handle.promise).resolves.toMatchObject({ sessionId: 'thread-1' })
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'harness', stage: 'runtime:init', runtimeProvider: 'codex_cli' }),
        expect.objectContaining({ kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'cmd-1' }),
        expect.objectContaining({ kind: 'tool', stage: 'tool_result', toolUseId: 'cmd-1', text: '/tmp' }),
        expect.objectContaining({ kind: 'model', stage: 'text_delta', text: 'done' }),
        expect.objectContaining({ kind: 'harness', stage: 'result', tokensIn: 10, tokensOut: 4, cacheReadTokens: 2 })
      ])
    )
  })

  it('normalizes Codex reasoning and cache-write usage fields', async () => {
    const cli = fakeCli(`
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-usage"}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":20,"output_tokens":5,"cached_input_tokens":3,"cached_write_tokens":2,"reasoning_output_tokens":7}}'
`)
    const events: TraceEvent[] = []
    const handle = runCliAgent('hello', 'run-codex-usage', (event) => events.push(event), {
      runtimeProvider: 'codex_cli',
      executablePath: cli,
      env: process.env as Record<string, string>
    })
    await expect(handle.promise).resolves.toMatchObject({ sessionId: 'thread-usage' })
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'harness',
          stage: 'result',
          tokensIn: 20,
          tokensOut: 5,
          cacheReadTokens: 3,
          cacheCreationTokens: 2,
          reasoningTokens: 7
        })
      ])
    )
  })

  it('normalizes Codex todo_list items into TodoWrite tool spans', async () => {
    const cli = fakeCli(`
cat >/dev/null
printf '%s\\n' '{"type":"item.started","item":{"type":"todo_list","id":"todo-1","items":[{"content":"check mcp wiring","status":"in-progress"},{"content":"record evidence","completed":true}]}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`)
    const events: TraceEvent[] = []
    const handle = runCliAgent('hello', 'run-codex-todo', (event) => events.push(event), {
      runtimeProvider: 'codex_cli',
      executablePath: cli,
      env: process.env as Record<string, string>
    })
    await expect(handle.promise).resolves.toEqual({ sessionId: undefined, stopped: false })
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool',
          stage: 'tool:TodoWrite',
          tool: 'TodoWrite',
          toolUseId: 'todo-1',
          input: {
            todos: [
              { content: 'check mcp wiring', status: 'in_progress' },
              { content: 'record evidence', status: 'completed' }
            ]
          }
        })
      ])
    )
  })

  it('normalizes Codex mcp_tool_call items into server-qualified MCP spans', async () => {
    const cli = fakeCli(`
cat >/dev/null
printf '%s\\n' '{"type":"item.started","item":{"type":"mcp_tool_call","id":"mcp-codex-1","server":"dry_alpha","tool":"lookup_shared","arguments":{"query":"needle"},"status":"in_progress"}}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"mcp_tool_call","id":"mcp-codex-1","server":"dry_alpha","tool":"lookup_shared","arguments":{"query":"needle"},"result":{"content":[{"type":"text","text":"found"}]},"status":"completed"}}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"mcp_tool_call","id":"mcp-codex-2","server":"dry_beta","tool":"lookup_shared","arguments":{"query":"needle"},"error":{"message":"user cancelled MCP tool call"},"status":"failed"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`)
    const events: TraceEvent[] = []
    const handle = runCliAgent('hello', 'run-codex-mcp', (event) => events.push(event), {
      runtimeProvider: 'codex_cli',
      executablePath: cli,
      env: process.env as Record<string, string>
    })
    await expect(handle.promise).resolves.toEqual({ sessionId: undefined, stopped: false })
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool',
          stage: 'tool:mcp__dry_alpha__lookup_shared',
          tool: 'mcp__dry_alpha__lookup_shared',
          toolUseId: 'mcp-codex-1',
          isMcp: true,
          mcpServer: 'dry_alpha',
          mcpAction: 'lookup_shared'
        }),
        expect.objectContaining({ kind: 'tool', stage: 'tool_result', toolUseId: 'mcp-codex-1', isError: false }),
        expect.objectContaining({
          kind: 'tool',
          stage: 'tool:mcp__dry_beta__lookup_shared',
          tool: 'mcp__dry_beta__lookup_shared',
          toolUseId: 'mcp-codex-2',
          isMcp: true,
          mcpServer: 'dry_beta',
          mcpAction: 'lookup_shared'
        }),
        expect.objectContaining({ kind: 'tool', stage: 'tool_result', toolUseId: 'mcp-codex-2', isError: true })
      ])
    )
  })

  it('normalizes Qoder stream-json result without inventing cost', async () => {
    const cli = fakeCli(`
cat >/dev/null
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"qoder-1","model":"auto"}'
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}'
printf '%s\\n' '{"type":"result","usage":{"input_tokens":3,"output_tokens":2},"duration_ms":12,"stop_reason":"success","is_error":false}'
`)
    const events: TraceEvent[] = []
    const handle = runCliAgent('hello', 'run-qoder', (event) => events.push(event), {
      runtimeProvider: 'qoder_cli',
      executablePath: cli,
      env: process.env as Record<string, string>
    })
    await expect(handle.promise).resolves.toMatchObject({ sessionId: 'qoder-1' })
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'harness', stage: 'runtime:init', runtimeProvider: 'qoder_cli' }),
        expect.objectContaining({ kind: 'model', stage: 'text_delta', text: 'hello' }),
        expect.objectContaining({ kind: 'harness', stage: 'result', tokensIn: 3, tokensOut: 2, costUsd: undefined })
      ])
    )
  })

  it('preserves Qoder runtime-observed MCP disconnected status as capability warnings', async () => {
    const cli = fakeCli(`
cat >/dev/null
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"qoder-mcp","model":"auto","mcp_servers":[{"name":"dry_alpha","status":"disconnected"},{"name":"dry_beta","status":"disconnected"}]}'
printf '%s\\n' '{"type":"result","usage":{"input_tokens":2,"output_tokens":1},"is_error":false}'
`)
    const events: TraceEvent[] = []
    const handle = runCliAgent('hello', 'run-qoder-mcp-status', (event) => events.push(event), {
      runtimeProvider: 'qoder_cli',
      executablePath: cli,
      env: process.env as Record<string, string>,
      capabilityMetadata: {
        runtimeProvider: 'qoder_cli',
        mcpServers: [
          { id: 'dry_alpha', name: 'dry_alpha', injected: true },
          { id: 'dry_beta', name: 'dry_beta', injected: true }
        ]
      }
    })
    await expect(handle.promise).resolves.toMatchObject({
      sessionId: 'qoder-mcp',
      mcpStatus: [
        { name: 'dry_alpha', status: 'failed' },
        { name: 'dry_beta', status: 'failed' }
      ]
    })
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'harness',
          stage: 'runtime:init',
          runtimeProvider: 'qoder_cli',
          runtimeMetadata: expect.objectContaining({
            mcpServers: expect.arrayContaining([
              expect.objectContaining({ name: 'dry_alpha', status: 'disconnected' }),
              expect.objectContaining({ name: 'dry_beta', status: 'disconnected' })
            ])
          })
        }),
        expect.objectContaining({
          kind: 'harness',
          stage: 'result',
          runtimeProvider: 'qoder_cli',
          runtimeMetadata: expect.objectContaining({
            observedMcpServers: expect.arrayContaining([
              expect.objectContaining({ name: 'dry_alpha', status: 'disconnected' }),
              expect.objectContaining({ name: 'dry_beta', status: 'disconnected' })
            ]),
            capabilityWarnings: expect.arrayContaining([
              expect.objectContaining({
                kind: 'mcp',
                runtimeProvider: 'qoder_cli',
                name: 'dry_alpha',
                expected: 'connected',
                observed: 'disconnected',
                evidence: 'runtime:init.mcp_servers'
              }),
              expect.objectContaining({
                kind: 'mcp',
                runtimeProvider: 'qoder_cli',
                name: 'dry_beta',
                expected: 'connected',
                observed: 'disconnected'
              })
            ])
          })
        })
      ])
    )
  })

  it('captures Qoder MCP status through a lightweight init probe', async () => {
    const cli = fakeCli(`
cat >/dev/null
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"qoder-probe","model":"auto","mcp_servers":[{"name":"tracker","status":"connected","tools":2},{"name":"knowledge","status":"auth_required"}]}'
sleep 30
`)
    await expect(
      captureCliMcpStatus({
        runtimeProvider: 'qoder_cli',
        executablePath: cli,
        env: process.env as Record<string, string>,
        timeoutMs: 5_000
      })
    ).resolves.toEqual([
      { name: 'tracker', status: 'connected', tools: 2 },
      { name: 'knowledge', status: 'needs-auth' }
    ])
  })

  it('normalizes Qoder tool blocks into MCP spans and file-operation spans', async () => {
    const cli = fakeCli(`
cat >/dev/null
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"qoder-tools","model":"auto"}'
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"mcp-1","name":"mcp__alpha__lookup","input":{"query":"needle"}},{"type":"tool_result","tool_use_id":"mcp-1","content":"found"},{"type":"tool_use","id":"write-1","name":"Write","input":{"file_path":"/tmp/qoder.txt","content":"hi"}}]}}'
printf '%s\\n' '{"type":"result","usage":{"input_tokens":4,"output_tokens":3},"is_error":false}'
`)
    const events: TraceEvent[] = []
    const handle = runCliAgent('hello', 'run-qoder-tools', (event) => events.push(event), {
      runtimeProvider: 'qoder_cli',
      executablePath: cli,
      env: process.env as Record<string, string>
    })
    await expect(handle.promise).resolves.toMatchObject({ sessionId: 'qoder-tools' })
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool',
          stage: 'tool:mcp__alpha__lookup',
          tool: 'mcp__alpha__lookup',
          toolUseId: 'mcp-1',
          isMcp: true,
          mcpServer: 'alpha',
          mcpAction: 'lookup'
        }),
        expect.objectContaining({ kind: 'tool', stage: 'tool_result', toolUseId: 'mcp-1', output: 'found' }),
        expect.objectContaining({
          kind: 'tool',
          stage: 'tool:Write',
          tool: 'Write',
          toolUseId: 'write-1',
          fileOp: 'write',
          filePath: '/tmp/qoder.txt'
        })
      ])
    )
  })

  it('keeps same-named MCP tools server-qualified and maps Skill tool_use blocks to skill spans', async () => {
    const cli = fakeCli(`
cat >/dev/null
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"qoder-skill","model":"auto"}'
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"mcp-a","name":"mcp__alpha__lookup","input":{"query":"needle"}},{"type":"tool_use","id":"mcp-b","name":"mcp__beta__lookup","input":{"query":"needle"}},{"type":"tool_use","id":"skill-1","name":"Skill","input":{"skill":"design-skill","instruction":"use the reference"}}]}}'
printf '%s\\n' '{"type":"result","usage":{"input_tokens":5,"output_tokens":3},"is_error":false}'
`)
    const events: TraceEvent[] = []
    const handle = runCliAgent('hello', 'run-qoder-skill', (event) => events.push(event), {
      runtimeProvider: 'qoder_cli',
      executablePath: cli,
      env: process.env as Record<string, string>
    })
    await expect(handle.promise).resolves.toMatchObject({ sessionId: 'qoder-skill' })
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool',
          toolUseId: 'mcp-a',
          tool: 'mcp__alpha__lookup',
          isMcp: true,
          mcpServer: 'alpha',
          mcpAction: 'lookup'
        }),
        expect.objectContaining({
          kind: 'tool',
          toolUseId: 'mcp-b',
          tool: 'mcp__beta__lookup',
          isMcp: true,
          mcpServer: 'beta',
          mcpAction: 'lookup'
        }),
        expect.objectContaining({
          kind: 'skill',
          stage: 'skill:design-skill',
          tool: 'Skill',
          name: 'design-skill',
          toolUseId: 'skill-1'
        })
      ])
    )
  })

  it('classifies structured-output misses as parser failures', async () => {
    const cli = fakeCli(`
cat >/dev/null
echo 'plain text only'
`)
    const handle = runCliAgent('hello', 'run-raw', () => {}, {
      runtimeProvider: 'codex_cli',
      executablePath: cli,
      env: process.env as Record<string, string>
    })
    await expect(handle.promise).rejects.toMatchObject({ brief: expect.objectContaining({ stage: 'parser' }) })
  })

  it('classifies empty structured output as protocol failures', async () => {
    const cli = fakeCli(`
cat >/dev/null
exit 0
`)
    const handle = runCliAgent('hello', 'run-empty', () => {}, {
      runtimeProvider: 'codex_cli',
      executablePath: cli,
      env: process.env as Record<string, string>
    })
    await expect(handle.promise).rejects.toMatchObject({ brief: expect.objectContaining({ stage: 'protocol' }) })
  })

  it('classifies nonzero CLI exits as runtime failures', async () => {
    const cli = fakeCli(`
cat >/dev/null
echo 'provider boom' >&2
exit 42
`)
    const handle = runCliAgent('hello', 'run-runtime-fail', () => {}, {
      runtimeProvider: 'qoder_cli',
      executablePath: cli,
      env: process.env as Record<string, string>
    })
    await expect(handle.promise).rejects.toMatchObject({
      message: 'provider boom',
      brief: expect.objectContaining({ stage: 'runtime', exitCode: 42 })
    })
  })

  it('keeps runtime failure evidence on interrupted CLI runs', async () => {
    const cli = fakeCli(`
cat >/dev/null
sleep 30
`)
    const sampleRoot = mkdtempSync(join(tmpdir(), 'scry-runtime-stop-samples-'))
    const events: TraceEvent[] = []
    const handle = runCliAgent('hello', 'run-qoder-stop', (event) => events.push(event), {
      runtimeProvider: 'qoder_cli',
      executablePath: cli,
      env: process.env as Record<string, string>,
      sampleRoot
    })

    setTimeout(() => handle.interrupt(), 25)

    await expect(handle.promise).resolves.toMatchObject({ stopped: true })
    const result = events.find((event) => event.kind === 'harness' && event.stage === 'result')
    expect(result).toMatchObject({
      isError: true,
      runtimeFailureStage: 'runtime',
      runtimeMetadata: expect.objectContaining({
        samplePath: expect.stringContaining(sampleRoot),
        brief: expect.objectContaining({
          provider: 'qoder_cli',
          stage: 'runtime',
          evidencePath: expect.stringContaining(sampleRoot)
        })
      })
    })
  })

  it('preserves structured Codex turn.failed messages in runtime failures', async () => {
    const cli = fakeCli(`
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-fail"}'
printf '%s\\n' '{"type":"turn.failed","error":{"message":"codex auth expired"}}'
`)
    const events: TraceEvent[] = []
    const handle = runCliAgent('hello', 'run-codex-fail', (event) => events.push(event), {
      runtimeProvider: 'codex_cli',
      executablePath: cli,
      env: process.env as Record<string, string>
    })
    await expect(handle.promise).rejects.toMatchObject({
      message: 'codex auth expired',
      brief: expect.objectContaining({ stage: 'runtime', exitCode: 0 })
    })
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'harness',
          stage: 'result',
          isError: true,
          text: 'codex auth expired'
        })
      ])
    )
  })

  it('preserves Qoder result error messages even when the CLI exits 0', async () => {
    const cli = fakeCli(`
cat >/dev/null
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"qoder-fail","model":"auto"}'
printf '%s\\n' '{"type":"result","usage":{"input_tokens":1,"output_tokens":0},"is_error":true,"error":{"message":"qoder quota exceeded"},"stop_reason":"error"}'
`)
    const events: TraceEvent[] = []
    const handle = runCliAgent('hello', 'run-qoder-fail', (event) => events.push(event), {
      runtimeProvider: 'qoder_cli',
      executablePath: cli,
      env: process.env as Record<string, string>
    })
    await expect(handle.promise).rejects.toMatchObject({
      message: 'qoder quota exceeded',
      brief: expect.objectContaining({ stage: 'runtime', exitCode: 0 })
    })
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'harness',
          stage: 'result',
          isError: true,
          text: 'qoder quota exceeded',
          tokensIn: 1
        })
      ])
    )
  })

  it('captures local evidence samples without writing the prompt into the command summary', async () => {
    const cli = fakeCli(`
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-sample"}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`)
    const sampleRoot = mkdtempSync(join(tmpdir(), 'scry-runtime-samples-'))
    const events: TraceEvent[] = []
    const handle = runCliAgent('DO_NOT_WRITE_THIS_PROMPT', 'run-sample', (event) => events.push(event), {
      runtimeProvider: 'codex_cli',
      executablePath: cli,
      env: process.env as Record<string, string>,
      cwd: sampleRoot,
      extraAllowedDirs: [join(sampleRoot, 'skill-dir')],
      capabilityMetadata: { fixturePath: sampleRoot },
      sampleRoot
    })
    await expect(handle.promise).resolves.toMatchObject({ sessionId: 'thread-sample' })

    const providerDir = join(sampleRoot, 'codex')
    const sampleDir = join(providerDir, readdirSync(providerDir)[0])
    const commandSummary = readFileSync(join(sampleDir, 'command-summary.json'), 'utf8')
    const environmentSummary = readFileSync(join(sampleDir, 'environment-summary.json'), 'utf8')
    expect(commandSummary).not.toContain('DO_NOT_WRITE_THIS_PROMPT')
    expect(commandSummary).not.toContain(sampleRoot)
    expect(commandSummary).toContain('$SCRY_LOCAL_SAMPLE_DIR')
    expect(commandSummary).toContain('"runtimeProvider": "codex_cli"')
    expect(sampleDir).toMatch(/\/codex\/\d{4}-\d{2}-\d{2}T/)
    expect(environmentSummary).not.toContain(sampleRoot)
    expect(environmentSummary).toContain('$SCRY_LOCAL_SAMPLE_DIR')
    expect(readFileSync(join(sampleDir, 'stdout.raw.jsonl'), 'utf8')).toContain('thread.started')
    expect(readFileSync(join(sampleDir, 'exit.json'), 'utf8')).toContain('"exitCode": 0')
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'harness',
          stage: 'result',
          runtimeMetadata: expect.objectContaining({ samplePath: sampleDir })
        })
      ])
    )
  })
})
