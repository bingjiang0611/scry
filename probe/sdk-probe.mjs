// 一次性 probe（goal Step 1）：驱动真实 claude 会话，实测 RFC v2.4 假设的运行时行为。
// 跑完即删，不进套件、不进打包。用 node v22 + 完整 shell env 跑（认证靠 Keychain）。
// 实测点：① result 的 modelUsage/duration_api_ms/cache_creation/cache_read 真值
//        ② tool_use ↔ tool_result 配对（tool_use_id）
//        ③ forwardSubagentText:true 下 subagent message 是否带 parent_tool_use_id
//        ④ system task_started 的 task_id/tool_use_id
//        ⑤ query.usage_EXPERIMENTAL...() / canUseTool / interrupt / mcpServerStatus 是否可用
import { query } from '@anthropic-ai/claude-agent-sdk'

const CLAUDE = process.env.CLAUDE_BIN || `${process.env.HOME}/.nvm/versions/node/v22.22.1/bin/claude`
const log = (...a) => console.log(...a)

const prompt =
  '先用 Bash 跑 `echo probe-hi`。然后用 Task 工具启动一个 general-purpose 子 agent，让它用 Bash 跑 `echo from-subagent` 并回报。完成后只回一句「done」。'

const q = query({
  prompt,
  options: {
    permissionMode: 'bypassPermissions',
    forwardSubagentText: true,
    includePartialMessages: false,
    pathToClaudeCodeExecutable: CLAUDE
  }
})

// 探测 query 上的方法是否存在（不一定调，调危险的会卡）
const probeMethods = () => {
  const names = [
    'supportedCommands',
    'mcpServerStatus',
    'interrupt',
    'stopTask',
    'streamInput',
    'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'
  ]
  const present = {}
  for (const n of names) present[n] = typeof q[n] === 'function'
  log('## query methods present:', JSON.stringify(present))
}

let usageProbed = false
const seen = { assistant: 0, user_tool_result: 0, task_started: 0, subagent_msgs: 0 }
const toolUseIds = new Set()
const toolResultIds = new Set()

const t0 = Date.now()
try {
  for await (const m of q) {
    const type = m.type
    const sub = m.subtype
    if (type === 'system' && sub === 'init') {
      probeMethods()
      // init 后试一次 usage_EXPERIMENTAL（看是否 mid-stream 可调）
      try {
        const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
        if (typeof fn === 'function') {
          const u = await fn.call(q)
          log('## usage_EXPERIMENTAL @init:', JSON.stringify({ session: u?.session, subscription_type: u?.subscription_type }))
          usageProbed = true
        }
      } catch (e) {
        log('## usage_EXPERIMENTAL @init FAILED:', e?.message)
      }
    }
    if (type === 'system' && sub === 'task_started') {
      seen.task_started++
      log('## task_started:', JSON.stringify({ task_id: m.task_id, tool_use_id: m.tool_use_id, subagent_type: m.subagent_type }))
    }
    if (type === 'assistant') {
      seen.assistant++
      const msg = m.message || {}
      const blocks = Array.isArray(msg.content) ? msg.content : []
      const kinds = blocks.map((b) => b.type)
      const tu = blocks.filter((b) => b.type === 'tool_use')
      for (const b of tu) toolUseIds.add(b.id)
      const isSub = m.parent_tool_use_id != null
      if (isSub) seen.subagent_msgs++
      log(
        `## assistant#${seen.assistant}:`,
        JSON.stringify({
          message_id: msg.id,
          parent_tool_use_id: m.parent_tool_use_id,
          subagent_type: m.subagent_type,
          block_kinds: kinds,
          tool_uses: tu.map((b) => ({ id: b.id, name: b.name }))
        })
      )
    }
    if (type === 'user') {
      const blocks = Array.isArray(m.message?.content) ? m.message.content : []
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          seen.user_tool_result++
          toolResultIds.add(b.tool_use_id)
        }
      }
    }
    if (type === 'result') {
      log(
        '## RESULT:',
        JSON.stringify(
          {
            subtype: sub,
            total_cost_usd: m.total_cost_usd,
            duration_ms: m.duration_ms,
            duration_api_ms: m.duration_api_ms,
            usage: m.usage,
            modelUsage: m.modelUsage,
            num_turns: m.num_turns
          },
          null,
          2
        )
      )
    }
  }
} catch (e) {
  log('## STREAM ERROR:', e?.message)
}

log('## SUMMARY:', JSON.stringify(seen))
log('## tool_use ids:', [...toolUseIds])
log('## tool_result ids:', [...toolResultIds])
const paired = [...toolUseIds].filter((id) => toolResultIds.has(id))
log(`## pairing: ${paired.length}/${toolUseIds.size} tool_use 有配对 tool_result`)
log(`## elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s, usageProbed=${usageProbed}`)
