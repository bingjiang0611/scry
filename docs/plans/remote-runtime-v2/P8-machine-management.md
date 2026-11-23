# P8 · 机器管理：查看各台机器的 CPU、内存和磁盘（设计稿）

状态：草稿，待维护者确认 §10 的未决项。日期 2026-11-23。

## 1. 目标与非目标

**目标**：在 App 里，一眼看清本机和每个执行目标（mac2、mac3 等）现在忙不忙、资源够不够，以及 Scry 自己占了多少资源。

**第一版要回答的问题**：
- 这台机器的 CPU 和内存现在吃紧吗？磁盘快满了吗？
- Scry 的后台服务和它启动的 Provider 进程，一共占了多少 CPU 和内存？
- 这台机器上正在跑几个运行，在线吗，开机多久了？

**非目标**（第一版不做）：
- 从界面上结束进程或重启服务；
- 历史曲线和告警；
- GPU、电池、网络流量；
- 按会话拆分的进程明细（等 W20 C1 落地后作为第二版，见 §8）。

## 2. 用户看到什么

入口：把设置里现有的「主机」列表（`src/renderer/components/HostsView.tsx`，现在只列已保存的出站桌面连接）扩展为「机器」页。

- 页面顶部固定一张「本机」卡片，下面按顺序列出每个已保存的执行目标。
- 每张卡片显示：
  - 一行状态：在线/离线、开机时长、正在运行几个运行。
  - 四个横条：CPU、内存、交换区、磁盘。
  - 一行「Scry 占用」：后台服务和 Provider 进程的 CPU 与内存合计。
- 点开卡片看明细：
  - 按 Provider 汇总的进程数、CPU、内存；
  - 每块被统计的磁盘（Scry 数据盘、工作区所在盘）各自的余量；
  - 采样时间。
- 刷新方式：打开页面时读一次，右上角有刷新按钮，并显示「x 秒前更新」。第一版不做自动刷新，原因见 §6。
- 离线或旧版本的宿主：卡片显示「离线」或「该主机版本不支持，请升级」，不显示空数据。读取失败时显示原因，不显示 0。

```
┌ 机器 ────────────────────────────────────── 刷新 ↻  3 秒前 ┐
│ ● 本机  MacBook Pro · 在线 · 开机 3 天 · 运行中 2         │
│   CPU   ██████░░░░ 58%   负载 4.1 / 10 核                  │
│   内存  ████████░░ 82%   压力：中        交换 1.2 GB      │
│   磁盘  ███░░░░░░░ 余 312 GB（数据盘）                     │
│   Scry  后台服务 0.8% · 210 MB；Provider 3 个进程 · 1.4 GB │
├────────────────────────────────────────────────────────────┤
│ ● mac2  在线 · 运行中 0   CPU 4%  内存 41%  磁盘余 88 GB   │
│ ○ mac3  离线（12 分钟前）                                  │
└────────────────────────────────────────────────────────────┘
```

iPhone：第一版只在设置里展示所连宿主的这一张卡片（只读）。是否放进第一版，见 §10。

## 3. 指标定义

所有数值都附带采样时间。采不到的字段记为 `null`，界面显示「不可用」，不显示 0。

| 指标 | 含义 | macOS | Linux |
|---|---|---|---|
| CPU 使用率 | 两次采样之间，全部核心的平均占用 | `os.cpus()` 两次取差值 | 同左 |
| 负载 | 1 分钟平均负载 / 核数 | `os.loadavg()` | 同左 |
| 内存已用 / 总量 | 「可用」按系统口径计算，不用 `os.freemem()` | `vm_stat`：可用 = free + inactive + speculative + purgeable | `/proc/meminfo` 的 `MemAvailable` |
| 内存压力 | 低 / 中 / 高 | `sysctl kern.memorystatus_vm_pressure_level` | PSI：`/proc/pressure/memory` 的 avg10 |
| 交换区已用 | — | `sysctl vm.swapusage` | `/proc/meminfo` |
| 磁盘余量 | 只统计 Scry 数据目录和已授权项目根所在的卷，按卷去重 | `fs.statfsSync` | 同左 |
| 开机时长 | — | `os.uptime()` | 同左 |
| 后台服务占用 | 后台服务进程自己的 CPU 和常驻内存 | `process.cpuUsage()` 取差值、`process.memoryUsage().rss` | 同左 |
| Provider 占用 | 后台服务的子进程树，按 Provider 汇总进程数、CPU、常驻内存 | `ps -axo pid,ppid,rss,%cpu` 一次取全表，按父子关系归属 | `/proc/*/stat` |
| 运行数 | 正在运行和排队中的运行数 | 读 projection（`orch_p_run`） | 同左 |

为什么 macOS 不用 `os.freemem()`：它只算完全空闲的页，平时会显示「内存用了 95%」，结论是错的。必须按 `vm_stat` 计算可用内存，或者直接看内存压力。

Provider 归属规则：只有后台服务的子孙进程才计入，按启动它的 Provider 分组。无法确定归属的子进程计入「其他」。命令行参数一律不读取，也不保存。

## 4. 采集

