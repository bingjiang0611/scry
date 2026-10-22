# 2026-10-22 Qoder：过期模型目录不再复用初始化快照

## 决定与范围

用户继续核对 Qoder 常驻合同，且只允许修改 Scry。当前 SDK 1.0.17 没有可证明覆盖模型、命令、Skill、启动配置与认证的统一刷新接口。因此不延长控制实例寿命，也不通过运行时 mutation 或 prompt 冒充只读重载。

检查发现已有正确性问题：`initializationResult()` 永久复用初始化 Promise；`supportedCommands()` 也返回初始化命令。控制实例被其他查询持续保留时，原模型缓存 30 秒过期后，旧代码仍优先读取 initialized.models，并将它按新观察时间重新缓存。这不是当前目录。

## 实现

- `5d11ab5`：模型缓存 MISS 时始终调用 `getAvailableModels({ fetchStrategy: 'live' })`；保留原模型映射、effort、默认值与禁用能力，不退回初始化快照。
- 有效 live 空列表保持 ready+[]；读取失败保持 degraded/unavailable，不用旧模型伪装成功。失败后下一次显式读取可再次查询，不缓存失败。
- 仅 never-fed 的发现控制查询设置 `persistSession:false`，正式用户运行/恢复/认证路径不变。这限制会话持久化，不等于操作系统文件只读或安全沙箱。
- 回归提交 `36ee5f1`；调用点简化 `dddc43e` 去掉单一用途的额外 options 参数。只修改 qoder.ts / qoder.test.ts。
- 保留原 5 秒空闲回收、30 秒 catalog TTL、请求/初始化期限与配置失效代次栅栏。没有新增依赖、全局配置或永久后台轮询。

## 原生合同依据

路径均相对于 `node_modules/@qoder-ai/qoder-agent-sdk/`：

- `dist/index.js` 的 QueryRunner 缓存 initializationPromise；`initializationResult`、`supportedCommands` 使用该结果。
- `dist/types/options.d.ts` 的 getAvailableModels 明确为最新模型列表，按已有 session scene 过滤；实现转发 `get_models` 与 fetchStrategy。`dist/protocol/common.d.ts` 包含 efforts/defaultEffort 等完整模型字段，因此无需依赖旧初始化信息补齐。
- `getContextUsage` 是当前上下文证据，并不保证完整已安装 Skill catalog。`reloadPlugins` 的响应仅含 commands/agents/plugins/MCP/error_count，不含完整模型、配置或账号；不是通用刷新合同。
- `accountInfo` 在请求失败时可退回初始化账号；成功返回本身不证明认证刚刷新。启动环境及认证参数也不能由局部 reload 自动替换。

## 验证

| 检查 | 结果与证据 |
| --- | --- |
| 新回归对旧生产代码的负对照 | 相同新测试有 6 项失败，第一项为 live effort/default 模型来源；原始 `/tmp/qoder-old-negative.log` 与 worker transcript 保留。不改变期限或跳过断言 |
| 本机 focused / 类型 | Qoder 87/87；完整 typecheck 通过。新增 TTL 到期且其他 facet 保持控制实例活跃、live 空值、失败不复用旧值、发现 prompt 无输入与关闭回归 |
| mac2 冻结版本 | `dddc43e9530cc769b4a89b0c36250bfc7e38dde4`，独立 `/Users/test/scry-provider-control-mac2.IEatqT/source`；原仓库/App/配对与用户数据未改 |
| mac2 完整 unit | **3496 pass / 4 既有 opt-in skipped**，290 文件；`qoder-freshness-unit.log` |
| mac2 类型 / build | 均通过；`qoder-freshness-typecheck.log`、`qoder-freshness-build.log` |
| mac2 原完整性能计数 | 43 observations，ratchet 通过；`qoder-freshness-performance.log`；未改台账、升门禁或放宽上限 |

日志在远端临时根 `logs/`，并复制到本机 `/tmp/scry-provider-control.UGpNzU/` 对应文件。只使用受控 SDK mock，没有实际 Qoder 模型请求、付费探针或真实账号。此修复会在缓存 MISS 时增加必要的 live control 请求，用于获得当前证据；不是减少工作的性能实验，不宣称 L2 提速。原有性能计数没有覆盖这项 Qoder control 消息数量，不拿其 ratchet 通过当成本项没有额外工作的证明。

## 剩余边界

这是 Qoder 模型来源正确性修复，不是 Qoder 长期常驻完成。Skill 元数据仍受初始化/上下文证据限制；命令初始化快照不具备完整只读更新合同。认证、启动配置、环境变化需要有效的重启/失效边界，不能仅靠 live models 或 reloadPlugins 推断所有能力已刷新。

后续由性能 owner 先为初始化证据建立可验证的最大寿命/失效方案，或取得原生完整刷新合同，再讨论延长控制实例寿命。Pi 保持新进程探测；完整方案 A 仍未完成。本轮仅本地提交，未合入、push、安装或真实设备重放。
