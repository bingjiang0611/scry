# 50k 用例超时后的正文捕获分配排查

## 范围与保留的失败

PR #63 的 CI run `43158362673` 在未修改的 `trace.main-50k` 五次样本上超过原 5000ms 期限（5074–5147ms）。按测试失败处理，没有重跑该 run。

固定 50k 条目、七阶段、五次重复、完整 literal-policy oracle、负对照、覆盖率范围和原期限均不变。不修改 collector、计数台账或门限。

## 诊断与取舍

- Node 22.22.1 / macOS arm64 的 worker CPU profile 显示正文捕获、描述符克隆和 GC 是成本来源之一。必须通过 Node 命令行传 profiler 参数才能进入 Vitest worker；只放到 NODE_OPTIONS 的首轮文件没有 worker 样本，不用它归因。
- 尝试复用元数据对象的 Object.assign 版本未得到通过证据，已撤销，不包含在交付 diff。
- 最终只删除两类临时分配：字符串不创建循环检测 Set；对象仍先取得完整 descriptor snapshot，但遍历其 keys，不再为每个 descriptor 创建 Object.entries 二元组。
- 对象的循环、深度、prototype、getter/toJSON 检查不变。仍用原 descriptor snapshot 检查 enumerable 和 value，并克隆为原来的安全对象；不缓存、丢字段或改变证据正文。

## 已观察到的证据与限制

两个新增分配回归在旧代码上均失败，恢复改动后通过：字符串的循环检测 Set 从 1 次变为 0 次；嵌套对象/数组不再调用 Object.entries，捕获结果仍完整一致。对象仍创建循环检测 Set。

正文、持久化、投影、delta 和 ingestion 的 13 文件、95 项合同回归通过。一次全量 unit 执行中，原 15 项 main collector（含五次 50k 和原 oracle）通过；整套执行在 20 分钟工具截止时中断，不能称为全量通过。还观察到两个未改 launcher 用例被本机注入的 UNDICI 实验性 stderr 警告污染；首轮日志保留。

负载回落后，最终 `npm run performance:measure -- --scenario trace.main-50k` 执行原 15 项 collector 通过；50k 指标保留五次重复，ratchet 通过。Node/Web typecheck、CLI 构建和 harness bindings 检查通过。

本机诊断期间负载显著变化，profile 前后均为 highLoad；候选计数采集也保留过一次 50k 超时。不能据此声称稳定毫秒收益、App L2 或日常 L3 改善。一次后续计时因其他 owner 持锁而退出 75，没有绕过锁。

L1 结论仅为上述临时容器不再创建，工作没有移到其他测量窗口。托管平台是否满足原期限，由 PR 当前提交的原 CI 给出；最新结果、完整日志索引及合入状态记录在 PR 中，不以较早的绿色 run 替代。
