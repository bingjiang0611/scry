# B4-L4 · 配对与宿主状态（daemon 模式）

`remote:status`、`remote:pairing:begin`、`remote:pairing:confirm`、`remote:pairing:cancel`、`remote:device:revoke` 五个通道由 daemon 回答（本机 op `localHostStatus` 与 `localPairing`）。至此 168 个特权通道全部有了去处，L4 迁移完成。

## 做法

- **一份实现。** main 的五个处理抽到 `pairing-channels.ts`，main 和 daemon 共用。daemon 用自己的宿主和配对 authority，开关打开时由它承载已配对设备。
- **启用规则与进程内相同。** daemon 为了 App 的本机端点，宿主总在运行；但「远程访问已启用」仍按 main 的 `remoteHostEnabled`（打包版默认开启，开发版默认关闭，`SCRY_REMOTE_HOST` 可覆盖）判断。未启用时回答 `{ enabled: false }`，配对回答「远程访问未启用」，和进程内一样。
- **App 自己的连接不是设备。**
  - daemon 模式下，App 通过本机 socket 入网，得到一条 `scope: local` 的授权；每次重新入网还会留下旧的已撤销记录。
  - 配对界面只列已配对设备，过滤掉本机授权。进程内不存在这类授权，所以过滤后两种模式一致。
  - 撤销本机授权会让 App 和 daemon 断开，所以这个通道拒绝撤销它，并说明原因。
- **确认仍是用户的动作。** App 界面上由用户核对公钥指纹并点击确认，请求带上该指纹发给 daemon，authority 校验，失败就拒绝。
- **不需要新增推送。** 宿主本来就不向窗口推送配对进度，渲染端自己轮询 `remote:status`。

## 测试（均先失败）

- 真实 daemon：
  - 开发版默认（没设 `SCRY_REMOTE_HOST`）时，状态为未启用，配对被拒；
  - `SCRY_REMOTE_HOST=1` 时，状态为已启用，设备列表不含测试自己的本机入网记录；
  - 撤销本机记录被拒，并且之后的调用仍有回答；
  - 开始配对后出现在待处理列表里，可以取消；用编造的指纹确认会被拒绝。
- 对照实验，全部失败后恢复：
  - 不过滤；
  - 不拒绝撤销本机记录；
  - 不按启用规则判断。
- 两条闸门测试原来拿「尚未迁移的通道」当拒绝示例，现在已经没有这样的通道，改为一个没有分类的测试通道名。闸门对未分类通道同样拒绝，测的还是同一个保护。

## 门禁（Linux 容器，root）

- 全量 vitest 只剩已知的环境问题；
- `performance:measure`：Ratchet 通过。

## 未验证与待定

- 未在 macOS 与真实 App 中验证，也没有和真实手机走完整配对（需要 relay；按规定用 iCTRL 操作真实手机）。
- daemon 的 `SCRY_REMOTE_HOST` 取自 daemon 自己的环境。如果 supervisor 启动 daemon 时清洗掉了这个变量，开发版里显式设置的开关在 daemon 侧不生效，会回落到按是否打包判断。未核实。
- `remote:desktop:*`（把另一台桌面 App 配对到本机宿主）路由仍是 `main`。daemon 模式下 App 自己没有宿主，这三个通道回答「未启用」。要不要也交给 daemon，另行决定。
