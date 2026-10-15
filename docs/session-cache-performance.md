# T3 Code 借鉴：会话热快照与增量计算

参考固定版本：[`pingdotgg/t3code@7ac952c`](https://github.com/pingdotgg/t3code/tree/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae)。Markdown 改编代码的 MIT 许可保存在 `THIRD_PARTY_NOTICES.md`。未引入新的依赖、状态管理或虚拟列表框架；复用现有合批、ACK、窗口化和工具正文外置机制。其他历史窗口化/最近目录优化见 [多会话性能边界](session-performance.md)，其收益不能与本次不同源码的数字相加。

## 实现与边界

| 项目 | 实现 | 保留的权威边界 |
| --- | --- | --- |
| 最近会话热快照 | `session-history-cache.ts`；最多 8 项、40 轮/项、16 MiB UTF-16 JSON 估算、闲置 5 分钟。仅缓存最近页，不缓存 `done:false` 轮次。Provider/profile/cwd/native session 隔离。 | 命中标记“待核对”，仍走正常 main 读取；核对前禁发消息和分叉。失败清显示；数据更新清缓存并使在途写入失效。没有后台订阅或新 Provider 运行。 |
| Claude transcript | `transcript-file-cache.ts` 与完整解析共用 `normalize.ts` reducer；仅提交换行完整记录，无换行尾部在分支上预览；返回深拷贝。 | 每次共享读取校验文件身份、前后 metadata 和完整 SHA-256；增量要求完整已提交前缀一致。仍读取/hash 全文件，节省的是 JSON 解析，不是前缀 I/O。不替代 cwd/catalog/remote 授权。 |
| Worker 生命周期 | 小文件在 main 缓存；≥4 MiB 使用一个持久热 Worker。两个解析缓存**各自**最多 8 项/32 MiB 序列化记账、闲置 5 分钟；不是全 App 的 32 MiB 堆上限。 | request ID 隔离响应；取消一个消费者不取消另一个；无消费者可终止；idle unref；退出显式 dispose；代际检查阻止等待 stat 的请求在 dispose 后重新启动 Worker。main 退出时拒绝进入解析。 |
| 流式 Markdown | `markdown-incremental.ts`；只复用已闭合顶层代码围栏及空行之前的 pristine AST。 | 引用/脚注定义、CRLF/BOM 和未知前缀完整重算；保留 GFM、文件链接变换、采样和超大正文降级。普通文章不承诺收益。新语法插件须先证明无跨前缀依赖。 |
| 流式投影 | `format.ts` 记录 immutable 数组的确切 predecessor/最早改动位置，`turn-stream-projection.ts` 复用结构前缀和未变 tail。WeakRef 不保留历史数组链。 | 只有确切 predecessor 匹配才能跳扫描；未知数组、结构更正/移除/终态仍完整检查。数组复制和 React/DOM 工作未变成 O(1)。 |

`useAgentSession.ts` 明确区分 display-only cache 与权威安装。缓存安装先消费排队 trace 并隔离旧 run；核对期间不自动接纳旧 trace、问题、生命周期或旧 run 的恢复快照，也不确认 live trace 已恢复。只有当前 main 返回完全相同的 page 且安装身份未被 focus/start/clear 替代，才能原地确认。新的权威 live focus 清除缓存来源标记；旧读取不能覆盖它。

Claude 桌面读取及已有 legacy remote 历史读取复用同一解析入口。其他 Provider 的原生历史/能力差异保持原样；renderer 快照不是 Provider capability parity。缓存不写磁盘，不代替 archive、recorder record 或当前运行状态。记账上限不包含瞬时文件 buffer、IPC 克隆、当前可见历史或精确 JS 堆；若这些成为瓶颈，应先测量再扩展已有源级分页，不能截断证据。

## 可复现检查

```sh
npm run test:unit -- src/main/normalize.test.ts src/main/transcript-file-cache.test.ts src/main/transcript-parser.test.ts src/renderer/session-history-cache.test.ts src/renderer/markdown-incremental.test.ts src/renderer/turn-stream-projection.test.ts src/renderer/format.test.ts
npm run typecheck
npm run build
npm run test:renderer:ui
node scripts/transcript-cache-worker-smoke.mjs
node scripts/cache-compute-bench.mjs # Node >=22.18，原生 TypeScript type stripping
node scripts/session-open-bench.mjs short-heavy
node scripts/session-open-bench.mjs paged
```

`session-cache` 已接入默认 renderer UI gate，也可单独运行 `node scripts/session-capability-ui-smoke.mjs --cache-only`。隔离 Electron 使用生产 App/React 和受控 bridge，通过 Chromium 原生点击、输入及 Enter 检查缓存先显示、锁定发送/分叉、刷新、失败/删除、迟到响应、草稿，以及 live focus supersession。fixture 在真实侧栏点击的 capture 阶段注入已排队 trace，再注入迟到 trace/health；分别故意移除 authority guard、trace gate 和 buffered flush 时，三个独立控制均按预期失败。Worker smoke 使用实际 client 源码及生产 Worker，不替代解析/传输；覆盖 namespace、取消并发消费者、dispose 和 idle 自然退出。

## 测量范围

本机 macOS arm64 / Node 24.18.0 / Electron 42.10.1 / App 0.2.186，离线合成数据，无真实模型调用。详细原始样本与源码/产物摘要见 [验证 JSON](session-cache-validation.json)。最终门禁在 HEAD `5b8bd0c` + 本任务明确文件清单的干净副本运行，排除其他任务 WIP：2812 tests / 225 files 通过，3 个需账号探针显式关闭；typecheck、build、完整 renderer UI（含 Credits）及真实 Worker smoke 通过。

- Markdown：39,221 字符闭合代码前缀、60 次追加；parse 中位数 256.750 → 14.452 ms（17.77×）。强制启用插件的普通文章对照 1051.251 → 1131.684 ms，**无收益且有开销**；生产无围栏路径不启用插件。120 个 AST 与完整解析等价。
- 投影：10,000 个结构事件、500 次更新；确切 predecessor 对照完整前缀扫描，6.260 → 0.225 ms（27.86×）；500 个投影等价。该微基准不含 `applyTraceBatch` 数组复制、React 或 DOM。
- 6,412,360 字节 transcript：热命中解析 0 字节，追加只解析 330 字节；仍校验完整文件。冷读包含 Worker 启动，不把它与热命中之比宣传成纯算法加速。
- 完整 App 的固定源码控制只禁用 renderer 热快照命中，保留其他并行优化。首个匹配时间线 layout 与最终权威就绪分别计时；前者不是光学首屏截图，也不是允许发送的时间。较重的 20 轮历史按控制→候选→候选→控制执行，每组 24 个 warm opens；120 轮分页场景各 12 个。原生输入、分页、草稿、快速切换及进程退出均另核对。

完整 App：较重 20 轮首个匹配 layout 96.45 → 43.60 ms，最终核对 113.25 → 108.05 ms；120 轮分页首个 layout 50.90 → 13.95 ms，最终核对 70.00 → 65.75 ms。前期同源码其他运行中，最终核对也出现过约 0.3–12 ms 的额外开销。不能承诺所有场景统一加速：快照明显提前显示正文，不等于核对或整个 App 同倍数提速。它不是线上 p75、真实 Provider、多小时内存 soak 或 `/Applications/Scry.app` 的性能承诺。本次不安装、不重启承载真实会话的 App。

开发失败保留：早期 fixture 缺少 detectFast；native input 未等焦点提交导致草稿为空；首次 client smoke 未复制 Vite split chunk；实际复核发现缓存提前确认恢复、旧 trace 混入、dispose/stat 重启 Worker，以及 live focus 沿用缓存来源标记。这些均有对应修复和回归，不以重跑通过覆盖首轮失败。
