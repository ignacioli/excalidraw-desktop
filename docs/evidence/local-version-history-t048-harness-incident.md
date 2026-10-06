# T048 capture incident review（2026-09-29）

**INCIDENT / REVIEW_REQUIRED。** 触发为修复后 production package 的 HISTORY-01 在操作员确认后报告 `expected exactly one CoreGraphics owned window`，没有截图。产品 commit `9c1e6a37a10b72ec8213af9d3e45d81667ad73c7`，package SHA-256 `2420a8a8f5af8253c7ebcd90747e8e0430c1a7cee9d65585322c7e9e5e6aeae3`；旧尝试见 [postfix-003](local-version-history-t058/postfix-003/README.md)。本轮重新计算 package digest 一致。

本 review 限于窗口确认路径及其后必经的 compact 状态建立路径，不重新审查其他已完成行为，也不改变批准范围。

**最新进展**：修复后同包 HISTORY-01 capture integrity PASS，原始 collection 与独立视觉 FAIL 见 [window-repair-004](local-version-history-t048/window-repair-004/README.md)。2026-09-29 负责人否决以窄窗口迁就旧 breakpoint 的方向，明确“默认360，允许拖动边缘缩至300”；该决定已进入[交互合同](../design/local-version-history/interaction.md)。因此 finding 2 已完成 owner 决策，后续归 `PRODUCT_CHANGE_REQUIRED`，保持 1280×760，不再等待范围变更批准。下表保留发现时的分流记录。

## Findings

| # | Severity | Remediation target | Required before | Check | Artifact:loc | Mechanical evidence | Issue | Proof owner | Mechanism | Explicit DONE | Action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | HIGH | HARNESS_CHANGE_REQUIRED | T048 capture | 8 | `scripts/native-screen-capture.mjs:376`; `scripts/native-screen-window.swift:73` | 原有 20 次稳定采样循环遇首次 helper 错误立即抛出；激活/raise 后立即查询 on-screen CG windows；历史错误未记录数量 | 有界轮询无法处理短暂零窗口，失败信息不能区分零个/多个 | capture harness | AX + CoreGraphics metadata | 零窗口有界重试；多窗口及无效几何仍阻断；仍要求两次连续稳定样本与前后相同窗口 ID | 已以 `854c48e` 修复；13/13 定向测试、Swift 编译通过，实机结果单独记录 |
| 2 | HIGH | OWNER_DECISION_REQUIRED | HISTORY-06 / T048 | 8 | `e2e/native/004-history-capture-fixtures.json:55`; `scripts/native-screen-prepare.mjs:865`; `src/app/AppShell.tsx:1605`; `src/history/history.css:454`; `e2e/tests/local-version-history-t048.spec.ts:129` | 所有 capture viewport 固定 1280×760；HISTORY-06 要求 300 px；生产 AppShell 不传 compact，CSS 仅 viewport ≤420 px 生效；已有 browser compact 测试实际用 360×760 | 当前 capture 操作步骤无法在声明尺寸建立 compact；browser 测试并未证明该原生组合 | 产品响应式行为与验收范围负责人 | source + viewport contract + browser test | 明确真实触发条件、对应 native 几何及批准范围，再验证该路径 | 保留 BLOCKED，选择修复产品入口或批准 compact 使用独立窄窗口几何；不以 DOM 注入、改图或默认 drawer 截图代替 |

第二项与已批准高保真 [T048 README](../design/local-version-history/high-fi/t048/README.md)（六个画板均 1280×760，含 compact300）和私有 feature `spec.md` SC-010 对应。这是实质的生产可达状态与验收组合缺口；不能仅把画板尺寸解释为截图尺寸而跳过产品触发条件。尚未获授权选择新增 compact 用户入口或修改批准的原生几何，因此未改产品或 specs。

## 原因边界与后续判断

- 旧 HISTORY-01 缺少窗口计数，因此不能追溯断言当时是零窗口，也不能据此认定 macOS 或产品失效。修复后错误包含 `onscreen`、`all`、`active`，一次新尝试即可区分，禁止原样盲试。
- 新 run root 必须重新编译 helper；旧 run root 会复用已有 executable，且已用 profile 不能重新作 fresh profile。修复后的 production package 无变化，原生入口 13/13 证据继续按原范围保留。
- 其余 error/conflict/pending/unavailable gate 只有 operator-assisted 清单，尚未完成生产状态准备的可执行性验证。此处保留为风险，不把尚未证明不可达的状态列作缺陷。
- 当前 2 项 HIGH：check 8 两项；第一项是已修复、待实机判别的 harness 缺陷，第二项需要 owner 明确 compact 验收组合。没有证据要求重写整套 specs。人工视觉结论及 T054 最终接受仍由各自负责人提供。
