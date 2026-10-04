# 版本行内短提示增强

**当前状态（2026-10-04）：I1–I4完成，新包已封存；I5/H4原生准备BLOCKED，H5及Phase7未完成。** 指定新包PID73019的History菜单就绪，但Accessibility窗口查询失败；随后两次查询均为0个窗口，正常前台激活后仍为0。未执行History入口点击，未产生T058 PASS或owner视觉决定；停止重复启动/重建，见[本轮准备记录](native-preparation-attempt.json)。本增强按本轮负责人要求实施，不修改 History 持久化、去重或 retention 业务语义，也不扩大 T059 已完成的历史范围。

## 批准与实现输入

负责人接受行内短提示，要求移除背景，随后明确“Penpot Review通过。请继续。”。规范见 [implementation-map](../../../../design/local-version-history/implementation-map.md) 的 HISTORY-ROW / HISTORY-FEEDBACK；设计身份、批准与两个代表图的 digest 见 [design-review.json](design-review.json)。

- 目标版本 badge slot 内显示 Marked / Unmarked / Already marked · no new version 与装饰性 check。
- 11px medium 次要文字，无背景、边框、阴影或动画；3000ms后恢复真实持久 badge，不增加行高。
- document/version与最新操作绑定；保留状态优先级、polite公告、错误、Delete及retention移除fallback。
- Penpot source revision108、05 Light、06 Dark300、tokens/manifest已同步；用户下载源原样归档，ZIP、身份、文案、透明背景、批准元数据和全部资源digest通过核验。

## 增量执行记录

| 步骤              | 状态                    | 证据或完成条件                                                                                             |
| ----------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| I1 规范核对       | 完成                    | 复用共享token、原badge slot及既有操作generation                                                            |
| I2 局部设计与归档 | 完成                    | owner明确批准；source revision108、两个代表状态和组件规范已同步                                            |
| I3 实现           | 完成                    | HistoryPanel/HistoryList/CSS；现有AppShell回调保留，普通成功仅行内提示                                     |
| I4 定向验证       | 完成                    | unit87/87、typecheck、全局lint/format；两个browser失败用例修正后各1/1 PASS；代表Light360/Dark300行渲染检查 |
| I5 包封存与H4衔接 | 包就绪；原生准备BLOCKED | production seal一次PASS（约82秒）；manifest绑定2c13f50；本轮指定进程0个AX窗口，入口/owner复查尚未执行      |

## 验证与保留的失败

- [最终unit](unit-final-report.json)：3文件87/87 PASS；涵盖目标/文档绑定、迟到结果、timer刷新、重命名、移除、错误、Preview及兼容路径。独立定向review发现的重命名timer问题已修复，最终未发现未处理的明确缺陷。
- [首轮browser](browser-report.json)：14/15 PASS；新用例错误测量内部button而非82px外层row。首次定点复验又发现退出按钮错误限定在drawer；[复验失败](browser-retest-report.json)保留，未延长timeout。修正canvas portal定位后[最终1/1 PASS](browser-final-report.json)，同时检查Light360/Dark300无背景/字体/几何、Preview优先级、公告与TTL恢复。
- [首轮semantic](semantic-report.json)：4/5 PASS；旧status数量断言未区分新增常驻公告。第一次修正的has locator范围错误，[复验失败](semantic-retest-report.json)保留；按状态标题定位后[最终1/1 PASS](semantic-final-report.json)，保留各状态角色、唯一对应区域与公告为空断言。
- 首次[lint](lint.txt)检出新增ref render写入与同步effect state更新。按commit-phase ref同步及announcement ID守卫修复后[全局lint](lint-final.txt)、[format](format-final.txt) PASS；未禁用规则。typecheck由实施代理执行通过。首轮与最终unit报告分别保留，不写成一次全通过。
- Primary查看了browser-final-output中的两个受影响行PNG；只证明browser组件表现，不替代WKWebView/owner验收。原始失败报告、stdout和截图保留在Git；生成的context、trace/video原样归档到既有gitignored `test-results/`，位置与SHA见[诊断记录](diagnostic-artifacts.json)。

## 原生准备与剩余范围

[fixture-manifest.json](fixture-manifest.json) 记录本轮全新的系统临时profile：50条manual历史、pending issue和unavailable，使用既有backend-only准备工具。3处preview readback及50条分页由准备工具检查；`nativeVerified=false`，不把离线造数当作生产包可达性或owner PASS。旧PID17298经普通Quit退出；本轮新包会话身份见[native-owner-session.json](native-owner-session.json)，状态准备影响分析见[h4-state-preparation.json](h4-state-preparation.json)。

H4集中复查仍覆盖Light、Preview/Restore/Cancel、长列表与目标、Dark300、error/conflict/pending/unavailable、焦点及reduced motion。未受影响且已有owner接受的细滚动条/History info不重复全量观察；Recovery按共享UI实际影响决定。T058/T048、T049有效性能配对、T052索引及T054最终接受保持未完成，旧FAIL与包身份保留。

## 新精确包

产品commit `2c13f5066490ca4e5a8dbbbdaedfee253559f779`，package SHA-256 `6f0b5067b2b2b031deb7d4aad49e720511a310c80891646140f834030d0051c4`；[manifest](package-manifest.json)、[seal report](package-seal-report.json)和[原始构建输出](package-seal.raw.txt.gz)（gzip解压后字节不变）和[可读日志](package-seal.txt)（仅移除行末空白）保存实际身份。本次仅一次production seal，包含strict TypeScript/Vite与Rust release build，约82秒PASS，保留既有大chunk警告。后续仅证据文档提交不重复构建。本轮已启动新包PID73019；原生准备受0个AX窗口阻塞，未作视觉PASS声明。
