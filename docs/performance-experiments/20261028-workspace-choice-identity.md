# 2026-10-28 工作区选择复用当前仓库身份

## 现象

当前 packaged build 的 `ipc.workspaceSelection:read`：p50 591 ms、p95 2535 ms，69 个样本，
最大 7017 ms。该 handler 返回权威的 branch/worktree 清单，会执行真实 Git 读取。

`SourceControlService.workspaceChoices()` 已经为请求 cwd 解析一次 `GitIdentity`，随后读取 revision
snapshot；在检查未收口运行目录时，如果该目录就是当前请求 cwd，旧实现仍再次调用
`git.identity(cwd)`。

## 测量

测量提交：`cd82dc5d`。

固定负载：一个真实临时 Git 仓库，当前请求 cwd 同时出现在 `unsettledDirectories()`，读取一页
branch choices。

| 指标 | 基线（5/5） |
|---|---:|
| `identity.calls` | 3 |
| `git.run.calls` | 10 |

## 改动

未收口目录与本次已授权、已解析的 `directory` 或 `identity.root` 相同时，直接复用该
`GitIdentity` 标记 busy root。其他目录仍逐个执行完整 `git.identity()`；没有新增跨请求缓存，
也没有跳过目录授权或 common-dir 比较。

## 结果

| 指标 | 基线 | 候选 | 变化 |
|---|---:|---:|---:|
| `identity.calls` | 3 | 2 | -33.3% |
| `git.run.calls` | 10 | 9 | -10.0% |

五次候选均为 2 / 9。`performance:measure --compare cd82dc5d` 通过，无同场景 worse。
减少的工作是真的不做了：当前仓库身份已经由同一次 handler 验证，不再为 busy 标记重新启动
一次 Git 读取。

## 验证级别与限制

- L1：已验证。
- L2：未宣称。机器 load 在 20–120 间波动，真实 Git 毫秒测试不可信。既有相关性证据显示
  一个 Git 子进程约对应 29–50 ms，但不能直接当成本实验的候选毫秒。
- 该改动本身不足以把 p50 591 ms 降到 100 ms。剩余 9 次 `git.run` 包含 revision、refs、
  worktree 与状态材料；下一步需要合并同一请求的 revision/ref 读取，或引入带完整失效键的
  Git inventory generation / 常驻进程。
- L3：未构建、未安装、未收集新 build 日常记录。

## 交付状态

- 优化源码：本实验提交（提交后补精确哈希）。
- 合入：未合入。
- 构建：未构建。
- 安装/生效：未安装。
