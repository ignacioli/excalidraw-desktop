# T048 HISTORY-01 独立视觉审查（2026-09-29）

**Verdict：FAIL（HISTORY-01 视觉范围）。** 我没有编写或修改本次审查的 production UI。采集器的 `PASS` 仅证明 capture integrity；本报告不将操作员的状态准备、截图或原生入口检查解释为键盘、保存、Mark 语义或产品负责人接受。当前画面有两项已批准组件 token 的 HIGH 偏差。

**复核更正：** 首次审查把未知历史实施 agent 身份、操作员触发的重复 Mark 反馈列为 blocking，并把原生 titlebar 与画板顶边差异计入 mismatch。复核当前 004 的 [视觉 checklist](../../local-version-history-visual-checklist.md) 与 [HISTORY-01 fixture](../../../../e2e/native/004-history-capture-fixtures.json) 后，这三项分别改为 provenance 未验证、允许的准备上下文、几何合同澄清项。首次观察不作为产品缺陷或本画面 FAIL 的依据；以下两项组件样式偏差单独足以判 FAIL。

## 身份与范围

| 项目 | 本轮记录 |
| --- | --- |
| Product commit | `9c1e6a37a10b72ec8213af9d3e45d81667ad73c7`（采集绑定；审查时工作树 HEAD 为 harness 提交 `854c48e9ab6a38961c6f7c9679b6b3a6c4191fb7`） |
| Build | production `Excalidraw.app`，bundle ID `excalidraw-desktop`，版本/build `0.3.0`，artifact SHA-256 `2420a8a8f5af8253c7ebcd90747e8e0430c1a7cee9d65585322c7e9e5e6aeae3` |
| 环境 | macOS 26.6.2 / arm64，backing scale 2；owned PID `14579`、window ID `5502`；逻辑窗口及截图均为 1280 × 760；Light；合成 `004-history-capture-v1` fixture，`operator-assisted` |
| 采集 | [`collection-HISTORY-01`](collection-HISTORY-01/collector-report.json)，capture integrity `PASS`；collection digest `a4db47bdeb17c503b84ca214a8bd23d41878a22eccf5181ce095e40bf0447620` |
| 实际图 | [`actual.png`](collection-HISTORY-01/actual.png)，SHA-256 `fc16509157d6b55a3212795bed95dbc6420236113757be40606301fd672a6423`（仓库副本已复算） |
| 批准画板 | [`T048 · 01 · History · Default · Light`](../../../design/local-version-history/high-fi/t048/screens/01-history-default-light.png)，shape `da9cf473-5dad-8097-8008-b502ce235a48`，PNG SHA-256 `c29664c9aa1887901e74f8311d532ce58ba2e323b7f286e5bfcf77dbe46ff84d`；[manifest](../../../design/local-version-history/high-fi/t048/manifest.json) SHA-256 `7e50c65e24b66df8eb0a2840e2bf7b714a26ebfbb0f6dc8f8e423eeb819dd8dc` |
| Provenance | Production UI 实施 agent/task：**未知、未验证**；Git author 不证明具体 agent 身份。本轮 reviewer：`/root/history01_visual`，未参与 `9c1e6a3` 的 production UI 实施，独立于当前 `/root` 的采集与 harness 修复工作。当前 004 checklist 要求独立 reviewer 报告，未将历史实施 agent 身份列为 HISTORY-01 视觉 PASS 的前置字段。 |

## Screen matrix

| Screen | 状态 | 可见 mismatch | 证据 |
| --- | --- | ---: | --- |
| HISTORY-01 · Default · Light | **FAIL** | 2 项 HIGH | [实际图](collection-HISTORY-01/actual.png)、[批准画板](../../../design/local-version-history/high-fi/t048/screens/01-history-default-light.png) |

画面中右侧 drawer 宽约 360 px，Current Drawing 独立卡、文件名、所选版本时间/来源/摘要、`Ready` 与 `Marked` 文本、底部 Preview/Restore 均可见；这些事实只覆盖静态可读性。当前只有一条保存版本，与批准画板示例的 50 条不同；fixture 内容/时间/文件名不同本身**不计 mismatch**，长列表数量属于 HISTORY-05。

## Findings

1. **HIGH · HISTORY-01 Mark current 控件几何和视觉层级偏离批准 token。** [`tokens.json`](../../../design/local-version-history/high-fi/t048/tokens.json) 指定 `markCurrentButton.height = 30`、panel 背景、strong border；批准画板的按钮位于列表标题右侧。实际图在 Current Drawing 卡下方呈约一行文字高的小灰色胶囊，缺少批准的 30 px 按钮边界及层级。[`HistoryPanel.tsx`](../../../../src/history/HistoryPanel.tsx) 的 Mark button 没有专用 class，[`history.css`](../../../../src/history/history.css) 的 `.history-current-actions button` 只设置 `justify-self: start`，与截图一致。复现：用本 collection 绑定的 production `.app` 和 synthetic fixture，打开右侧 History，查看 `Mark current version`。证据：[实际图](collection-HISTORY-01/actual.png)、[批准画板](../../../design/local-version-history/high-fi/t048/screens/01-history-default-light.png)。
2. **HIGH · HISTORY-01 Restore 主按钮丢失 accent 层级。** 批准 [`tokens.json`](../../../design/local-version-history/high-fi/t048/tokens.json) 指定 `selectedVersionActions.primaryFill = color.accent.base`、`primaryText = color.accent.contrast`；批准画板的 Restore 为紫色主按钮。实际图的 `Restore this version` 与 Preview 同为灰色次级按钮。[`HistoryPanel.tsx`](../../../../src/history/HistoryPanel.tsx) 虽给 Restore `className="primary-action"`，但 [`history.css`](../../../../src/history/history.css) 的 `.history-selection-actions button`（specificity `0,1,1`）覆盖 [`App.css`](../../../../src/App.css) 的 `.primary-action`（`0,1,0`）的颜色和背景；hover 选择器也有同类覆盖。复现同上，查看固定底部 Preview/Restore。证据：[实际图](collection-HISTORY-01/actual.png)、[批准画板](../../../design/local-version-history/high-fi/t048/screens/01-history-default-light.png)。

## Masks、tolerances 与未验证项

采集 [`mask.json`](collection-HISTORY-01/mask.json) 声明 `masks: []`，本审查未加 mask。未运行像素 diff，也未使用 raster tolerance；设计差异按层级与 token 几何直接评审。截图含 `Already marked. Selected the existing version.`，这是操作员准备 fixture 时重复 Mark 的上下文；004 HISTORY-01 checklist 未禁止此反馈，且其出现本身不算产品偏差。实际 native capture 的 drawer 顶边约 y=76，而批准画板/交互合同从 tabs 下方 y=36 开始；原生 titlebar 是否计入画板仍需合同澄清，此观察不计本轮 mismatch。collection 未给出 `document.fonts.ready` 的独立证明，因此不主张字体或 raster parity。未实测 hover、focus-visible、键盘、退出后的焦点返回、screen reader 名称、reduced motion、Mark/Restore 行为或长列表滚动；这些须由各自 state/语义证据承担。产品负责人对 production 视觉的决定仍为 PENDING。

**Next gate：** 修复 Mark 与 Restore 的批准 token 表现，从新产品提交构建并绑定精确包，重新采集 HISTORY-01，由独立 reviewer 复核。原生 titlebar 几何边界与历史实施 agent 身份分别作为澄清/未验证项留存，不替代产品负责人对全部状态的单独接受。
