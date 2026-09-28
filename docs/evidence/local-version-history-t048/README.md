# T048 视觉采集记录

## 2026-09-27：首个 History 状态的修复前观察

- 产品 runtime：`e873aac208e0271641cb2434f49daa4a6d2e01fd`，production `.app` SHA-256 `ef7ce6a97ad7c00da4d5524e36e8b1635e8c2ea8ee74d1798b84b067c8eaf162`。
- [HISTORY-01 原始 collection](history-01-pre-remediation/collector-report.json) 的 capture-integrity claim 为 **PASS**，run ID `45cbd85b-e709-4ff8-afea-d42217cd6347`；1280×760、backing scale 2、两个稳定窗口样本均见 `capture-readiness.json`。`collector-report.json` SHA-256 为 `12648d7ec9b2ddde868abf71e902c7fbb61d0f546dff98a5f08af09eb99764fe`，`actual.png` SHA-256 为 `d2f6a43fc41d4aeffe32f06f60f38fece9d83dd5220bfed61daa6e4e04bdfbe2`。此目录从 `/private/tmp/t048-history-visual-argv.NzSOem/HISTORY-01-native-capture` 逐字节复制，`diff -qr` 无差异。
- [截图](history-01-pre-remediation/actual.png) 中的 History 位于左侧 Workspace 下方，批准设计要求右侧 360 px drawer；Delete 以常驻按钮呈现，批准设计要求放在 More Actions 菜单。新建 Manual 版本显示 1970 年日期：Rust 传来 Unix 秒，`HistoryList` 却按 JavaScript 毫秒格式化。以上是 Agent 对修复前截图的观察，**不是独立人类 reviewer verdict**。
- 布局根因：`66e5b77`（2026-09-25）把 `HistoryPanel` 追加为 `.app-shell-body` 的第三个子元素，而固定两列的 pinned grid 没有增加 History 列，CSS grid 因此把它自动排入下一行左列。此前浏览器语义测试检查面板存在与交互，没有断言 1280×760 下的右侧几何；正式 package 视觉门槛仍待 T048。Git author 元数据不能判定当时由人或哪个 Agent 编写。
- 当前 T048 human review matrix 仍为 `BLOCKED` / `PENDING`。修复产品 UI 后必须构建并绑定新的 exact production package，重新采集受影响状态；旧 collection 保留其原始身份和观察，不转写为新包结果。
