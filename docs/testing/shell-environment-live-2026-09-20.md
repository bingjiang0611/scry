# 登录 shell 环境恢复：真实 Provider 验证（2026-09-20）

## 环境与范围

- 被测源码：`1051806d888f182db19b8c415a793e18e656c859`，Scry `0.2.149` 开发构建。
- macOS arm64；Electron 开发依赖启动冻结的 `out/`，运行生产 main、sandbox preload、renderer。不是已安装 `/Applications/Scry.app` 的发布验收。
- Rotom `0.1.12`，Node `v24.18.0`；真实上游为 `openai-codex/gpt-6-astra` 和 `qoder/ultimate`。
- 用户明确授权真实 Provider 调用。临时 HOME、userData、workspace；仅复制上述两个 Provider 的认证项，不复制宿主 extensions/settings。测试结束后删除认证副本。
- 通过真实 `window.scry.start()` IPC 发送短回复请求，不是 adapter mock，也不是键盘/坐标点击验收。请求显式使用 Pi 必需的 `full_access`；未要求执行工具。
- `SCRY_TEST_APP=1` 用于独立测试实例；工作区无 MCP/Hook/plugin 配置，本次不验证 trust 确认流程。没有 `.scry` recorder 配置，验证 archive 与原生 transcript，不宣称验证了 canonical records。
- App 继承环境不含代理，`SHELL=/bin/zsh`，PATH 为系统目录。测试 HOME 的 `.zshrc` 使用受控延迟，然后导出代理；没有修改真实 `~/.zshrc`。
- Profile 使用临时、名为 `rotom` 的 launcher，记录 PID、argv 和非敏感环境项后 `exec` 安装的真实 Rotom。没有替换 Provider 返回值。

构建指纹：

```text
main SHA-256     5ddcdb264f3c362a686440fe68da29641215dd68c54a784a774b08802ecade06
preload SHA-256  1ce0ef75071eae69480fdbe407b6e8f9805dda065f1f22949b05a200ceaa5f24
```

## 结果

| 场景 | 真实结果 | 关键证据 |
| --- | --- | --- |
| 冷启动，shell 初始化延迟 6 秒 | OpenAI 成功 | 发送等待约 6.0 秒；Provider 收到 `HTTPS_PROXY` 与 `NODE_USE_ENV_PROXY=1`；`shellEnvError=null` |
| 同会话第二轮 | OpenAI 成功 | 发送受理约 30ms；两轮共用 PID `52990`；第二轮上游报告 cache read 6656 tokens |
| shell 初始化延迟 60 秒，超过 15 秒采集上限 | **预期失败，复现原错误** | `fetch failed (WebSocket error)`；Provider 没有代理；archive 记录采集超时。原生 transcript 有 4 次失败尝试，不计成 4 个用户轮次 |
| 将测试 shell 修复为正常导出代理，然后再次发送 | OpenAI 成功 | 同一 App PID `53546`、同一 native session；RPC 从 PID `53956` 换成 `54255`，新进程获得代理；旧错误提示清除 |
| 修复后同会话再发一轮 | OpenAI 成功 | 继续复用 PID `54255`；发送受理约 28ms；cache read 6656 tokens |
| 环境恢复后，新会话使用 Qoder ultimate | Qoder 成功 | 真实短回复、3834 input / 11 output tokens，无 transport/shell 错误 |

正式场景共 6 个用户轮次：5 个成功、1 个预期故障对照。逐轮核对 archive 的 `providerTurnId` 对应原生 user entry，prompt、assistant 回复和成功/失败状态一致。恢复前后 session 保持 `01a0bcf5-df90-75c1-b85a-aec2afa4371d`。

这证明本次环境采集与进程恢复链路有效；**不证明 Qoder 长上下文下的偶发 `upstream_error_frame` 已修复**。未做长会话压力测试、其他 Provider CLI 验收、安装包更新或完整发布 gate。

## 首轮失败与清理

验收脚本前两次运行有自身问题，均保留记录，不以重跑抹掉：

1. `/tmp` 与 `/private/tmp` canonical renderer URL 不一致，未找到自有 CDP target；没有发送 Provider 请求。
2. 将 `activeRun()` 误用为完成态查询。真实 OpenAI 已成功，但完成后该接口返回 null；改为读取持久化 archive 判定终态。该次额外产生一个成功 OpenAI 轮次。

正式场景两个 App 均正常退出（exit 0），登记的 RPC PID 全部收敛。另发现 Rotom 自动启动的 `pi-computer-use` bridge 会脱离 RPC 存活：三个测试 bridge（含预跑）均按已记录 PID、精确 executable 和 socket 路径重验身份后停止。这是独立的 Rotom 后台服务生命周期现象，不作为本次 Scry 修复内容。

测试认证副本已删除；真实 App、真实会话和用户 shell 配置未修改。Provider 上报/模型推算的 cost 不等于账单，Qoder 的零美元字段也不证明免费。

## 本机证据

证据未提交到仓库，保留在：

```text
/private/tmp/scry-shell-live.BMfJYU/
  probe.mjs                        # 本次一次性真实验收驱动
  identity.json                    # 源码、构建、runtime 身份
  results.json                     # 六轮结果与耗时
  archive-native-verification.json # archive / transcript 逐轮核对
  cold/launches.jsonl               # 冷启动/复用 PID 与环境
  recovery/launches.jsonl           # 故障、恢复与复用 PID
  recovery/final.png                # 真实 renderer 的 Qoder 结果
  cold/cleanup.json
  recovery/cleanup.json
  sidecar-cleanup.json
  final-cleanup.json                # 全部进程收敛后再次确认凭据副本已删除
```

前两次脚本运行保留在 `/private/tmp/scry-shell-live.fOvrDi/`、`/private/tmp/scry-shell-live.MCE7cn/`。这些是本机临时证据，不是 CI 依赖；清理临时目录后路径可能失效。

## 后续本机安装：0.2.150

用户随后明确要求安装。仅 App 从 `0.2.149` 升到 `0.2.150`，CLI 保持 `0.2.45`，上面的业务源码没有再改。

- Node `v22.22.1` 下 `npm run check:cli-release`：557 tests passed，CLI package smoke passed。
- `npm run test:renderer:ui`：会话、Credits、图片/焦点、后台任务与恢复 fixture 全部通过。
- `npm run pack`：typecheck、2311 tests passed / 3 skipped、shell、App/CLI build、产物检查与 packaged Electron security smoke 全部通过。三项 skip 为默认关闭的 `P0_PROBE`、`P1_PROBE`、`BILLING_ADMIN_REAL`，没有用此次的两个上游测试冒充这些探针。
- 为避免中断用户当时正在运行的 Qoder 任务，将 `install:mac:dev` 的 `pack && installer` 两阶段分开执行。任务结束后正常退出旧 App，再运行 `node scripts/install-macos.mjs` 安装同一产物；保留 `/Applications/.Scry.app.backup`。
- 安装后重新执行产物检查与 `codesign --verify --deep --strict`，核对源产物和安装目录的 `app.asar`、plist、App executable、私有 CLI launcher SHA-256 一致。版本为 App `0.2.150` / CLI `0.2.45`，已正常打开 App 和 renderer。
- 使用本机 Apple Development 签名，未公证；这不是正式 Developer ID 发布。没有另跑 Node 20/24 CLI 矩阵，也没有在真实用户工作区再次发送验收 prompt。

安装日志与指纹：`/private/tmp/scry-install-0.2.150.RMEaR7/`。
