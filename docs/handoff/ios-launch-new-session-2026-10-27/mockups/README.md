# 设计稿源码

来自设计画布 <https://claude.ai/artifact/JbcSAQAGLaVQ39Tn2mFD3g>，只读参考，不要修改。文件是画布的 `.dc.html` 格式，需要画布的运行时才能渲染，直接用浏览器打开会缺样式变量；读源码里的尺寸和颜色即可。

| 文件 | 画面 |
|---|---|
| `Main.dc.html` | ① 启动 = 新建会话，抽屉收起（`dark` 参数切深色） |
| `Sidebar.dc.html` | ② 点 ☰ 后抽屉展开 |
| `Typing.dc.html` | ③ 点「新建会话」后会话框聚焦、键盘弹出 |
| `MainDark.dc.html` | ④ 启动态深色（引用 `Main` 并传 `dark`） |

会话标题、项目名等是占位，实际都来自主机数据。数值与 [../SPEC.md](../SPEC.md) 不一致时以 SPEC 为准。
