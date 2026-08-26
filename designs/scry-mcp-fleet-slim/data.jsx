/* Fixture mirroring the real QODER/rate-native session in the screenshot.
   Shapes match production: McpMeta (shared/provider.ts:98), McpLiveStatus (shared/trace.ts:78),
   McpStatus (renderer/format.ts:106). */

const FLEET_MCPS = [
  {
    targetId: 'clarification-reporter',
    name: 'clarification-reporter',
    scope: 'user',
    transport: 'stdio',
    detail: 'node',
    enabled: true
  },
  {
    targetId: 'arthas',
    name: 'arthas',
    scope: '.mcp.json',
    transport: 'http',
    detail: 'https://mcp.alibaba-inc.com/arthas/mcp',
    enabled: true
  },
  {
    targetId: 'arthas-attach',
    name: 'arthas-attach',
    scope: '.mcp.json',
    transport: 'http',
    detail: 'https://mcp.alibaba-inc.com/arthas-attach/mcp',
    enabled: true
  },
  {
    targetId: 'upp-hub',
    name: 'upp-hub',
    scope: '.mcp.json',
    transport: 'http',
    detail: 'https://mcp.alibaba-inc.com/upp-hub/mcp',
    enabled: true
  },
  {
    targetId: '3eye-device-control',
    name: '3eye-device-control',
    scope: '.mcp.json',
    transport: 'http',
    detail: 'https://3eye.alibaba-inc.com/mcp/device-control',
    enabled: true
  },
  {
    targetId: 'ai_native_trace_report',
    name: 'ai_native_trace_report',
    scope: '.mcp.json',
    transport: 'http',
    detail: 'https://ai-native.alibaba-inc.com/mcp/trace-report',
    enabled: true
  },
  {
    targetId: 'chrome-devtools',
    name: 'chrome-devtools',
    scope: '.mcp.json',
    transport: 'http',
    detail: 'https://devtools.alibaba-inc.com/mcp',
    enabled: false
  }
]

const FLEET_LIVE = [
  { name: 'clarification-reporter', status: 'nonsense-state' },
  { name: 'arthas', status: 'connected', tools: 30 },
  { name: 'arthas-attach', status: 'connected', tools: 3 },
  { name: 'upp-hub', status: 'connected', tools: 166 },
  { name: '3eye-device-control', status: 'connected', tools: 30 },
  { name: 'ai_native_trace_report', status: 'connected', tools: 4 },
  { name: 'chrome-devtools', status: 'needs-auth' }
]

/* 只有 manage 能力的 Provider 才有本次测试证据；read-only Provider 下这份 map 为空。 */
const FLEET_TEST_STATUS = {
  arthas: {
    ok: true,
    tools: 30,
    toolNames: [
      'arthas_dashboard', 'arthas_thread', 'arthas_jvm', 'arthas_sc', 'arthas_sm',
      'arthas_jad', 'arthas_watch', 'arthas_trace', 'arthas_stack', 'arthas_tt',
      'arthas_monitor', 'arthas_profiler', 'arthas_heapdump', 'arthas_ognl', 'arthas_vmtool'
    ]
  },
  'arthas-attach': { ok: false, error: 'initialize timeout' },
  'upp-hub': { ok: false, error: 'HTTP 401 Unauthorized' },
  '3eye-device-control': { testing: true },
  ai_native_trace_report: { authOk: true }
}

/* stdio 的 clarification-reporter 不在其中，对应截图里那行的「Scry 不支持」 */
const FLEET_AUTHENTICATABLE = [
  'arthas',
  'arthas-attach',
  'upp-hub',
  '3eye-device-control',
  'ai_native_trace_report',
  'chrome-devtools'
]

const FLEET_CAPABILITY = {
  read: {
    providerId: 'qoder',
    state: 'ready',
    mode: 'read',
    data: { runtime: FLEET_LIVE, operations: { authenticate: FLEET_AUTHENTICATABLE } }
  },
  manage: {
    providerId: 'claude',
    state: 'ready',
    mode: 'manage',
    data: { runtime: FLEET_LIVE, operations: { authenticate: FLEET_AUTHENTICATABLE } }
  }
}

Object.assign(window, { FLEET_MCPS, FLEET_LIVE, FLEET_TEST_STATUS, FLEET_CAPABILITY })
