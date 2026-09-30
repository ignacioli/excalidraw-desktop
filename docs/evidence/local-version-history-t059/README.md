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


## 新包准备（不是原生验收）

干净产品提交 `c453f3f68c09cd70bd80c6efc3a8e1c5300ece90` 已通过 production build/seal，包含实现 `a50818e`；[package manifest](package-ready/package-manifest.json) 记录 package SHA-256 `c19071050bc73aa1a09c45e63993bb41d0be9d7db03346623a1549b09164df9d`。Guard seal attempt `6c7519d9-513b-44a0-83ab-1543e91c3866` PASS。新的 [HISTORY plan](package-ready/history-plan.json) 与 fixture manifest 已准备，保留原字节及实际 `/private/tmp/t059-history-ready-20260929` 输入位置。prepare 首次因 run root 尚未建立而 BLOCKED，建立要求的空目录后 PASS。未启动包、未采集任何新包截图、未执行新包 native entry，未获得 visual reviewer 或 owner PASS。用户确认可占用桌面后才继续。


## 暂停后恢复：实现与离线准备已完成（2026-09-29）

产品 `1997de467b7fbd32d0f2421019f01caa528842be` 已完成 Restore 确认与暂停时的分页 cursor 修复：Cancel 默认聚焦、取消零调用、确认绑定原目标、当前目标失效时保留说明并禁用确认；document 切换关闭确认。同时间戳跨页不再漏条目。HistoryPanel 32/32、typecheck、ESLint、Prettier、Rust fmt、分页回归 1/1、query integration 2/2、example 3/3 及适用 Clippy PASS。AppShell 首轮 2 PASS/1 FAIL 是新增错误文案断言与上层不确定结果提示不符；修正后仅重跑失败用例 1/1 PASS，次数和目标断言保留。

原始 [首轮输出](resume-20260929/restore-first-run.txt) 保留 pnpm 尾部日志，未冒充合法纯 JSON；[修后报告](resume-20260929/restore-retest.json)独立保留。所有这些均为自动/离线范围，不是 T048。

[Fixture manifest](resume-20260929/fixture-manifest.json)包含同一 profile 的正常 50 条 marked versions（25+25、3次 preview hydration）、独立 pending issue、单行 unavailable；被隔离的合成 scene bytes 保留在 quarantine，正常版本再查询仍完整。`nativeVerified:false` 表示 production 尚未实际读取/呈现该 profile。

[新 package manifest](resume-20260929/package-manifest.json)：production build/seal PASS，package SHA-256 `e3eab810dccb576ef7c4e31b08873e23ae6599db78bc77f7fa1d590d49717f59`，Guard attempt `82c051d1-2f0a-4992-a2ae-1cb5fa213f45`。该包含上述修复；旧 `c453f3f` 包不再是本轮候选。等待操作员同意桌面占用后执行真实原生验收。没有执行 adversarial review、VM/物理性能复跑；私有 specs 保持未提交。


## 本轮真实原生验收（2026-09-29）

当前 `1997de4` 包的 [History 原生入口报告](resume-20260929/native-entry-report.json) 13/13 PASS，Guard attempt `8fd5e94d-3dc3-45e5-a55f-b147e445c7f3`。首次 preflight 因证据未提交及 profile 摘要选择错误在启动前失败，修正后通过；不是产品失败。

[Owner walkthrough](resume-20260929/owner-walkthrough.json) 已明确确认列表/滚动、Preview、Restore 确认/Cancel、Light/Dark 紧凑宽度、菜单、Tab 焦点、pending/error 与 unavailable 提示正常。点击 Mark version 导致边栏高频跳跃是实际产品缺陷，正在针对性修复；owner 另要求优化 unavailable 虚线样式。Workspace 按钮不可用时，改用既有 single-instance 参数路由切换合成文件，pending 文件名/提示经真实 AX 确认。没有把准备器的离线结果当作原生结果。

本轮人工会话结束，合成数据和应用窗口保留；冲突、Reduce Motion 及修复后的定点观察尚未完成。T048/T054 未通过，性能不在本轮运行范围。

### 原生反馈后的定点修复

Mark mutation 后保留已显示的列表，避免 loading 状态卸载；相同 selection 的数据刷新不再强制 scroll/focus，延迟到达的新 selection 仍定位。More Actions 在 Mark busy 时保留可聚焦性并使用 aria-disabled，菜单与回调继续阻止重复操作。新增 [首轮失败报告](resume-20260929/mark-refresh-first.json.txt) 保留 disabled trigger 失焦证据；[定点复验](resume-20260929/mark-refresh-retest.json) 1/1 PASS。最终相关 HistoryPanel/HistoryList/HistoryStates/TabBar 共 66/66 PASS，typecheck、针对性 ESLint 通过。

Unavailable 使用实线卡片、danger token 警示图标与文字；History Retry 纳入现有按钮基础/primary/hover/disabled 样式，正常 empty 不显示重试；Tab 增加完整文件名标准 title 提示（旧 TabBar 提交已缺失，非 History 引入）。这些新改动的原生呈现尚待定点复查，未覆盖原包的历史 FAIL。

修复后新包从干净提交 `ce6e746d4d12cde55a498da83f45b3563c556e71` build/seal PASS：[manifest](resume-20260929/fixed-package-manifest.json)，package SHA-256 `fbdf374efd0bb9ff3b60ac1485dcc0b35c9d8d87bcd6bd5e8b2e6d983fe412cc`，Guard attempt `70020bae-3cb8-491e-ae11-7ff2b11a20a8`。未自动启动新包；需定点复查 Mark 稳定性、Unavailable/Retry 样式与 Tab hover。生产 build 的既有 chunk size warning 保留，不影响成功退出。

### 修复包第一次原生复查仍失败

[原生复查记录](resume-20260929/focused-native-recheck.json)：owner确认顶部及行菜单两种 Mark 均跳跃、Tab title仍不显示。核对仅有 PID83748，启动20:44:16、二进制SHA与 `ce6e746` 包一致；旧77399已退出，排除旧实例接管。AX静置/单次AXPress各30/50坐标样本未捕捉到变化，owner未留意自动点击；这不能推翻真实鼠标反馈。

限定调查未找到重复请求消费者。随后50行浏览器[诊断](resume-20260929/mark-geometry-before.txt)测出反馈插拔使列表移动47.59px，每入口仅1次mutation和1次list，无请求循环；Chromium未复现原生高频跳动。修复为持久反馈区域预留两行空间；[复验](resume-20260929/mark-geometry-after.txt)对两次顶部Mark和一次行操作的scrollTop、按钮及首行top采样均稳定，1个针对性用例PASS。HistoryPanel33/33、TabBar22/22与针对性ESLint通过。Tab改为portal DOM tooltip，支持hover/focus/Escape，避免依赖本次原生无效的title属性。原生高频弹跳是否消失仍待确认，不能从Chromium结果推出PASS。
