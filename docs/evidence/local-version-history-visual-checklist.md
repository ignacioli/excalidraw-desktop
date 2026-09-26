# Local Version History visual checklist

**Current gate**: Low-fidelity and high-fidelity APPROVED; production visual acceptance PENDING
**Low-fidelity owner approval date**: 2026-09-23
**High-fidelity owner approval date**: 2026-09-23

## Low-fidelity decision record

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

## High-fidelity review

- [x] Penpot file/page identity verified before writes.
- [x] Light history list and readonly preview approved.
- [x] Dark history treatment and readonly-preview visual direction approved.
- [x] External recovery issue and confirmation flow approved.
- [x] Permission/resource/conflict/error states retain the approved low-fidelity hierarchy and high-fidelity semantic-token treatment.
- [x] 1280 × 760 geometry and text truncation approved.
- [x] 360 px default and 300 px cramped fallback approved visually.
- [x] More actions menu, focus behavior, destructive hierarchy, and vector icon treatment approved; final menu is 180 × 84 px.
- [x] High-fidelity Penpot archive frozen locally with manifest and SHA-256.

The approved Penpot page contains six necessary high-fidelity frames. The low-fidelity prototype remains the exhaustive interaction-state reference for loading, empty, permission, unavailable-resource, conflict, generic-error, delete-confirmation, focus-return, and reduced-motion behavior. Production rendering of those states remains in the package-level gate below.

## Production visual acceptance

**Verdict at the current product checkpoint:** `BLOCKED` / `PENDING`.

The design approvals above are complete. A qualifying visual verdict still
requires a freshly built exact macOS production `.app`, a stable 1280 × 760
window, and a human visual review on that package. The production `.app` for
`ab67c3c` has been sealed, but it has no native window collection or human
visual review.

### Package binding to record before review

| Fact               | Required record                                               | Current status                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product commit     | Full `git rev-parse HEAD`                                     | Production package sealed from `ab67c3c43ee69ae32a040bb3e6f9c762807d8c3c`; later documentation commits do not alter its runtime inputs                                            |
| Production package | Absolute `.app` path, bundle ID, version                      | `Excalidraw.app`, bundle ID `excalidraw-desktop`, version `0.3.0`, package SHA-256 `f753ffc97c1912a9d2d481ce11460bc90f1f25818dc73149ac1f4ce2706cf27f`; no visual collection bound |
| Executable         | Absolute executable path and SHA-256                          | Production executable SHA-256 `7ef5956afe65549602bbb05dfdf73f2944d754fad777dcbd4abbcd84b9fdeb35`; no visual collection bound                                                      |
| Environment        | macOS version/build, filesystem, display scale                | `BLOCKED`: no package review session recorded                                                                                                                                     |
| Window             | Native logical bounds, exactly 1280 × 760, two stable samples | `BLOCKED`: no package review session recorded                                                                                                                                     |
| Review identity    | Reviewer and product-owner decision kept separate             | `PENDING`                                                                                                                                                                         |

### Human review matrix

Review the following states on the exact package. Record `PASS`, `FAIL`, or
`BLOCKED` for every row and attach the package identity and reviewer report.
Do not infer a visual result from a browser screenshot, a unit test, the native
menu collector, or the approved design archive.

| State                                    | Required visual facts                                                                                                                                                                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default History · Light · 360 px         | The drawer is right aligned; the canvas remains primary; filename, time, source, and summary are readable; `Current`, `Ready`, and marked status remain understandable without color alone; Preview and Restore remain visible.    |
| More Actions · Light                     | The 180 × 84 px menu and 32 px trigger fit without clipping; Mark/Unmark and Delete are readable; the destructive action hierarchy and separator are clear.                                                                        |
| Version Preview · Light                  | `Preview — read only` is visible; the preview surface is visibly separate from the current drawing; Exit and Restore remain reachable; no current-canvas action is obscured.                                                       |
| Restore Confirmation · Light             | The confirmation hierarchy is clear; Cancel is visibly available and initially focused; the modal has no clipped text or action; closing returns focus to the triggering control.                                                  |
| External Recovery · Light                | The recovery issue, Preview, Save As…, Keep current file, and Discard recovery actions are readable; the destructive confirmation is distinct; no recovery artifact is implied to disappear without explicit action.               |
| Compact History · Dark · 300 px fallback | The dark treatment preserves contrast and state labels; list rows and actions remain readable at the cramped width; no horizontal overflow or clipped essential action appears.                                                    |
| Error / conflict / pending / unavailable | The state title and recovery guidance are readable and visually distinct; the current drawing remains identifiable; retry or safe exit actions are not clipped; pending does not look like success.                                |
| Keyboard focus and focus return          | The focused row, modal, More Actions menu, Preview, and Close controls have a visible focus indicator; Escape/close returns focus to the triggering control. This is a visual spot check only; keyboard behavior is owned by T023. |
| Reduced motion                           | The required state remains understandable without relying on animation; no transition hides status or focus.                                                                                                                       |

### Separate evidence owners for SC-008

- [T047 native menu evidence](./local-version-history-t045-t047.md) owns the
  exact-package macOS menu hierarchy, label, enabled state, and route facts.
  The current record contains collector tests, not a qualifying package
  runtime result.
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
