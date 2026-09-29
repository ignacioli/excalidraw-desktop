# Local Version History visual checklist

**最新实现（2026-09-29）**：`a50818ea8a8721a508fd306cef0c3ccc93081b32` 已实现负责人批准的 360→300 px drawer 拖动/键盘调整，并修复 Mark/Restore 样式。HistoryPanel 26/26、T027 5/5、T023 5/5、T048 browser 5/5 与 regression 2/2，以及 lint/typecheck/build 和 20 项 capture/prepare tests PASS；原始报告与边界见 [T059](local-version-history-t059/README.md)。production `.app` 已构建，但新包原生/视觉尚未执行；下述 `9c1e6a3` 原生 PASS 与视觉 FAIL 均属于旧候选，不能转移到新实现。所有原生启动/激活已按用户要求暂停。


**Current gate**: T004 low/high-fidelity baseline APPROVED; T048 revised low/high-fidelity APPROVED; production visual acceptance PENDING
**T004 low/high-fidelity owner approval date**: 2026-09-23
**T048 revised low-fidelity owner approval date**: 2026-09-27
**T048 revised high-fidelity owner approval date**: 2026-09-28; approved screens and token roles: [`docs/design/local-version-history/high-fi/t048/`](../design/local-version-history/high-fi/t048/README.md)

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

## Production visual acceptance

**Current verdict:** HISTORY-01 visual review `FAIL` on two HIGH style mismatches; capture integrity for that package is `PASS`. T048 has not passed. UI correction, new exact-package capture/review, the remaining required states, and the separate product-owner decision are pending. No correction is recorded as complete here.

The T004 and T048 design approvals are complete. The old `e873aac` package passed T047 native entry; its pre-remediation `HISTORY-01` image and verdict remain historical. The current package passed the separate T058 native entry check and produced a valid HISTORY-01 capture. The independent [HISTORY-01 review](./local-version-history-t048/window-repair-004/history01-review.md) found two HIGH style mismatches: Mark current button geometry/hierarchy and Restore primary accent styling. The capture is bound to product `9c1e6a37a10b72ec8213af9d3e45d81667ad73c7` and package SHA-256 `2420a8a8f5af8253c7ebcd90747e8e0430c1a7cee9d65585322c7e9e5e6aeae3`; see the [collection record](./local-version-history-t048/window-repair-004/README.md). The [capture incident report](./local-version-history-t048-harness-incident.md) records the earlier window-lookup block and separate HISTORY-06 geometry question. The approved interaction decision keeps the drawer at a 360 px default and permits edge dragging to 300 px at any viewport; it does not use a viewport breakpoint ([interaction contract](../design/local-version-history/interaction.md)).

### Package binding for review

| Fact | Required record | Current status |
| --- | --- | --- |
| Product commit | Full package source commit | `9c1e6a37a10b72ec8213af9d3e45d81667ad73c7` |
| Production package | Absolute `.app` path, bundle ID, version, hash | [T058 package manifest](./local-version-history-t058/postfix-003/package-manifest.json): `Excalidraw.app`, bundle ID `excalidraw-desktop`, version `0.3.0`, artifact SHA-256 `2420a8a8f5af8253c7ebcd90747e8e0430c1a7cee9d65585322c7e9e5e6aeae3` |
| Executable | Absolute path and SHA-256 | [T058 package manifest](./local-version-history-t058/postfix-003/package-manifest.json): SHA-256 `863cf487b9fbbceec3c1341f2a09b05c3a0f293334e7e92137daebdb753c8a81` |
| Environment | macOS version/build, filesystem, display scale | [HISTORY-01 collection](./local-version-history-t048/window-repair-004/collection-HISTORY-01/environment.json): macOS 26.6.2, arm64, backing scale 2; filesystem type is not recorded in this collection |
| Window | Native logical bounds, exactly 1280 × 760, two stable samples | [HISTORY-01 readiness](./local-version-history-t048/window-repair-004/collection-HISTORY-01/capture-readiness.json): logical 1280 × 760, frontmost, two stable samples; capture integrity PASS |
| Review identity | Independent reviewer and product-owner decision | Independent reviewer: [FAIL, two HIGH findings](./local-version-history-t048/window-repair-004/history01-review.md); product-owner decision: `PENDING` |

