# 真实 Service.diff：保留双 revision 校验，避免重复面板元数据查询

## 冻结基线（优化前）

生产基线 `e62f99e`。已有 `source-control.service.status-diff` 仅调用 ScGit.status + diff，仍原样保留，不能当成真实 Service.diff。

新负载：`tracked-files=5001;dirty-paths=4;remotes=1;diff-requests=1;staged=false;primed-ui-revision=true`。真实临时 Git / SourceControlService / ScProcess：一个文件部分暂存、一个工作区修改、一个暂存 rename、一个 untracked 中文文件。面板初始 read 在时窗前，与实际点击 diff 的调用链相同；终态检查完整 index 字节未变、patch 只含工作区层、不含已暂存层。每侧固定五轮，不缩小旧负载。

优化前 collector 六个测试通过，新增四序列均稳定：

| 指标 | 五轮结果 |
|---|---|
| Git / 整体子进程 | 24 / 24 |
| 原生 status 校验 | 2 |
| remote 查询 | 6 |

## 发散与选择

| 视角 | 想法 | 本轮判断 |
|---|---|---|
| 需求 | 校验是否真的需要完整 remotes 展示 | 可立即实验：revision 哈希不含展开后的 remotes 数组 |
| 调用链 | 合并前后两次 revision 检查 | 否决：丢失 diff 期间变化的拒绝能力 |
| 进程 | 常驻 Git worker / cat-file | 需用户决定；本轮不引入常驻进程 |
| I/O | 并行 dirty 文件 stat | 需另测；保持现有 fingerprint 顺序与来源 |
| CPU | 减少 index hash | 否决：它属于 revision 合同 |
| 缓存 | 缓存配置或 hooks | 需用户决定及失效合同；本轮不缓存 |
| 并发 | 合并两个检查的共同请求 | 否决跨 diff 合并；两个时间点必须重新取证 |
| 证据 | 为校验提供不含展示 remotes 的内部投影 | 选中：完整保留 identity、filter、status、config、文件/index、hooks/blockers 取证 |
| 安全 | 去掉 filter/hook 扫描 | 否决：原有 trust/read 安全边界不变 |
| UI | 懒加载 diff 或改变点击反馈 | 本轮不改 UI/IPC，避免把等待藏到别处 |

假设：仅为 Service.diff 的两个校验选择内部 revision 投影，可省去 6 个 remotes 子进程。普通面板 read、写入预期检查及 remote/PR/传输路径仍取完整 status；不改变 revision 公式与查询顺序。目标 24→18，两个 status 保持 2。

## 待验证

实现后补 L1、锁内同机 L2、revision 等价与期间变化拒绝回归、真实 App 源代码管理路径。未验证前不宣称收益。候选指标不自动升级门禁，不合入/推送/安装。