- 在 daemon 里新增 `HostMetricsSampler`。放在 `src/daemon/`，因为它要调用 `ps`，而 App 主进程不允许调用 `child_process`。
- **按需采样**：只有收到读取请求时才采样，结果缓存 5 秒，两次采样之间至少隔 2 秒。没人看这个页面时，开销为零。
- CPU 使用率要用两次采样的差值。第一次请求时内部先采一次，隔 500 ms 再采一次；之后都用和上一次缓存的差值，所以每次只需要采一次。
- **单次采样的成本上限**：一次 `ps` 调用加几个 `sysctl` 和 `statfs`，目标 p95 小于 50 ms。`ps` 的输出截断在 2 MiB 以内。超时 2 秒，超时的字段记为 `null`。
- **不能拖慢运行**：采样的子进程优先级降低（`nice`）；采样期间如果正好有运行在启动，不阻塞它。

## 5. 协议

**本机 App**：新增 daemon 本地接口 `hostMetrics:read`，注册在已有的 daemon 本地接口表里（`src/main/daemon-local-ops/`）。App 主进程不新增模块，模块数保持在 192 以内。

**远程（执行目标、iPhone）**：
- 新增只读接口 `hostMetrics`，声明能力位 `hostMetrics: 1`。旧宿主不声明这个能力，界面就显示「请升级」。
- 协议版本不变，仍是 v3，这只是能力的增量。
- Desktop 经执行目标网关转发：新增 `desktopRemote:hostMetrics`，加入转发白名单；只有目标声明了这个能力时才转发。

**返回结构**（大小有上限，不超过 8 KiB）：
```ts
interface HostMetricsSnapshot {
  sampledAt: number; uptimeSec: number | null
  cpu: { percent: number | null; cores: number; load1: number | null }
  memory: { totalBytes: number; usedBytes: number | null; pressure: 'low' | 'medium' | 'high' | null; swapUsedBytes: number | null }
  disks: Array<{ role: 'data' | 'workspace'; totalBytes: number; freeBytes: number }>
  scry: { daemon: { cpuPercent: number | null; rssBytes: number }
          providers: Array<{ providerId: string; processes: number; cpuPercent: number | null; rssBytes: number }> }
  runs: { active: number; queued: number }
}
```

**权限与隐私**：
- 每次请求都重新校验授权。
- remote scope（iPhone、Desktop 远程）只返回上面这份汇总，不返回 PID、进程名、路径或卷名；磁盘只带 `role`。
- 本机 App 可以额外带 PID，用于明细里显示（第一版的明细也不显示命令行）。
- 每台设备每 2 秒最多读一次，超出的请求直接返回缓存。

## 6. 刷新方式

P4-5b 之后，静态检查禁止 renderer 里出现远程读取的轮询循环。所以第一版只在打开页面时读一次，再加一个手动刷新按钮。

第二版（W20 之后）：
- 在订阅协议里新增 `machines` 视图。有订阅者时，宿主每 5 秒发一次易失提示，客户端收到后再读，这和现有 hint 加读取的模式一致。
- 没有订阅者就不采样。

## 7. 和 W20 的边界

第一版**不改**以下文件，避免和 W20 冲突：
- 订阅引擎、订阅 hub：`subscribe-*.ts`；
- `orch_*` 表结构；
- Provider 适配器；
- `run-*.ts`；
- outbox 和派发器。

只新增文件，以及在两张表里各加一行：本地接口表、转发白名单。

需要动 `src/daemon/host-process.ts` 时，只加一行挂载 sampler 的代码。推送前先合并 W20 的最新提交。

## 8. 第二版（W20 C1 之后）

- **按会话拆分**：每个常驻 ProviderSession 的进程、CPU、内存和空闲时长，委派子会话单独标出。
- **实时推送**：`machines` 订阅视图。
- **操作**：释放某个空闲的 ProviderSession，或回收卡住的共享进程（复用 W20 A5 的逻辑）。这需要本机授权，并弹出原生确认框。
- **可选**：最近 1 小时的简单曲线（只存在 daemon 内存里，不落盘）、阈值提醒（例如内存压力为高时在卡片上标红）。

## 9. 测试与验收

- **单元测试**：
  - 用夹具文本测试 `vm_stat`、`sysctl` 和 `/proc/meminfo` 的解析，包括字段缺失的情况。
  - CPU 差值计算。
  - 进程树按 Provider 归属，包括无法归属和 PID 复用的情况。
  - 缓存与限速。
  - remote scope 的脱敏：断言返回里没有 PID、路径、卷名。
- **集成测试**：
  - 临时 HOME 下真实启动 daemon，读取 `hostMetrics`，字段齐全，`null` 的语义正确。
  - 旧宿主不声明能力位时，界面显示「请升级」。
  - 经 Desktop 转发读到执行目标的数据。
- **性能**：
  - 单次采样 p95 小于 50 ms（在 macOS 上测）。
  - 打开「机器」页面不影响 session-open 原生门和首 token 门禁。
  - 模块数不超过 192。
- **真机**：mac1、mac2、mac3 各打开一次，和「活动监视器」对照：CPU 误差在 10 个百分点以内，内存压力的级别一致。

## 10. 待维护者决定

1. **入口**：扩展设置里的「主机」页（推荐，改动最小），还是在侧栏加一个顶层「机器」入口？
2. **iPhone**：第一版要不要在 iPhone 上显示（推荐：放第二版）？
3. **额外指标**：要不要加 GPU、电池、网络（推荐：第一版不加）？
4. **结束进程**：要不要做（推荐：第二版做，范围只限 Scry 自己启动的 Provider 进程，并且要原生确认）？
