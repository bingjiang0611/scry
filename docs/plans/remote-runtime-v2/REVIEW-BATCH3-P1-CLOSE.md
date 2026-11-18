# Batch 3 核验（M1）与 P1 关闭

核验范围：`2216d87..b2dc2f8`。其中只有 `b2dc2f8` 是本轮修复；`2b1d839` 是我上一份核验的 cherry-pick。提交身份为 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`，正确。

方法：读 diff，对照两处判断逻辑前后的分支顺序。本轮没有在本机重跑测试。

## M1：接受

- **daemon 锁**：`checkHolder` 在 Scry command 兜底之前判断 `previous.pid === selfPid`，满足即判为 `stale/pid-reused`，进入原有的 takeover 互斥区。若身份一致，会在更早一步判为 `live`，因此这条新分支只处理身份不同的记录。
- **远程 lease**：兜底条件里增加 `owner.pid !== process.pid`。身份一致时仍然先抛 `owner_alive`，所以同一进程重复调用 recover 不会接管自己正在持有的 lease。接管仍然要经过永久 claim fence。
- **测试**：两条新测试在旧实现上都会失败（Scry command 兜底会拒绝）。lease 那条用的是本进程的真实身份，加上旧格式的 key，在 macOS 和 Linux 上都会走到新分支。对照用例改为“另一个活着的 pid，启动时间差 1 秒，command 是 Scry”，仍然拒绝，覆盖了原来的保护意图。
- **STATUS**：过期的说明已经更正。

## P1：关闭

B3-P1 的实现与验收完成。这一判断基于以下内容：

- 单写者锁（含 L1、L2、M1）
- 真实宿主装配，以及经 unix socket 走 mTLS 的端到端测试
- 能力诚实：R1、N3 的协议层
- 启动恢复先于服务（R2）
- 共享 lease 的进程身份：macOS 用 UTC `lstart`，Linux 用 `boot_id` + starttime（R3、N1、M1）
- 私有 recorder CLI 不回退 PATH（N2）
- fail-closed 配置与有上限的 supervisor（R4、R5）
- 打包检查，以及 macOS 与 Ubuntu 上构建产物的 SIGKILL 验收

## 带入后续批次（不阻塞）

1. **N3 UI**：renderer 还没有使用 `workbenchOps`。App 切换到 daemon host 之前，必须把它接入 catalog，隐藏或禁用“外部打开”和“移到废纸篓”。
2. **macOS 兜底收窄**：macOS 的 `lstart` 不会漂移，Scry command 兜底在 macOS 上只会带来误拒。可以考虑只对旧格式记录启用这条兜底。
3. **R5 余项**：`remote_lease_*` 这类确定性启动失败，仍以 exit 1 退出，会被重试 4 次，而且不记录原因。
4. **SIGKILL 覆盖分在两处**：构建产物证明了 lease 恢复；`host_restarted` 加“不二次 dispatch”由单元测试证明，那里的 lease 是正常关闭的。如果后续要做全链路验收，就在被杀之前先放一个已经 dispatch 的 run。
5. **既有失败**：`test:renderer:ui` 的 performance fixture（`Performance control obscured: #performance-empty`）在 Batch 3 起点 `577995b` 就失败，与 P1 无关，需要单独立项。
6. **尚未切换**：App 仍然使用进程内的 remote host，模板只生成、不安装。App→daemon 的控制面迁移与切换，是下一批的范围。

## 下一步

`STATUS-BATCH3.md` 中 B3-P1 改为“完成（已核验）”，把上面 6 项列为后续事项，Batch 3 收尾。不要自行开始新的 Batch，先由维护者确定 Batch 4 的任务书。
