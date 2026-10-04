# Local Version History visual checklist

**当前状态与证据：** 以[本地版本历史验证索引](local-version-history-validation-index.md)为 Feature 004 唯一当前状态入口。本表只定义 T048 视觉 walkthrough 的观察范围、流程和证据边界；具体 PASS/FAIL/BLOCKED 及包身份不在此重复维护。

T048 当前接受范围包含 Light/Dark、1280 × 760、默认 360 px 与可调整到 300 px、列表及行操作、Preview/Restore、异常提示、焦点外观和 reduced motion。集中 walkthrough 的真实结果与 package 边界见索引所链接的[owner 原始记录](local-version-history-t059/component-first/inline-feedback/owner-walkthrough.json)。历史准备失败、旧包 FAIL/BLOCKED 和旧审批仍保留在下方记录，均不得覆盖当前索引。


## 2026-09-29 walkthrough snapshot (historical)

The following filled record describes the package and owner session from 2026-09-29. It is preserved for traceability; use the current validation index above for today's verdict.

**Gate at that time**: T004 low/high-fidelity baseline APPROVED; T048 revised low/high-fidelity APPROVED; production visual acceptance pending focused Mark fix
**T004 low/high-fidelity owner approval date**: 2026-09-23
**T048 revised low-fidelity owner approval date**: 2026-09-27
**T048 revised high-fidelity owner approval date**: 2026-09-28; approved screens and token roles: [current high-fi package](../design/local-version-history/high-fi/README.md)

## Walkthrough procedure: one owner session

Use this section for the next production-package visual acceptance. The policy decision and evidence split are recorded in the [native visual validation contract](local-version-history-acceptance-contract.md). The per-screen collection matrix below is retained as the historical T048 plan; it is not a requirement to create a separate capture, collection, or AI review for every row.

The walkthrough uses one identified production package and one owner session. Keep the approved visual scope: Light and Dark, native 1280 × 760 window geometry, the 360 px default History drawer and its user-resizable 300 px width, long-list behavior, recovery/error states, visible focus treatment, and reduced-motion presentation. Combine states into the small number of sessions below when they can be reached from the same package and setup. The owner records one result for each check. Screenshots are optional diagnostic attachments when a visual issue needs to be located; they are not per-row completion artifacts.

Do not launch or activate the packaged app until the operator has confirmed that the desktop is available, as required by the decision record. Complete package preparation and state preparation before arranging the walkthrough. If a required state cannot be established or inspected, record `BLOCKED`, the reason, and the next preparation step; do not infer `PASS`. Record an observed mismatch as `FAIL` with a concise description. A browser result may inform preparation but cannot fill in a native-package result.

### Historical filled walkthrough record (2026-09-29)

Record package and environment details once, then complete each row during the same owner walkthrough. Add rows only when an observed issue requires a focused recheck; do not expand the session into a new full per-screen review by default.

| Session record (once) | Result |
| --- | --- |
| Product commit | `1997de467b7fbd32d0f2421019f01caa528842be` |
| Production `.app` path, bundle ID, version, package SHA-256 | [Package manifest](local-version-history-t059/resume-20260929/package-manifest.json); `excalidraw-desktop` / `0.3.0` / `e3eab810dccb576ef7c4e31b08873e23ae6599db78bc77f7fa1d590d49717f59` |
| macOS version/build, architecture, filesystem, display/backing scale |  |
| Native window logical bounds (must be 1280 × 760), display arrangement |  |
| Walkthrough date/time and owner | 2026-09-29; product owner in this chat; [逐项原始反馈](local-version-history-t059/resume-20260929/owner-walkthrough.json) |
| Package launch confirmation / desktop availability | Owner: “现在开始原生验收”; normal window, no always-on-top |

