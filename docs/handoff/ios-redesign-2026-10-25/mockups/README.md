# 设计稿源码

这些是设计画布（<https://claude.ai/artifact/WkPCeBVNnSvTDauRq84tHJ>）里各画板的原始文件，依赖画布运行时（`support.js`、`<x-dc>`、`{{…}}` 模板），不能直接用浏览器打开。把它们当作带精确数值的 HTML/CSS 参考来读：颜色变量在每个文件 `<helmet>` 的 `.t-dark` / `.t-light` 里，动效在同一处的 `@keyframes` 和 `transition`。

| 文件 | 画面 |
|---|---|
| `Main.dc.html` | 首页：项目 / 动态 |
| `Session.dc.html` | 会话页（`theme` 属性切换深浅） |
| `SessionLight.dc.html` | 会话页浅色（引用 Session） |
| `Question.dc.html` | 需要你决定 |
| `Overview.dc.html` | 会话总览 |
| `NewTask.dc.html` | 新建会话 + 模型 · 推理强度浮层 |
| `Spec.dc.html` | 颜色 / 字号 / 动效规范板 |

里面的会话标题、Token、费用、时长都是示意数据，不是真实记录。与 [../SPEC.md](../SPEC.md) 不一致时以 SPEC 为准。不要修改这些文件。
