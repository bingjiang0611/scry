# LLM 会话性能

在会话顶部点击 **LLM 性能 → 对比**。发送前设置“下次运行的网络标签”，如“直连”“VPN A”。标签是用户备注，不检测或改变 VPN。已发送轮次的标签不会因后续编辑而变化。

只观察正常的本机 App 会话；不额外调用 LLM、不发送付费探针。远程运行与旧历史若没有测量证据，不补造数值。

## 指标口径

| 指标 | 来源与范围 | 不代表什么 |
| --- | --- | --- |
| 实时字符/s | 主会话真实文本 delta，最近 3 秒接收量 / 3 秒；无后续输出时衰减到 0 | token/s、网络带宽或服务端解码速度 |
| 首次输出等待 | 本轮本地执行接受 → 首个主会话文本输出；单调时钟计时 | 单次 HTTP 请求的 TTFT；其中包含启动、排队、本地检查等开销 |
| 接收均速 | 主会话收到的流式文本字符 / 各可计时文本片段首末 delta 间隔之和 | 纯模型生成吞吐；片段内部的停顿、推理也影响结果 |
| 本轮 API 吞吐 | canonical 本轮输出 token / Provider 报告的累计 API 时间 | 实时 token 速度；包含 prefill/推理，可包含 Provider 计入的子代理用量 |

- 文本字符按 delta 中的 Unicode code point 计数，不把一条消息块算作一个 token，不从字符数估算 token。
- 工具执行、已观测的请求结束、主会话 message identity 切换和审批返回会切断文本计时片段。没有边界的内部等待无法单独分离。
- 子代理文本不参与主会话文本速度。完整 assistant snapshot 不重复计数。Pi 的非流式 completion fallback 显式标记为 buffered；OpenCode retry replacement 仅计新收到的真实 delta。
- 单个 delta 或零间隔片段无法证明均速。包含这种片段的轮次不提供接收均速，不用 Infinity 或 0 代替未知。
- API 口径复用 canonical usage selection：Claude continuation 是累计快照，只取最新值；其他 Provider 的增量结果累加。每条结果必须都有对应 API 时间与输出量，才提供 API 吞吐。不使用“墙钟减去工具时间”推算生成速度。
- 模型优先使用 Provider 用量证据。没有实际身份时可显示“所选：…”（请求配置，不保证实际模型），否则明确显示未知；多模型轮次不猜一个模型。upstream 厂商只使用明确证据，不把 CLI Provider 当成厂商。

## 历史与对比

测量在 Provider promise 收口后记录，失败、停止轮次保留但不参与成功样本中位数。轮次没有结果或 token 时仍能保存本地测量，API 速度保持未知。进程崩溃、未收口的执行不保证有终态测速记录。

- 复用 `userData/usage.jsonl` 的 ownership 与 session 删除路径；`kind: llm_performance` 行不会计入计费统计或 turn 计数。没有建立第二个 DB 或 recorder 事实源。
- Trace event 携带本地观测快照；经过 coalescing、恢复和 archive roundtrip 后保留测速数据与冻结标签。该快照不是 Provider canonical token 证据。
- 历史视图读取最近 30 天最多 1000 个轮次，按网络标签、Provider、Profile、upstream 厂商和模型分组；显示样本数与各指标可用轮数，缺失为 `—`。有损坏行或截断时明确提示部分证据。
- 扫描 JSONL 是流式的；IPC 返回量有界。若实测扫描延迟不可接受或需要更长历史，升级到现有 SQLite 投影并保留相同口径与删除归属，而不是继续扩大 IPC 上限。
- 网络标签输入只在当前 App 进程中记忆；历史中的已发送标签持久保存。

正常会话的比较是观察性结果。固定提示词、上下文、缓存与推理设置，再重复采样。中位数与手动标签不能证明 VPN 是差异的原因；不同输出语言的字符速度也不能直接当作模型能力排行。

## 检查入口

```sh
npm run test:unit -- src/main/llm-performance.test.ts src/main/llm-performance-history.test.ts
node scripts/session-capability-ui-smoke.mjs --performance-only
npm run typecheck
npm run build
```

隔离 Electron fixture 使用生产 App 与 observer，验证真实鼠标/键盘输入、发送参数的标签捕获、实时/终态数值、历史错误以及深浅主题；不启动真实 Provider。临时文件测试验证 archive roundtrip、历史读取、session 删除及计费不双计。真实厂商/VPN 对比需要用户正常运行或另行授权真实探针，不能用 fixture 替代。