| Check (same package; group into one walkthrough) | Required observation | Result (`PASS` / `FAIL` / `BLOCKED`) | Issue, blocked reason, or follow-up |
| --- | --- | --- | --- |
| Light baseline · 360 px | At 1280 × 760, drawer is right aligned and canvas remains primary; filename/time/source/summary and Ready/marked state are readable without color alone; current drawing is distinct from history; Preview and Restore are visible. |  |  |
| Light actions and preview | More Actions menu fits without clipping and preserves readable target, Mark/Unmark, Delete, icon and destructive hierarchy; readonly Preview is identified and distinct from the current drawing; Exit and Restore remain reachable. |  |  |
| Restore confirmation and focus | Confirmation hierarchy and Cancel are clear; initial focus is visible; closing returns focus to the triggering control; focused row, menu, Preview, and Close have visible focus treatment. T023 remains the owner of keyboard behavior. |  |  |
| Resized drawer · 300 px | At the same 1280 × 760 native geometry, drag the drawer edge to 300 px. Essential row content and actions remain readable and reachable, with no horizontal overflow or clipping; the 360 px default remains the initial state. | PASS | Owner confirmed readable, usable, no clipping in Light/Dark at minimum drawer width. |
| Long list and repeated Mark | In a 50-row list, repeated Mark gives clear reuse feedback; the selected target and Preview/Restore stay understandable while scrolling; canvas and history target remain distinct. | FAIL | List and scrolling normal; Mark causes high-frequency sidebar jumping. Focused fix and native recheck required. |
| Existing crash Recovery | Preserve existing recovery/conflict safety evidence. The owner withdrew the extra History-specific recovery flow on 2026-09-29. Recheck native presentation only when this change materially affects the existing Recovery UI; record the impact decision rather than inventing a new screen. |  |  |
| Dark · 300 px | Dark treatment preserves contrast and state labels at 300 px; rows and actions remain readable without horizontal overflow or clipped essential actions. | PASS | Owner confirmed readable, usable, no clipping in Light/Dark at minimum drawer width. |
| Error state | Error title and recovery guidance are distinct and readable; drawing identity remains clear; safe or retry actions are reachable. |  |  |
| Conflict state | Conflict and recovery guidance are distinct and readable; drawing identity remains clear; safe resolution actions are reachable. |  |  |
| Pending state | Pending state and guidance are readable; it does not look successful and does not hide the drawing identity or safe actions. | PASS | Pending reconciliation renders as explicit error guidance; owner confirmed readable filename, message and actions. |
| Unavailable-resource state | Resource-unavailable guidance is distinct and readable; drawing identity remains clear; safe or retry actions are reachable. | PASS | Owner confirmed clear state and safe action availability; separately requested solid-border warning styling refinement. |
| Reduced motion | With reduced motion enabled, status and focus remain understandable without animation; transitions do not hide either. |  |  |
| Walkthrough issues / focused recheck | Link any diagnostic screenshot or issue note if useful; state which affected check was re-opened and its result. No screenshot is required when there is no issue to diagnose. |  |  |

**Walkthrough outcome:** `FAIL` for Mark-induced sidebar jumping; other unrecorded observations remain pending. See the owner record for passed subsets. Completion requires every required row to have a recorded result; any required `BLOCKED` row leaves the visual gate blocked, and any `FAIL` row leaves it failed pending a focused correction and recheck. Record the owner's acceptance decision separately; this checklist does not convert an implementation, browser, capture-integrity, or T047/T058 result into owner acceptance.

**2026-09-29 owner decision:** existing crash-draft Recovery remains authoritative. Historical External recovery artifact designs below are not new implementation or native-acceptance requirements. Recovery and conflict safety checks remain required.

## T004 low-fidelity decision record (historical baseline)

- [x] 360 px right-side History drawer approved.
- [x] 300 px retained only as cramped fallback.
- [x] Canvas remains the primary surface.
- [x] Preview and Restore remain directly visible.
- [x] Mark/Unmark and Delete version use an accessible vertical-ellipsis menu.
- [x] Current, selected, preview, and marked states do not rely on color alone.
- [x] Restore, Delete, and Discard recovery use confirmation.
- [x] External recovery is not automatically deleted before an explicit decision.
- [x] Keyboard focus trap and focus-return paths are represented and exercised in the prototype.
- [x] Loading, empty, pending, permission, resource, conflict, generic error, dark, cramped, and reduced-motion states are represented.
- [x] Review-only state navigator is not production UI.

## T004 high-fidelity review (historical baseline)

