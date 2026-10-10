# iOS 扫码入口、运行状态与项目文件 · 2026-10-10

## 合同

- 移除 Apple 登录、退出登录与 Apple sign-in entitlement。未配对时直接扫码；已配对时复用原连接与 Keychain grant。不删除真实缓存、草稿或凭据。
- 保留 Mac 确认与设备证书授权。相机不可用时明确报错，不提供绕过配对的生产入口。
- Chat 顶部使用既有 run lifecycle；观察中断时显示状态未知。历史会话每 10 秒请求当前状态，前后台切换取消/重新核对；provider/profile/canonical cwd/external session ID 全部匹配。
- `not_observed` 仅表示 Mac Scry 的 RunRegistry 未观察到匹配活动运行，不证明其他终端没有 Agent，也不等于任务完成。异常显示“状态未知”，不保留绿色运行判断。
- 文件夹入口只读。每个 `workspace` 请求经过当前 mTLS grant 检查与 canonical project 授权，再调用既有文件 containment/O_NOFOLLOW/UTF-8/snapshot 检查。没有写入、任意 shell、暂存或回滚接口，也没有扩大 history keepalive 的允许操作。
- 目录每页 100 项；文件每页最多 64 KiB（UTF-8 字符边界可能额外 3 字节），连续页验证 snapshot。JSON 响应本体最多 512 KiB；传输保留 envelope 空间。
- Diff 是当前工作区相对 HEAD，含未跟踪但不含 ignored 文件；不是会话独占 diff。复用隔离 index/object tree，禁用项目 filter/hook，不修改真实 index。非 Git、无 HEAD、失败和超时不是“无改动”。
- Diff 只预览前 64 KiB，明确显示不完整；超出既有 16 MiB Git subprocess 输出上限则失败。需要手机阅读更大 diff 时，再增加带 snapshot 的逐文件分页，不能直接提高无界限额。
- 文件页面仅支持 UTF-8 文本；图片/二进制显示明确读取错误。分页限制响应，不保证巨型目录扫描或 Git 快照恒定时间。既有同用户并发目录置换不在 sandbox 保证范围内。

## 实际检查与初始失败

- 第一轮 focused Node：84 PASS（remote workspace/gateway/真实 localhost TLS transport/Git）。包含越权路径、symlink、分页、UTF-8、文件变化、二进制拒绝、grant 撤销、真实未跟踪 diff 与 index 不变。
- 故意删除 profile 匹配条件：回归测试失败，错误地得到 `running` 而非 `not_observed`；随后恢复保护。
- Swift package：17 PASS；新增 discriminator/unknown evidence/scope/pagination 编解码检查。既有 ProbeHandler fixture 的 Sendable 捕获警告仍在。
- Typecheck 通过。初次 typecheck 发现 service 转发与 wire query 类型遗漏，已修复。
- Simulator Debug build 通过。首次编译因 DEBUG JSON fixture 的 raw-string `\"#` 分隔符冲突失败，改为双 `#` delimiter 后通过。
- 并行工作区 full unit 未通过：180 秒截止，日志记录无关并行 dock-badge API/test 不一致（6 失败），本次组合 Git fixture 在该轮 5 秒测试预算超时。不能用 focused 通过覆盖这些失败，也没有扩大超时或削弱断言。
- Simulator fixture UI 尝试受环境阻塞：专用设备 boot 完成后 install/launch 链在 60 秒截止；后续只读 `get_app_container` 两次均超时，GUI 仅看到 SpringBoard。因此安装/启动未知，没有重放未知 install，也不宣称按钮命中、实际渲染或 UI XCTest 通过。

## 隔离候选的最终检查

为排除并行 writer 的会话阅读、缓存协议和性能面板改动，使用私有 index 与 `.local/ios-workspace/source/` 冻结本次差异。最初基于 `adf2c22`；随后将已提交的 `ebca1c6` / `7f3e73a` 合入候选基线，保留其改动，没有覆盖共享工作区。提交前主分支又前进到 `d83453c`，再次以该提交为父提交重放本任务差异；不把其 LLM 性能改动当作本任务成果。

- `candidate-remote.log`：全部 26 个 remote 测试文件，205 PASS。恢复后的 profile 回归包含在内。
- `candidate-unit.log`：2 workers 全量检查仍在推进时触及 240 秒命令截止；无全量完成证据。该轮 Git 39 项通过，耗时约 63 秒；当时观察到约 4.3 GiB swap 使用，不能据此单独证明超时原因。
- 调查日志与进程收敛后，仅扩大命令整体完成窗口（未改变任何测试/产品超时或断言）。`candidate-unit-final.log` 完整结束：2462 PASS、1 FAIL、3 明确关闭的真实探针 SKIP。失败为既有 `codex-app-server` initialize 拒绝 fixture 得到 response-unconfirmed timeout，而非预期 `initialize denied`。本任务未修改该 fixture；原因未归因，不计为通过，不再重跑掩盖失败。
- `candidate-build-cli.log`：shell、桌面 build、独立 CLI build 与 npm10 package smoke 全部通过。未运行打包/发布、renderer GUI 或真实 Provider。
- 隔离 Simulator build-for-testing 首轮在依赖编译仍推进时触及 180 秒截止。确认 xcodebuild/swift-frontend 已结束后，禁用自动重新解析依赖，继续同一候选构建，通过。没有把 build-for-testing 当作 XCTest 执行。
- 合入上述已提交基线后的 `rebased-typecheck.log`、`rebased-simulator.log` 再次通过 typecheck 与 Simulator App/UI-test target build；单元测试数字仍按原隔离基线报告，不冒充新基线全量重跑。
- 设计 decision `D-20261010-scry-ios-workspace` 已登记到既有项目 authority，library build/search 可发现；library check 仍因无关的 `P-PI-MODEL-SELECTOR` 源路径缺失失败。

## 交付边界

新增两项隔离 UI fixture 测试：扫码入口无账号门禁；会话状态、文件读取与 diff 切换。不执行真实 Provider，不发送消息或批准请求。

本次尚未安装到实体 iPhone 或 `/Applications/Scry.app`，也没有验证真实公网 relay 下的新文件接口、扫码/相机与真实状态变化。桌面和手机均需要包含本协议的新构建；旧主机的 `unknown_op` 会保持为错误，而不是伪造成功。

工作区存在并行改动（包括会话长文本与 LLM 性能面板）。这些不是本任务，提交必须排除。私有日志在忽略目录 `.local/ios-workspace/`，不上传。