### Human review matrix

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

所有 gate 的状态建立方式均为 `operator-assisted`，不由 fixture 或 collector 自动证明。不能在 production package 上建立或观察的状态记为 `BLOCKED`，观察到不符则记为 `FAIL`；不得从其余截图推定通过。当前 capture 与两项 HIGH 样式不符均绑定 package `2420a8a8f5af8253c7ebcd90747e8e0430c1a7cee9d65585322c7e9e5e6aeae3`。较早窗口查询失败及修复分析见[incident report](./local-version-history-t048-harness-incident.md)；该报告中的 HISTORY-06 可达性问题由负责人随后作出独立尺寸决定：默认 360 px，可拖动至 300 px，不受视口 breakpoint 限制，参见[interaction contract](../design/local-version-history/interaction.md)。

### 视觉采集范围适配结论（2026-09-27）

- `HISTORY` 是独立于 003 `VSL` / `FINAL` 的采集计划；它只含上表 12 个 History gate，不带 HF2 六屏、T023b 原生菜单图谱或虚构的 PNG pixel baseline。六个 high-fi 画面绑定 frame ID，补充状态绑定获批 low-fi manifest；plan 同时绑定 registry、fixture、精确 production package 和各自 SHA-256。
- 聚焦的 prepare/capture 测试 **17/17 PASS**，ESLint、Prettier 和 `git diff --check` PASS；T047 封存包的 `HISTORY` prepare 及 capture 入口身份预检 PASS。此结论只覆盖范围与采集入口，不是 production 视觉 verdict。
- 首次正式采集没有已保存图纸，Version History 为 disabled；第二次虽有图纸，代理提示却引用产品中不存在的 `File > Open`。两次均在截图前停止，保留各自计划与空 collection。后续适配器将 digest-bound 图纸作为 production executable 的启动参数，沿用 T047 已验证的打开路径。第三次修复前 capture integrity PASS 和截图仍见 `docs/evidence/local-version-history-t048/`。当前 package `9c1e6a37a10b72ec8213af9d3e45d81667ad73c7` 的新 HISTORY-01 collection capture integrity PASS，但独立 reviewer 判定两项 HIGH 样式偏差为 FAIL；详见[审查报告](./local-version-history-t048/window-repair-004/history01-review.md)。UI 修复和新包复审待完成。

### Separate evidence owners for SC-008

- [T047 native menu evidence](./local-version-history-t045-t047.md) owns the
  exact-package macOS menu hierarchy, label, enabled state, and route facts.
  The old package and [T058 revised-package collection](./local-version-history-t058/final-pass-002/collection/native-report.json)
  each have a separate 13/13 PASS; neither proves the visual facts below.
- [T023 browser semantic test](../../e2e/tests/local-version-history-preview.spec.ts)
  owns list metadata, keyboard traversal, visible focus, preview exit, focus
  return, state roles, and reduced-motion assertions. Browser evidence is not
  a native-package visual verdict.
- **T048 visual evidence** owns the human observations in the matrix above:
  Light/Dark rendering, 1280 × 760 composition, readability, current versus
  preview distinction, error clarity, focus appearance, and clipping. The
  current HISTORY-01 reviewer verdict is FAIL; the independent [review report](./local-version-history-t048/window-repair-004/history01-review.md)
  records two HIGH style mismatches. The product-owner decision remains
  separate and pending.

The production visual gate cannot be marked `PASS` until the package binding,
human matrix, independent visual-review verdict, and product-owner decision
are all recorded. Missing package or reviewer evidence remains `BLOCKED`;
observed mismatches remain `FAIL`.