- [x] Penpot file/page identity verified before writes.
- [x] Light history list and readonly preview approved.
- [x] Dark history treatment and readonly-preview visual direction approved.
- [x] External recovery issue and confirmation flow approved.
- [x] Permission/resource/conflict/error states retain the approved low-fidelity hierarchy and high-fidelity semantic-token treatment.
- [x] 1280 × 760 geometry and text truncation approved.
- [x] 360 px default and 300 px cramped fallback approved visually.
- [x] More actions menu, focus behavior, destructive hierarchy, and vector icon treatment approved; final menu is 180 × 84 px.
- [x] High-fidelity Penpot archive frozen locally with manifest and SHA-256.

The T004 baseline and T048 refinement each have six independently approved high-fidelity frames. T048's approved source, screen digests and token-role mapping are in `docs/design/local-version-history/high-fi/t048/`. The low-fidelity prototype remains the exhaustive interaction-state reference for loading, empty, permission, unavailable-resource, conflict, generic-error, delete-confirmation, focus-return, and reduced-motion behavior. Production rendering remains in the package-level gate below.

## Production visual acceptance snapshot (historical; see the index above for current status)

**Verdict at that time:** HISTORY-01 visual review `FAIL` on two HIGH style mismatches; capture integrity for that package is `PASS`. This was the old package result before the 2026-10-04 owner walkthrough and focused copy correction. It remains bound to the package below and does not state today's T048 verdict.

The T004 and T048 design approvals are complete. The old `e873aac` package passed T047 native entry; its pre-remediation `HISTORY-01` image and verdict remain historical. The current package passed the separate T058 native entry check and produced a valid HISTORY-01 capture. The independent [HISTORY-01 review](./local-version-history-t048/window-repair-004/history01-review.md) found two HIGH style mismatches: Mark current button geometry/hierarchy and Restore primary accent styling. The capture is bound to product `9c1e6a37a10b72ec8213af9d3e45d81667ad73c7` and package SHA-256 `2420a8a8f5af8253c7ebcd90747e8e0430c1a7cee9d65585322c7e9e5e6aeae3`; see the [collection record](./local-version-history-t048/window-repair-004/README.md). The [capture incident report](./local-version-history-t048-harness-incident.md) records the earlier window-lookup block and separate HISTORY-06 geometry question. The approved interaction decision keeps the drawer at a 360 px default and permits edge dragging to 300 px at any viewport; it does not use a viewport breakpoint ([interaction contract](../design/local-version-history/interaction.md)).

### Package binding for review

| Fact | Required record | Current status |
| --- | --- | --- |
| Product commit | Full package source commit | `9c1e6a37a10b72ec8213af9d3e45d81667ad73c7` |
| Production package | Absolute `.app` path, bundle ID, version, hash | [T058 package manifest](./local-version-history-t058/postfix-003/package-manifest.json): `Excalidraw.app`, bundle ID `excalidraw-desktop`, version `0.3.0`, artifact SHA-256 `2420a8a8f5af8253c7ebcd90747e8e0430c1a7cee9d65585322c7e9e5e6aeae3` |
| Executable | Absolute path and SHA-256 | [T058 package manifest](./local-version-history-t058/postfix-003/package-manifest.json): SHA-256 `863cf487b9fbbceec3c1341f2a09b05c3a0f293334e7e92137daebdb753c8a81` |
| Environment | macOS version/build, filesystem, display scale | [HISTORY-01 collection](./local-version-history-t048/window-repair-004/collection-HISTORY-01/environment.json): macOS 26.6.2, arm64, backing scale 2; filesystem type is not recorded in this collection |
| Window | Native logical bounds, exactly 1280 × 760, two stable samples | [HISTORY-01 readiness](./local-version-history-t048/window-repair-004/collection-HISTORY-01/capture-readiness.json): logical 1280 × 760, frontmost, two stable samples; capture integrity PASS |
| Review identity | Independent reviewer and product-owner decision | Historical package reviewer: [FAIL, two HIGH findings](./local-version-history-t048/window-repair-004/history01-review.md); product-owner decision at that time: `PENDING` |

### Historical per-screen review matrix

