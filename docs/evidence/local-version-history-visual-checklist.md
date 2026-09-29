# Local Version History visual checklist

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

**Verdict at the current product checkpoint:** `BLOCKED` / `PENDING`.

The T004 and T048 design approvals above are complete. A qualifying visual verdict still
requires a freshly built exact macOS production `.app`, a stable 1280 × 760
window, and a human visual review on that package. The production `.app` for
`e873aac` was sealed and passed the separate T047 native-menu check. Its
`HISTORY-01` pre-remediation capture integrity passed, while the image shows
layout defects and has no independent human visual verdict. Revised T048 UI
requires a new exact package and new visual review.

### Package binding to record before review

| Fact               | Required record                                               | Current status                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product commit     | Full package source commit                                    | Candidate package sealed from `e873aac208e0271641cb2434f49daa4a6d2e01fd`                                                                                                                                                                                                                                                          |
| Production package | Absolute `.app` path, bundle ID, version                      | [Sealed T047 manifest](./local-version-history-t047/history-pass/package-manifest.json): `Excalidraw.app`, bundle ID `excalidraw-desktop`, version `0.3.0`, package SHA-256 `ef7ce6a97ad7c00da4d5524e36e8b1635e8c2ea8ee74d1798b84b067c8eaf162`; one old-package `HISTORY-01` pre-remediation collection, no revised package bound |
| Executable         | Absolute executable path and SHA-256                          | Old production executable SHA-256 `8e1772087bf27ac277d96b1a44a0f816650edaf0ff8822e06d38babdc03d2787`; revised package pending                                                                                                                                                                                                     |
| Environment        | macOS version/build, filesystem, display scale                | Old `HISTORY-01` environment recorded in [collection](./local-version-history-t048/history-01-pre-remediation/environment.json); revised package pending                                                                                                                                                                          |
| Window             | Native logical bounds, exactly 1280 × 760, two stable samples | Old `HISTORY-01` readiness recorded in [collection](./local-version-history-t048/history-01-pre-remediation/capture-readiness.json); revised package pending                                                                                                                                                                      |
| Review identity    | Reviewer and product-owner decision kept separate             | `PENDING`                                                                                                                                                                                                                                                                                                                         |

### Human review matrix

Review the following states on the exact package. Record `PASS`, `FAIL`, or
`BLOCKED` for every row and attach the package identity and reviewer report.
Do not infer a visual result from a browser screenshot, a unit test, the native
menu collector, or the approved design archive.

| State                                    | Required visual facts                                                                                                                                                                                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default History · Light · 360 px         | The drawer is right aligned; the canvas remains primary; filename, time, source, and summary are readable; the current drawing is separate from history rows, and Ready/marked status remains understandable without color alone; Preview and Restore remain visible. |
| More Actions · Light                     | The T048 180 × 116 px menu and 32 px trigger fit without clipping; the muted target heading, Mark/Unmark and Delete are readable; outline icons, destructive hierarchy and separator are clear.                                                                       |
| Version Preview · Light                  | `Preview — read only` is visible; the preview surface is visibly separate from the current drawing; Exit and Restore remain reachable; no current-canvas action is obscured.                                                                                          |
| Restore Confirmation · Light             | The confirmation hierarchy is clear; Cancel is visibly available and initially focused; the modal has no clipped text or action; closing returns focus to the triggering control.                                                                                     |
| Repeated Mark · Long List · Light        | The existing version receives clear reuse feedback; the selected target and Preview/Restore remain visible while a 50-row list scrolls; the canvas and history target remain distinct.                                                                                |
| External Recovery · Light                | The recovery issue, Preview, Save As…, Keep current file, and Discard recovery actions are readable; the destructive confirmation is distinct; no recovery artifact is implied to disappear without explicit action.                                                  |
| Compact History · Dark · 300 px fallback | The dark treatment preserves contrast and state labels; list rows and actions remain readable at the cramped width; no horizontal overflow or clipped essential action appears.                                                                                       |
| Error / conflict / pending / unavailable | The state title and recovery guidance are readable and visually distinct; the current drawing remains identifiable; retry or safe exit actions are not clipped; pending does not look like success.                                                                   |
| Keyboard focus and focus return          | The focused row, modal, More Actions menu, Preview, and Close controls have a visible focus indicator; Escape/close returns focus to the triggering control. This is a visual spot check only; keyboard behavior is owned by T023.                                    |
| Reduced motion                           | The required state remains understandable without relying on animation; no transition hides status or focus.                                                                                                                                                          |

