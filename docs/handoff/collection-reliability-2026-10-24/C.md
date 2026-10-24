# 批次 C：不同环境下的 hook 传输链路（M5、L1、M6）

分支：`reliability/collection`，B 核验后开始。这一批和「装在各个电脑上、环境不同」直接相关。

## C1（M5）回退链路不超宿主预算、不重复处理

**先测**：用 shell fixture 模拟一个接受连接但不响应的 daemon（wedged），量出 Stop 事件从脚本开始到退出的总时长，以及同一事件被 `handleRecorderHook` 执行的次数。记录到报告（L1 计数，时长注明机器负载）。

**改法方向**
- shell 回退调用 CLI 时传一个标记（环境变量或参数，例如 `SCRY_RECORDER_DAEMON_TRIED=1`），CLI 收到后跳过第二次 daemon 尝试（`scry.ts:141-153`），直接走直写。
- 非 Claude Provider 的 Stop 是否也改为「钉住边界 + 返回 pending，聚合交给 daemon/recover」（Claude 与 SessionEnd 已经这样做，见 `recorder.ts:2976-2991`）。这会改变直写模式下的提交时机：没有 daemon（`SCRY_RECORDER_TRANSPORT=direct`）时谁来聚合？执行方先评估，确保 direct 模式下仍会在合理时间内提交（例如直写后同步 recover 一次、或下一个事件触发），在报告中写明。
- 预算核算写进报告：每个 Provider、每类事件，最坏情况下 hook 总耗时 vs 宿主超时（Claude Stop 15s、其他 10s、SessionEnd 3s；Codex/Qoder 以 `init` 写入值为准；OpenCode 插件用 `spawnSync`，确认其超时）。

**红线**：不能为了快而在超时前丢弃事件；超时必须落 inbox。

## C2（L1）长路径下快路径失效

**先证实**：workspace 路径足够长使 `$workspace/.scry/recorder-v1.sock` 超过 100 字节，daemon 实际监听在 `$TMPDIR` 下的哈希路径，shell 的 `[ -S "$socket" ]` 判断失败，每个事件都启动 Node。

**改法方向**：daemon 启动后把实际 socket 路径写进 `.scry/recorder-socket-path`（原子写），shell 优先读它；或在 `init` 时计算好写进 hook 脚本旁的文件。注意 `SCRY_RECORDER_SOCKET` 显式设置时的既有语义。

## C3（M6）子目录启动 / Provider 不提供项目目录变量

**先实测**：Codex、Qoder 的 hook 执行时是否设置 `CODEX_PROJECT_DIR` / `QODER_PROJECT_DIR`，cwd 是什么；在仓库子目录启动 Provider 时 hook 能否找到 `.scry/provider-hook.sh`。执行方无法运行真实 Provider 时，把检查步骤写进报告「用户验证」，由用户在本地跑（用户可验证 OpenCode、Qoder、Codex）。

**改法方向（确认有问题后）**：`hookCommand` 找不到脚本时向上查找最近的 `.scry/provider-hook.sh`（到 git 根或 `/` 为止），仍找不到时 exit 0 并尽量留痕（此时还不知道 workspace，可写到 `${XDG_STATE_HOME:-$HOME/.local/state}/scry/hook-skip.log`）。

**红线**：hookCommand 是写进 Provider 配置的单行命令，修改后存量配置需要 `integrations repair`；`alreadyInstalled` 比较的是完整 command 字符串，改了之后要确认 repair 能替换旧条目而不是追加一条重复的。

## 测试

`npm run test:unit -- src/cli/workspace-init.test.ts src/cli/scry.test.ts src/core/turn-recorder/daemon.test.ts`，`npm test`（含 shell），`npm run typecheck`。