Review the following states on the exact package. Record `PASS`, `FAIL`, or
`BLOCKED` for every row and attach the package identity and reviewer report.
Do not infer a visual result from a browser screenshot, a unit test, the native
menu collector, or the approved design archive.

| State                                    | Required visual facts                                                                                                                                                                                                                                                 | Current evidence |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Default History · Light · 360 px         | The drawer is right aligned; the canvas remains primary; filename, time, source, and summary are readable; the current drawing is separate from history rows, and Ready/marked status remains understandable without color alone; Preview and Restore remain visible. | Capture integrity `PASS`; reviewer `FAIL`, two HIGH style mismatches. |
| More Actions · Light                     | The T048 180 × 116 px menu and 32 px trigger fit without clipping; the muted target heading, Mark/Unmark and Delete are readable; outline icons, destructive hierarchy and separator are clear.                                                                       | Pending capture/review. |
| Version Preview · Light                  | `Preview — read only` is visible; the preview surface is visibly separate from the current drawing; Exit and Restore remain reachable; no current-canvas action is obscured.                                                                                          | Pending capture/review. |
| Restore Confirmation · Light             | The confirmation hierarchy is clear; Cancel is visibly available and initially focused; the modal has no clipped text or action; closing returns focus to the triggering control.                                                                                     | Pending capture/review. |
| Repeated Mark · Long List · Light        | The existing version receives clear reuse feedback; the selected target and Preview/Restore remain visible while a 50-row list scrolls; the canvas and history target remain distinct.                                                                                | Pending capture/review. |
| External Recovery · Light                | The recovery issue, Preview, Save As…, Keep current file, and Discard recovery actions are readable; the destructive confirmation is distinct; no recovery artifact is implied to disappear without explicit action.                                                  | Pending manual review. |
| Compact History · Dark · 300 px fallback | The dark treatment preserves contrast and state labels; list rows and actions remain readable at the cramped width; no horizontal overflow or clipped essential action appears.                                                                                       | Pending capture/review. |
| Error / conflict / pending / unavailable | The state title and recovery guidance are readable and visually distinct; the current drawing remains identifiable; retry or safe exit actions are not clipped; pending does not look like success.                                                                   | Pending capture/review. |
| Keyboard focus and focus return          | The focused row, modal, More Actions menu, Preview, and Close controls have a visible focus indicator; Escape/close returns focus to the triggering control. This is a visual spot check only; keyboard behavior is owned by T023.                                    | Pending visual spot-check; keyboard behavior remains T023-owned. |
| Reduced motion                           | The required state remains understandable without relying on animation; no transition hides status or focus.                                                                                                                                                          | Pending capture/review. |

### T048 采集范围

`HISTORY` 计划由 [History 状态清单](../../e2e/native/004-history-capture-fixtures.json)生成，绑定已批准的 high-fi/low-fi manifest、精确 production package 和每个状态的独立 profile。采集成功只证明包与窗口身份、隔离及截图完整性；以下每一行仍需独立人工结论。

| Human review matrix                      | 采集 gate                                                                     | 另需现场人工观察                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Default History · Light · 360 px         | `HISTORY-01`                                                                  | Capture integrity PASS; independent review FAIL (two HIGH); new package/capture required after correction |
| More Actions · Light                     | `HISTORY-02`                                                                  | Capture and review pending                                                                     |
| Version Preview · Light                  | `HISTORY-03`                                                                  | —                                                                                             |
| Restore Confirmation · Light             | `HISTORY-04`                                                                  | 关闭后焦点返回触发控制                                                                        |
| Repeated Mark · Long List · Light        | `HISTORY-05`                                                                  | —                                                                                             |
| External Recovery · Light                | —                                                                             | 按 T004 基线现场单独核对 recovery 与 Discard 二次确认；`HISTORY-05` 不代表此状态              |
| Compact History · Dark · 300 px fallback | `HISTORY-06`                                                                  | —                                                                                             |
| Error / conflict / pending / unavailable | `HISTORY-ERROR`、`HISTORY-CONFLICT`、`HISTORY-PENDING`、`HISTORY-UNAVAILABLE` | 四个状态分别给出结论                                                                          |
| Keyboard focus and focus return          | `HISTORY-FOCUS`（焦点行）                                                     | More Actions、Preview、modal Cancel、Close 的焦点外观及关闭后的焦点返回；键盘行为由 T023 负责 |
| Reduced motion                           | `HISTORY-REDUCED-MOTION`                                                      | —                                                                                             |

