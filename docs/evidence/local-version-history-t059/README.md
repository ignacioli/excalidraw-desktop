# T059 drawer 调整与验收 fixture 修复

**当前实现：`a50818e`，headless 与 unit 范围 PASS；新 production 包原生/视觉仍 PENDING。** 用户于 2026-09-29 明确选择默认 360 px、拖动左边缘可缩至 300 px。大窗口也可使用，删除 420 px 自动触发；键盘左右箭头与边缘移动方向一致，Home/End 到达宽度边界。AppShell grid 同步调整，不改文档内容、历史选择或操作目标，不新增持久化设置。

同时修复已批准 token 的两项偏差：Mark current 30 px 控件样式，以及 Restore 主按钮被更具体 CSS 覆盖。旧精确包的[独立视觉 FAIL](../local-version-history-t048/window-repair-004/history01-review.md)保留，不能把本轮 browser 结果移作新包视觉 PASS。

## 实际验证与原始报告

| 范围 | 结果 | 报告 |
| --- | --- | --- |
| HistoryPanel unit：宽度边界、焦点与所选目标等 | 26/26 PASS | [t059-unit.json](t059-unit.json) |
| T027：事件传递、session scope 与清理 | 5/5 PASS | [t027-unit.json](t027-unit.json)；这是 unit 层，不宣称 process restart |
| T023：分页、键盘焦点、迟到响应拒绝、零写入、状态及 reduced motion | 5/5 PASS | [t023-final.json](t023-final.json) |
| T048：Light/Dark 布局、按钮 token、drag/keyboard、窄视口及 reduced motion | 5/5 PASS | [组合报告](t048-and-regression.json)内五个 T048 用例；该次另有 regression 失败，整份报告不能标为 PASS |
| Sidebar 切换与真实静态 Preview、Restore enabled/主色 | 2/2 PASS | [regression-final.json](regression-final.json) |
| 其他相关 gates | PASS | `pnpm lint`、strict typecheck、production frontend build、changed-file Prettier、20 项 native prepare/capture tests、`git diff --check`；Vite 仍报告既有大 chunk 提醒 |

[binding.json](binding.json)绑定 implementation commit、源文件 hashes、每份原始报告 digest 和实际统计。报告保存原字节，保留 source/reporter 原始绝对路径；不同运行不合并为虚构的单次 7/7。所有浏览器运行均为 headless Chromium，使用已在 sandbox 外启动的 Vite，设置 `PLAYWRIGHT_SKIP_WEBSERVER=1`；T023 另需 `VITE_E2E_HARNESS=1` 的既有测试入口。

## 保留的失败与修正

- 最初 Chromium 被 macOS Mach service 权限限制挡在启动阶段，后改为 sandbox 外 headless；该启动错误见会话工具输出，当前归档的 `browser-initial.json` 是其后的 5 PASS / 7 FAIL 运行，不冒称首次 sandbox 报告。
- T048 新增样式断言先误将 hex token 与 computed RGB 直接比较，后改为浏览器解析的 token 值。随后尝试用只有 list 数据的 fixture 检查 Preview，不能进入该状态；该检查移至已有合法 Preview fixture 的 regression case，未构造临时 DOM，也未删除原键盘测试。
- 旧 T023/Preview fixture 仍读取顶层参数，而真实 IPC 已使用 `args.request`；T023 时间戳还用了毫秒，契约要求秒。修复 envelope/时间单位，并去除旧测试入口主动注入的 Current 版本身份，按照获批的“历史行不得推断 Current”断言其数量为 0。对应失败见 `t023-first.json` 与 `t023-envelope-retest.json`。
- regression fixture 错误返回空 `versionId`，导致 Restore 一直 disabled；修复真实 request 解包后，明确断言 rendered Preview 的 Restore **enabled**，再检查 accent/contrast。未把 disabled 错误固化为新期望。

## 尚未完成

用户因置顶窗口干扰工作，已要求原生工作遇问题先暂停确认。本轮没有在此之后再启动/激活原生应用。新包需单独复核受影响的原生入口、T048 画面及 owner 决定。T049 的[无效 startup 尝试](../local-version-history-t049/physical-startup-20260929/README.md)不构成性能基线；参考 VM 仍不匹配声明系列。Phase 7、T052 完整汇总及 T054 最终接受未因此完成。
