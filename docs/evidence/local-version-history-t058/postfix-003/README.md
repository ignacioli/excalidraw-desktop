# T048 修复后精确包复核（2026-09-29）

**当前状态：新包原生入口 13/13 PASS；T048 HISTORY-01 视觉采集 BLOCKED，未产生截图或人工视觉结论。**

- 产品提交：`9c1e6a37a10b72ec8213af9d3e45d81667ad73c7`（History Sidebar 与只读 Preview 修复）。本目录 `package-manifest.json` 绑定 production `.app` SHA-256 `2420a8a8f5af8253c7ebcd90747e8e0430c1a7cee9d65585322c7e9e5e6aeae3`，macOS 26.6.2、arm64。
- `final/` 保存本轮独立的 FINAL 准备计划、binding、启动 fixture 及原生 collection。`final/collection/native-report.json` 的 13 项均为 PASS，包含 Version History 原生菜单、目标文件路由、请求的 1280×760 几何和启动文件前后哈希一致。
- `history-attempt/` 保存首次 HISTORY 准备计划及 fixture manifest。HISTORY-01 采集器在操作员确认 `ready` 后返回 `BLOCKED`，错误为 `owned-window lookup failed: expected exactly one CoreGraphics owned window`，exit code 2；Investigation Guard attempt `a72fb703-cf98-49db-949e-7257fbd823f4` 记录为 FAIL。该错误仅说明按进程 PID、屏幕可见范围及 layer 0 筛选后未得到恰好一个窗口，当前没有证据区分零个与多个窗口。采集器没有执行截图，`collection-HISTORY-01` 为空，且已结束所启动的进程。
- 下一次先用只读进程/窗口元数据定位窗口数量与状态，修复或调整采集准备后生成**新**的 HISTORY run root、plan 和 claim。不要在已使用的 HISTORY-01 profile 与 collection 上原样重试，也不要把原生入口 PASS 当作 T048 视觉 PASS。

本目录保留原始 JSON 字节。计划和报告中指向 `/private/tmp/t048-postfix.z0H7yJ/` 的路径是此次执行时的实际输入位置；归档副本用于审计，不改写其绑定。