所有 gate 的状态建立方式均为 `operator-assisted`，不由 fixture 或 collector 自动证明。不能在 production package 上建立或观察的状态记为 `BLOCKED`，观察到不符则记为 `FAIL`；不得从其余截图推定通过。该历史 capture 与两项 HIGH 样式不符均绑定 package `2420a8a8f5af8253c7ebcd90747e8e0430c1a7cee9d65585322c7e9e5e6aeae3`。较早窗口查询失败及修复分析见[incident report](./local-version-history-t048-harness-incident.md)；该报告中的 HISTORY-06 可达性问题由负责人随后作出独立尺寸决定：默认 360 px，可拖动至 300 px，不受视口 breakpoint 限制，参见[interaction contract](../design/local-version-history/interaction.md)。

### 视觉采集范围适配结论（2026-09-27）

- `HISTORY` 是独立于 003 `VSL` / `FINAL` 的采集计划；它只含上表 12 个 History gate，不带 HF2 六屏、T023b 原生菜单图谱或虚构的 PNG pixel baseline。六个 high-fi 画面绑定 frame ID，补充状态绑定获批 low-fi manifest；plan 同时绑定 registry、fixture、精确 production package 和各自 SHA-256。
- 聚焦的 prepare/capture 测试 **17/17 PASS**，ESLint、Prettier 和 `git diff --check` PASS；T047 封存包的 `HISTORY` prepare 及 capture 入口身份预检 PASS。此结论只覆盖范围与采集入口，不是 production 视觉 verdict。
- 首次正式采集没有已保存图纸，Version History 为 disabled；第二次虽有图纸，代理提示却引用产品中不存在的 `File > Open`。两次均在截图前停止，保留各自计划与空 collection。后续适配器将 digest-bound 图纸作为 production executable 的启动参数，沿用 T047 已验证的打开路径。第三次修复前 capture integrity PASS 和截图仍见 `docs/evidence/local-version-history-t048/`。当时 package `9c1e6a37a10b72ec8213af9d3e45d81667ad73c7` 的新 HISTORY-01 collection capture integrity PASS，但独立 reviewer 判定两项 HIGH 样式偏差为 FAIL；详见[审查报告](./local-version-history-t048/window-repair-004/history01-review.md)。后续 UI 修复与 2026-10-04 owner walkthrough 结论见当前验证索引。

### Separate evidence owners for SC-008

- [T047 native menu evidence](./local-version-history-t045-t047.md) owns the
  exact-package macOS menu hierarchy, label, enabled state, and route facts.
  The old package and [T058 revised-package collection](./local-version-history-t058/final-pass-002/collection/native-report.json)
  each have a separate 13/13 PASS; neither proves the visual facts below.
- [T023 browser semantic test](../../e2e/tests/local-version-history-preview.spec.ts)
  owns list metadata, keyboard traversal, visible focus, preview exit, focus
  return, state roles, and reduced-motion assertions. Browser evidence is not
  a native-package visual verdict.
- **T048 visual evidence (historical package)** owns the observations in the
  matrix above:
  Light/Dark rendering, 1280 × 760 composition, readability, current versus
  preview distinction, error clarity, focus appearance, and clipping. The
  old HISTORY-01 reviewer verdict was FAIL; the independent [review report](./local-version-history-t048/window-repair-004/history01-review.md)
  records two HIGH style mismatches. The product-owner decision remains
  separate and pending.

The former gate definition above required an independent visual-review verdict
for the per-screen matrix. Under the current execution contract at the top of
this document, a new production visual gate can be marked `PASS` after the
package binding and all required walkthrough checks are recorded and the
product owner records acceptance. A separate AI reviewer report is not a
required artifact. Missing package identity or an unestablished required state
remains `BLOCKED`; an observed mismatch remains `FAIL`. The old package's
reviewer `FAIL` remains an immutable historical result and does not decide the
new package's verdict.
