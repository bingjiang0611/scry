状态：受阻

# W2b · P5 第 1 步剩余真机验收报告

## 1. 结论

**受阻（当前无可直接执行项）**。项 1（AX 原生确认框）受阻于宿主机终端子进程 `AXIsProcessTrusted: False`；项 3（签名包 TCC/钥匙串/本地网络权限）受阻于本机无正式代码签名身份（`0 valid identities found`）；项 2（真实注销再登录）与项 4（FileVault 重启）按任务单须排到最后，待全体执行方停工、确认 `MEASURING` 不存在并与维护者约好停机时间后同批执行；项 5（Linux 真机）标 `not-run`。本轮未触碰日常 `com.scry.daemon` 与 `~/Library/LaunchAgents`。

## 环境信息

- 基线提交：`92a603d4`（含 W2 代码第三轮核验通过与 W2b 移交）
- 操作系统：macOS 27.0（Build 26A428），Darwin 27.0.0 arm64（Apple M6，12 逻辑核）
- FileVault：`fdesetup status` → `FileVault is On.`
- 无障碍权限：`AXIsProcessTrusted()` → `False`（即使系统设置已添加 `herdr`/`agy`，子进程 `python3` 仍未获信任）
- 代码签名身份：`security find-identity -v -p codesigning` → `0 valid identities found`（`/Applications/Scry.app` 当前为 ad-hoc 开发签名）
- 证据目录：`~/.local/state/scry-handoff-evidence/W2b/`（本轮尚未产生需写入证据文件的实跑日志）

## 2. 提交

- 基线：`92a603d4`（`docs(handoff): move W2's remaining real-machine items to executor A (W2b)`）
- 本报告提交：见本次推送最新 SHA

## 3. 验收逐项

| # | 项目 | 状态 | 说明与阻塞证据 |
|---|---|---|---|
| 1 | 原生确认框（AX） | **未验证（受阻）** | `python3` 调 `ApplicationServices.AXIsProcessTrusted()` 返回 `False`；按安全规则禁止注入按键。待维护者为运行脚本的 `python3.12` / `osascript`（或重启获得授权的 `herdr`）补齐无障碍信任后，立即可在独立测试实例（测试标签、临时服务目录、含中文与空格的 userData，不碰 `com.scry.daemon`）验证：取消不写服务文件、确认后写入并加载、关闭不弹确认 |
| 2 | 真实注销再登录 | **未验证（排期至最后）** | 注销会中断当前桌面与所有执行方；当前执行方 B 仍在运行 W7，执行方 A 即将运行 W1 #12 长跑，且尚未与维护者约定停机时间（详见下方执行方状态表）。将在全部执行方停工、确认 `MEASURING` 不存在且维护者确认时间后，仅使用测试标签与临时服务目录执行 |
| 3 | 签名包上的系统权限（TCC `~/Documents`、钥匙串、本地网络） | **未验证（无正式签名包）** | 本机 `security find-identity -v -p codesigning` 返回 `0 valid identities found`，当前仅有 ad-hoc 开发签名 `/Applications/Scry.app`，无法验证正式签名包在 `launchd` 拉起下的 TCC、钥匙串与 macOS 本地网络权限弹窗行为（按任务单要求标未验证并写明） |
| 4 | FileVault | **未验证（排期至最后，与项 2 同批）** | 已核实本机 `fdesetup status` 为 `FileVault is On.`；需要整机重启以验证重启后未登录不可用、登录后自动拉起，按任务单与项 2 同批放到最后执行 |
| 5 | Linux 真机 | **not-run** | 本机为 macOS 27.0（arm64），无 Linux 真机环境 |

### 当前各执行方状态与测量锁核查（2026-11-20 02:55）

- **`MEASURING` 文件**：当前不存在（W1 #12 101 分钟长跑已结束并删除 `MEASURING`）。
- **执行方 A（`~/work/scry-A` / `exec/A`）**：W1 已完成全部无阻塞项（含 #12 长跑），当前 `受阻`（仅余 AX/iPhone）；W6 `待核验`；W2b `受阻`。
- **执行方 B（`~/work/scry-B` / `exec/B`）**：W3 已通过；W2 代码已通过（`W2-review.md` 第三轮）；W7（Antigravity A0）请注销前确认已停工。
- **执行方 C（`~/work/scry-C` / `exec/C`）**：W4 已通过；W5 报告状态 `待核验`；另观测到约 23 对 `~/work/scry-C` 下的 `daemon-supervisor.js` + `daemon.js` 空闲进程（CPU 0.0%，执行方 A 未触碰）。
- **是否满足注销/重启条件**：**否**（尚未确认 B/C 停工且未与维护者约定停机窗口）。

## 4. 失败与处理

- 无执行失败；本轮仅做前置环境检查（`AXIsProcessTrusted`、`security find-identity`、`fdesetup status`、各执行方状态与 `MEASURING` 锁核查），未擅自修改 `~/Library/LaunchAgents` 或触发注销/重启。

## 5. 与设计的出入

- 无。严格保留不碰日常 `com.scry.daemon`、不注入按键、不提前注销/重启的约束。

## 6. 未验证

- 项 1（原生确认框 AX 操作）：缺 `AXIsProcessTrusted: True`。
- 项 2（真实注销再登录）与项 4（FileVault 重启）：待全部执行方停工并与维护者约定窗口。
- 项 3（签名包 TCC / 钥匙串 / 本地网络）：本机无正式代码签名身份（0 valid identities）。
- 项 5（Linux 真机）：无 Linux 机器（`not-run`）。

## 7. 需要维护者决定

1. **补齐无障碍（AX）信任以解锁项 1（同步解锁 W1 #8/#9）**：
   - **推荐**：在「系统设置 → 隐私与安全性 → 无障碍」确认添加 `/Users/bingjiang/.local/share/python/cpython-3.12.12-macos-aarch64-none/bin/python3.12` 与 `/usr/bin/osascript`（或重开 `herdr` 开关并重启 `herdr`）。
   - **理由**：这是项 1 唯一阻塞，且能一次性解锁 W1 #8/#9 与 W2b #1 全部原生弹窗验收。
2. **项 3（正式签名包系统权限）是否在本机补签或延后至发版签名环境**：
   - **推荐**：若本机暂不导入开发者签名证书，保留项 3 为「未验证（仅开发签名）」并在具备正式签名包的发布/签名机上补验。
   - **理由**：本机 `security find-identity` 为 0，无法凭 ad-hoc 包替代正式签名包的 TCC/钥匙串行为。
3. **项 2（真实注销再登录）与项 4（FileVault 重启）的停机窗口**：
   - **推荐**：待执行方 A 跑完 W1 #12、执行方 B 停下 W7、执行方 C 确认已收尾后，由维护者指定一次可注销/重启的时间窗口，由执行方 A 与维护者配合同批完成项 2 与项 4。
   - **理由**：避免中断其他执行方正在进行的工作或打断正在持有的 `MEASURING` 锁。