### T048 采集范围

`HISTORY` 计划由 [History 状态清单](../../e2e/native/004-history-capture-fixtures.json)生成，绑定已批准的 high-fi/low-fi manifest、精确 production package 和每个状态的独立 profile。采集成功只证明包与窗口身份、隔离及截图完整性；以下每一行仍需独立人工结论。

| Human review matrix                      | 采集 gate                                                                     | 另需现场人工观察                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Default History · Light · 360 px         | `HISTORY-01`                                                                  | —                                                                                             |
| More Actions · Light                     | `HISTORY-02`                                                                  | —                                                                                             |
| Version Preview · Light                  | `HISTORY-03`                                                                  | —                                                                                             |
| Restore Confirmation · Light             | `HISTORY-04`                                                                  | 关闭后焦点返回触发控制                                                                        |
| External Recovery · Light                | `HISTORY-05`                                                                  | Discard recovery 二次确认的视觉层级                                                           |
| Compact History · Dark · 300 px fallback | `HISTORY-06`                                                                  | —                                                                                             |
| Error / conflict / pending / unavailable | `HISTORY-ERROR`、`HISTORY-CONFLICT`、`HISTORY-PENDING`、`HISTORY-UNAVAILABLE` | 四个状态分别给出结论                                                                          |
| Keyboard focus and focus return          | `HISTORY-FOCUS`（焦点行）                                                     | More Actions、Preview、modal Cancel、Close 的焦点外观及关闭后的焦点返回；键盘行为由 T023 负责 |
| Reduced motion                           | `HISTORY-REDUCED-MOTION`                                                      | —                                                                                             |

所有 gate 的状态建立方式均为 `operator-assisted`，不由 fixture 或 collector 自动证明。不能在 production package 上建立或观察的状态记为 `BLOCKED`，观察到不符则记为 `FAIL`；不得从其余截图推定通过。

### 视觉采集范围适配结论（2026-09-27）

- `HISTORY` 是独立于 003 `VSL` / `FINAL` 的采集计划；它只含上表 12 个 History gate，不带 HF2 六屏、T023b 原生菜单图谱或虚构的 PNG pixel baseline。六个 high-fi 画面绑定 frame ID，补充状态绑定获批 low-fi manifest；plan 同时绑定 registry、fixture、精确 production package 和各自 SHA-256。
- 聚焦的 prepare/capture 测试 **17/17 PASS**，ESLint、Prettier 和 `git diff --check` PASS；T047 封存包的 `HISTORY` prepare 及 capture 入口身份预检 PASS。此结论只覆盖范围与采集入口，不是 production 视觉 verdict。
- 首次正式采集没有已保存图纸，Version History 为 disabled；第二次虽有图纸，代理提示却引用产品中不存在的 `File > Open`。两次均在截图前停止，保留各自计划与空 collection。适配器现将 digest-bound 图纸作为 production executable 的启动参数，沿用 T047 已验证的打开路径。第三次 `HISTORY-01` capture integrity PASS，修复前截图及观察见 `docs/evidence/local-version-history-t048/`；这不是 T048 人工视觉结论。T048 高保真已获批，新包视觉审查仍待完成。

### Separate evidence owners for SC-008

- [T047 native menu evidence](./local-version-history-t045-t047.md) owns the
  exact-package macOS menu hierarchy, label, enabled state, and route facts.
  Its sealed production-package collection is 13/13 PASS; this does not prove
  the visual facts below.
- [T023 browser semantic test](../../e2e/tests/local-version-history-preview.spec.ts)
  owns list metadata, keyboard traversal, visible focus, preview exit, focus
  return, state roles, and reduced-motion assertions. Browser evidence is not
  a native-package visual verdict.
- **T048 visual evidence** owns the human observations in the matrix above:
  Light/Dark rendering, 1280 × 760 composition, readability, current versus
  preview distinction, error clarity, focus appearance, and clipping. It must
  remain a separate reviewer report and product-owner decision.

The production visual gate cannot be marked `PASS` until the package binding,
human matrix, independent visual-review verdict, and product-owner decision
are all recorded. Missing package or reviewer evidence remains `BLOCKED`;
observed mismatches remain `FAIL`.
