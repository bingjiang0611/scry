# 会话右侧工作区与终端归属（2026-10-09）

## 复现与合同

用户在终端等待交互时切换项目/会话，Shell 随后退出。对应录制元数据为 `code: 1, signal: 0`，旧 UI 却优先显示 `signal 0`。根因是 main 的 `setCurrentCwd` 调用了全局 terminal cleanup；renderer 同时只有一个全局右侧工作区。

本次确认的合同：

- 切换项目或会话不终止 Shell，不改变其启动目录；新建终端仍校验当前绑定 cwd。
- 右侧标签、终端画面/输入、文件根目录及只读属性、Diff 选择归属各自会话。导航保留未保存编辑，不再要求丢弃；真正关闭文件仍保留确认。
- 外层终端标签关闭/隐藏保留 Shell；内层终端关闭、显式重启或 App 退出才结束相应进程。
- 同项目不同会话不相互接管。draft → run → native 身份迁移保留稳定工作区 ID。
- 延迟身份合并遇到已经打开的目标会话时，两组资源都保留；通过「工作区 n/m」按钮切换，而不是把其中一组变成不可达后台资源。
- `scopeId` 只用于分组，不代替 cwd/IPC/ownership epoch 授权。录制读取的 workspace 边界不变。

## 实现边界

复用原 `RightSurfaceState` reducer；每个会话保留独立面板，后台终端继续消费/确认输出。sessionStorage 保存工作区身份和标签布局，renderer reload 后仅接管相同 scope 的 live PTY。不按 cwd 猜测会话归属。

导航期间保留挂载的终端和文件编辑器；reload 不承诺恢复已退出终端的屏幕、只读录制标签或未保存编辑缓冲区。关闭 App 仍结束进程。存储不可用时会话内导航在内存中继续工作，但不保证 reload 后找回 scope；不自动接管不明归属终端。

资源随用户保留的工作区/终端增长，不设会杀掉后台任务的 LRU。xterm 继续沿用每实例 5000 行显示上限；大量长期保留终端出现内存压力时，应升级为可见的后台终端管理/磁盘接管，而不是静默回收活 Shell。

## 实际验证

环境：macOS arm64，Node 24.18.0，仓库 Electron，构建时 package 版本 0.2.158。使用临时 HOME/userData/workspace；Provider 使用 fixture adapter，没有发起真实 Provider、npm 登录或付费请求。

- focused unit：10 文件、319 tests 通过（terminal manager/output/recording/history/backend/replay、right surface、scope migration、component render）。SSR 测试仍输出 `useLayoutEffect` 服务端提示，不是浏览器交互证据。
- `npm run typecheck`、`npm run build`：通过。
- `npm run test:renderer:ui`：通过，含 Credits、chat preview、background work 和扩展的 terminal 场景。
- `node scripts/session-capability-ui-smoke.mjs --terminals-only`：坐标点击验证 restored/pending 两种情况；同/跨项目隔离、画面与输入保留、录制、原生身份更新、合并后两组资源可达、文件相同相对路径但不同根目录/只读属性不串线、显式重启和关闭。
- `node scripts/electron-security-smoke.mjs --dev-terminal-only`：真实构建 App + preload/main/PTY；跨 cwd 后两边 PID 不变，执行分段构造的标记命令（不能由输入回显冒充结果），分别输出原启动目录。
- `node scripts/electron-security-smoke.mjs --dev`：完整现有 Electron smoke 通过；真实 PTY、renderer reload/epoch fencing、录制回放/删除、owned-App crash 后历史、窗口布局以及原有隔离检查。
- 负向证明：临时恢复 `setCurrentCwd` 的 close-all 行为，重建后真实 PTY 测试明确报 `Shell did not survive selection`。随后撤销该临时变更，重建并验证通过。

## 首次失败与修正依据

- 原 UI fixture 假定全局终端一直可见；按新合同改为“原实例仍挂载但不可见”，控件查询限定当前可见工作区，等待真实可点击状态而不是只判断 DOM 存在。
- 身份冲突切换的原生 select 在隐藏 Electron fixture 中没有完成键盘选择；改用已有按钮样式的工作区循环按钮，最终以坐标点击证明两组资源可达。
- 文件场景最初使用普通 Markdown 链接，不会触发现有文件引用控件；改为产品支持的行内代码路径。目标工作区保留 Files 为活动标签时，测试先证明文件仍可达，再切换其 Terminal 验证 Shell，没有删除资源保留断言。
- 增补未保存文件场景时，fixture 曾返回不可克隆的函数、在标签切换完成前抓取 DOM，并被真实 `beforeunload` 保护阻止加载下一场景。分别改为返回标量、等待目标可见、证明文本保留后显式确认重新载入以收敛 fixture；没有关闭生产中的离开保护。
- 完整 smoke 最初仍测量/点击全局第一个（已隐藏）面板，且假定 cwd 切换后必有退出事件。已改为显式打开/查询当前会话面板、先验证旧 Shell 存活，再发送 `exit` 等待自然退出。显式 terminalClose 会撤销输出所有权，不以缺少 renderer exit 通知推断进程未关闭。

这些调整来自本次明确的导航生命周期合同，不增加超时、不跳过断言。修复提交阶段未执行安装包构建/签名/安装，不将 `--dev` 当作已验证分发产物。

## 用户随后授权重新安装：0.2.159

- 从修复提交 `b8304e7` 冻结源码，仅提升 App 至 0.2.159，私有 CLI 保持 0.2.47。
- 首轮 Node 24.18.0/npm 12.2.0 的 `check:cli-release`：563 tests 通过，但 package smoke 因 npm 12 的 pack JSON 不再是数组失败。没有修改断言或跳过检查；改用项目约定的 Node 22.22.1/npm 10.9.4 完整重跑。
- Node 22 下 `check:cli-release`（563 tests + CLI tarball 安装 smoke）、`test:renderer:ui`、`install:mac:dev` 均通过。安装链包括 typecheck、2435 unit tests、shell tests、App/CLI build、资源 allowlist/体积检查、packaged Electron smoke。3 个真实外部探针（P0/P1/billing admin）按默认合同跳过。
- 安装器原子替换 `/Applications/Scry.app`，旧包保留在 `/Applications/.Scry.app.backup`。开发签名，未做公证，不当作正式 Developer ID 发布。
- 安装后读取 bundle id `com.scry.app`、App 版本 0.2.159、私有 CLI 0.2.47；源/目标 app.asar SHA-256 均为 `681c919a31e021412f0816de44812355994c0911c4a4cbf8595400e179f4faaf`。
- 对已安装路径再次运行 `check-packaged-app.mjs /Applications/Scry.app` 和 `electron-security-smoke.mjs /Applications/Scry.app`，均通过。smoke 仍使用隔离临时数据/fixture Provider，不动真实会话。
- 发现正常运行的 Scry 下仍有 Pi/Codex/OpenCode 进程（含执行本任务的 Pi）；未关闭/重启该实例。用户需在当前任务收敛后手动退出并重新打开才切换到新版。未 push。
- 本地日志：`/tmp/scry-install-0.2.159.aGnin7/`（临时文件，不作为长期制品存储）。
