# Batch 4 核验（B4-L3：L1–L4、分段计时、push 提案）

核验对象：`685157a..d1acf80`，共 11 个提交，其中两条是我的核验 cherry-pick。提交身份全部是 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`。

方法：读 `status/b4-l3.md` 与 `P3e-first-token-push-proposal.md`，并对照 `daemon-run-runtime.ts`、`remote-gateway.ts`、`session-ledger.ts` 的源码检查。本轮没有在本机重跑测试或真实 App。

## 结论

L1、L3（帧到视图）、L4 都接受，`7588598`（被取消的 run 按 ledger 终态显示为结束）也接受。

L2 找到了真正的根因，但现在的修法让每个新 run 都要从 ledger 开头翻页，会话越长越慢，必须改。L1 的唤醒方式会把同一段文本传两次。

push 提案的方向可以考虑，但它所依据的分段计时只有 App 一侧的打点，几个数字和实测的 socket 往返对不上。在找到 daemon 侧的证据之前，还不能判断 push 能省下多少时间。

## 接受

| 项 | 说明 |
|---|---|
| L2 根因 | ledger 的 `since(cursor)` 按全局序号分页，每页 256 条；App 每次都从 `cursor: 0` 开始问，所以总是拿到最旧的那一页。复现测试修复前 28/31，修复后 31/31 |
| `7588598` | delta 从不下发 `done`，被停止的 run 一直显示为运行中。现在以 ledger 终态为准 |
| L1 根因与修复 | watch 只等 ledger 事件，而 Provider 写出文本时不会产生 ledger 事件；最后一次 snapshot 又会把已交付 item 的增长内容静默替换掉。修复后 snapshot 也按尾部增量发送。smoke 断言要求至少 8 次到达、间隔中位数在 80–250 ms。真实 App 收到 20 段递增文本，间隔 142–155 ms |
| L3 | daemon 帧到 App 视图会保留 `error`/`errorHint`，措辞与进程内一致。端到端为什么没跑，原因如实写了：fixture 轮次没有 Provider session，走 providerless 路径；仓库约定也不允许在开发仓库里驱动真实 Agent |
| S1 | 两种模式各 30 个样本，逐次更新间隔已经一致（P95 156 ms 对 167 ms）。首 token 未达成，如实写明，预算没有放宽 |

## 必须修

### E1 每个新 run 都从 ledger 开头翻页，开销随会话长度线性增长

`0ecd88d` 让每个 run 沿着自己上一次回复给出的 cursor 往后走，但新 run 的起点仍然是 `watch: 0`（`daemon-run-runtime.ts:125,176`），而 `poll` 返回的是**全局**页（`remote-gateway.ts:245`）。所以会话中第 N 个 run 要先翻过前面所有的页，才能看到自己的 bind 事件。

按每个 run 约 9 条事件、每页 256 条估算，ledger 压缩阈值（6 MB）以内可能积累上万条事件，也就是上百页。每翻一页就是一次 watch 往返，并且整页传输。后果是：首 token 随会话长度变慢，长会话里又会超过 3 s 的 bind 预算，再次出现 `daemon_run_not_bound`。这也违反了 CLAUDE.md 的“有上限、不重复做”。

S1 里 30 个连续样本只有约 270 条事件、2 页，所以没有暴露出来。

修法：

- 新 run 的起始 cursor 取本次 daemon 连接中**已见过的最大全局 cursor**（任何 run 的 watch 回复都会更新它）。如果提交回执能带回 intent 的序号就更好。
- 本 run 的事件一定在提交之后才写入，所以从这个位置开始不会漏事件。
- 测试：预置一个上万条事件的会话，新 run 应在 1–2 次 watch 内拿到 bind 事件；用控制实验证明，把起点改回 0 后测试会失败。

### E2 唤醒时把输出正文整页传一遍又丢掉

`10f69b1` 用 `watch(output: true)` 作为“内容到了”的唤醒信号（`daemon-run-runtime.ts:270-280`）。daemon 回复里带着输出 chunk 的正文，App 只看 `count` 就把正文丢掉，再单独读一次 trace。于是每段文本在 socket 上传了两次，而且输出正文可能远大于 trace 的增量。

PLAN P2 本来就规划了“watch 加一个不带 shadow output 的变体”。修法二选一：

- watch 支持只返回 `count`/`cursor`、不带正文的唤醒模式；
- 或者等下面 push 的决定：如果采用方案 A，“trace 变化即回复增量”会直接取代这种唤醒方式。

## push 提案：分段计时还不足以支撑结论

提案把增加的约 75 ms 拆成“两次往返约 40 ms + 一次唤醒再读取约 35 ms”。但同一台机器上，单次 unix socket 往返实测 P95 只有 3.89 ms（`daemon-trace-latency`），两次往返应该在 10 ms 以内。分段里还有几处空档说不通：

- `bound` 16.7 ms 到 `firstTrace` 39.7 ms 之间差 23 ms，P95 时首次 trace 读取甚至到了 114.7 ms；
- `submitted` 用了 16 ms，可能包括 ledger 的 fsync，这是必要的工作，但需要单独列出来；
- 首段文本前的“Provider 启动”在 daemon 里和在进程内的耗时是否相同，没有测过。daemon 里第一次 run 可能还要冷启动 `warmShellEnv`、spawn 的环境也不同。

所有打点都在 App 一侧，所以没法区分时间花在 daemon 内部（准入、fsync、dispatch、Provider 启动、trace 写入），还是花在投递上（唤醒、读取、App 收到）。push 只能缩短后一段。如果大头在前一段，做了 push 也达不到预算。

### 建议

先补 **daemon 侧打点**，与 App 共用墙钟（`performance.timeOrigin + performance.now()`，同一台机器上可以直接比较）：

1. daemon 收到 submit；
2. intent 落盘（fsync 之后）；
3. dispatch；
4. Provider 进程启动；
5. daemon 内首次看到 Provider 输出；
6. trace revision 变化；
7. watch 回复发出；
8. App 收到；
9. renderer 收到。

进程内路径也补对应的打点：Provider 启动、首次输出、renderer 收到。然后对比两条路径中“Provider 首次输出”之前和之后各自的差值。

- 如果大部分差值在“trace 变化 → App 收到”这一段，push（方案 A）有依据，可以批准设计；
- 如果大部分在 daemon 内部（dispatch 节奏、fsync、Provider 冷启动），就先在那里修，push 推后再议。

提案中“A 可以落到 +10~15 ms”是估计，提案自己也写明了。批准前需要上面的数据来支撑。

## 应修（不阻塞 L3）

**录制失败的端到端验证。** 现在只到了“帧 → 视图”这一层，原因是 fixture 走 providerless 路径。可以扩展 smoke fixture：让它产出原生 session id，从而走 managed recorder 路径，再注入一次落盘失败（例如把 `.scry/records` 设为只读），就能在不驱动真实 Agent 的情况下做端到端验证。B4-V 之前完成即可。

## 下一步

1. 修 E1（先写失败测试和控制实验）、E2（或者等 push 决定后一起处理）。
2. 补 daemon 侧与进程内的对照打点，重新做首 token 分段，结果写进提案。
3. 停下，等维护者根据新数据在 A、B、C 中选择。

## 维护者答复（2026-11-09）

push 提案：**先补 daemon 侧打点再定**。先修 E1、E2，再补 daemon 内部与进程内的对照打点（同一墙钟），重新拆分首 token 差值。差值主要在“trace 变化 → App 收到”的投递段时，再提交方案 A 供批准；主要在 daemon 内部时，先修那里。在此之前不改协议版本，预算不放宽。
