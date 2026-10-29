# 2026-10-28 Pi 目录常驻工作集与定向失效

## 假设

当前 packaged build `c816f72482cd57ceb5b46c8f4c6af3abfb83df4db76f887dc13b0b40b43a318d`
的 34 次成功 `pi.catalog.probe` 中，26 次启动新进程，只有 8 次复用：

| 路径 | n | p50 | p95 |
|---|---:|---:|---:|
| 冷启动 probe | 26 | 1672.5 ms | 3111.0 ms |
| 活进程复用 probe | 8 | 9.4 ms | 13.5 ms |

四条 RPC 本身已低于 100 ms。一个可证明的重复冷启动来源是：刷新一个上下文会关闭所有
工作区的目录进程，导致无关工作区也再次支付 Pi CLI 冷启动。

假设：保留原 60 秒 freshness 边界，但只失效匹配的工作区，可让仍在有效窗口内的其他
工作区继续走 5.9–19.5 ms 的活进程路径。

## 基线测量

测量提交：`a7ed3dcb`。

固定负载：两个工作区各探测一次，失效工作区 A，再访问工作区 B。

`providers.pi-probe-isolated-invalidation/subprocess.rpc` 五次均为 `3`。原因是旧实现的
`invalidateContext()` 调用全局 `disposePiCatalog()`，工作区 B 的健康进程也被关闭。

## 改动

- `src/main/providers/pi-catalog.ts`
  - 保留原 60 秒空闲回收，并把驻留工作集明确限制为最多 8 个目录进程。
  - 每次读取仍发送 `get_state`、`get_available_models`、
    `get_available_thinking_levels`、`get_commands`，不返回固化目录快照。
  - 新增按 `cwd + profile` 的定向失效；没有 cwd 时仍全量关闭。
- `src/main/providers/pi.ts`
  - `invalidateContext()` 只关闭匹配的目录进程；运行会话池仍按原合同失效。

显式刷新仍会重新启动目标工作区，失败读取仍立即关闭，adapter dispose 仍关闭全部进程。
60 秒回收继续限制 startup-loaded Pi 资源的存活时间；工作集上限只限制驻留资源，不放宽
Pi 项目信任或 Scry trust gate。

## 结果

| 指标 | 基线 | 候选 | 变化 |
|---|---:|---:|---:|
| 隔离失效负载的 RPC 子进程 | 3 | 2 | -33.3% |

五次候选采集均为 `2`，`performance:measure --compare a7ed3dcb` 判定 `measured`，ratchet 通过。
工作量减少的位置：工作区 A 刷新后，仍在 60 秒有效窗口内的工作区 B 不再重复启动 Pi CLI；
没有把启动挪到测量窗口外。

## 验证级别与限制

- L1：已验证，子进程 `3 → 2`，无同场景 worse。
- L2：候选的复用路径没有单独重新计时。当前运行 build 的真实复用样本 p95 为 13.5 ms；
  既有 rotom Pi 受控实验为冷启动中位 439 ms、复用中位 2 ms，但当时机器高负载。
- L3：未构建、未安装、未收集候选日常记录。
- 冷启动第一次访问和空闲超过 60 秒后的访问仍超过 100 ms。达到“所有 Scry 目录读取低于
  100 ms”还需要在用户请求前预热选中上下文，或提供有完整 freshness 边界的目录 generation；
  本实验只消除不相关失效造成的重复冷启动。

## 交付状态

- 优化源码：`147112aa`。
- 合入：未合入。
- 构建：未构建。
- 安装/生效：未安装。
