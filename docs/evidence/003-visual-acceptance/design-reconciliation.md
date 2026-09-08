# 003 DESIGN / HF-2 reconciliation

**Recorded**: 2026-09-03
**Tasks**: T005, T006, T007 complete
**Authoritative inputs**: `docs/ux-ui-redesign-brief.md` decisions D-007, D-012, D-015, D-017, D-019 through D-027, and D-032; frozen HF-2 `README.md`, `manifest.json`, `components.md`, and `tokens.json`; corrective 003 specification and UI-shell contract.

## Baseline conflict inventory

The pre-reconciliation English and Simplified-Chinese documents were semantically paired. They nevertheless retained the following old-002 wording or omissions, which could direct implementation away from the approved HF-2 contract.

| Pre-reconciliation location | Conflict or omission | Approved reconciliation |
|---|---|---|
| `DESIGN.md:28-36`; `DESIGN.zh.md:28-36` | Defines a Top tab bar, a generic Workspace Sidebar for mounted workspaces, and a remaining "Right editing area". It does not state the single Left / Center / Right shell hierarchy, the SDK-owned right boundary, or the compact far-left Sidebar + Back controls. It also retains text-form **Workspace sidebar** / transient-sidebar language. | Define Left shell, Center tabs/canvas, and Right SDK boundary; make the left controls compact icon controls; specify Hidden, Overlay, and Pinned geometry. |
| `DESIGN.md:40,46`; `DESIGN.zh.md:40,46` | Recent omitted `createdAt` ordering and inaccessible-path behavior; the tree said mounted workspaces form the tree, contradicting the one-window / one Current Workspace contract. | Recent projects only `name`/`rootPath`, sorts existing records by `createdAt` descending, and retains Welcome/record on inaccessible paths. Render only the Current Workspace root and descendants; other records remain available through Welcome/Recent or an explicit workspace-open path. |
| `DESIGN.md:48`; `DESIGN.zh.md:48` | Retains overflow-scroll behavior but does not prohibit a visible tab-strip scrollbar. | Preserve keyboard/wheel overflow behavior while requiring the scrollbar itself to be visually absent. |
| `DESIGN.md:60,81-103`; `DESIGN.zh.md:60,81-103` | Assigns generic shell "status" and preferences without explicit Save/Export/Appearance ownership; uses alias token names and claims `shadow-floating`, which has no frozen `tokens.json` entry. | Remove standalone top-level Save, Export, Appearance, and global New Drawing chrome. Keep Save To / Export Image with the SDK or application/menu-level owner; use the frozen canonical token IDs; treat floating shadows as a component stacking rule. |
| `DESIGN.md:105-114`; `DESIGN.zh.md:105-114` | Covers generic components but omits the full legacy-visible-control zero-count contract and the HF-2 component state details. | State the complete zero-count removal list while preserving accessible names, tooltips, keyboard paths, and non-colour state; cite the frozen component contract for state priority, focus, row action, and Welcome Action details. |
| `DESIGN.md:125-136`; `DESIGN.zh.md:125-136` | Requires only representative visual snapshots; it omits six individually required 1280×760 gates, SDK-only masking, independent reviewer identity/verdict, native package evidence, and product-owner decision. | State the six-screen gate and evidence boundary. A reviewer PASS and native evidence are necessary but do not replace the product-owner decision. |

## T006 reconciliation applied on the product topic branch

`DESIGN.md` and `DESIGN.zh.md` now carry the same compact three-region canonical contract, single-Current-Workspace rule, action ownership, legacy-removal language, and visual-verification boundary. The update preserves the 001 recovery, 002 virtualized-tree, keyboard, dialog, and official-SDK boundaries; it does not change product implementation.

## Product-owner decision (T007)

**APPROVED** — On 2026-09-03, the product owner reviewed T002–T006, the paired `DESIGN.md` / `DESIGN.zh.md` update, and this reconciliation record, and explicitly approved the canonical contract. This unblocks only the remaining Phase 1 setup/reconciliation tasks. Phase 2 and VSL-001 remain blocked until the Phase 1 checkpoint has all required evidence and its stated exit gate.

## HF-2 revision-59 provenance refresh

The T007 decision above remains the canonical DESIGN approval recorded on 2026-09-03. The product owner subsequently approved the refreshed HF-2 handoff on 2026-09-06: Penpot revision 59 (`HF-2 product-approved · icon and interaction refinement`), as recorded in [`docs/design/desktop-shell/hf-2/README.md`](../../design/desktop-shell/hf-2/README.md) and `manifest.json`.

The repository-owned HF-2 assets and manifest were frozen by commit `404175840e9096effb4a286dc75ba053c31400b0` (`Freeze approved Penpot revision 59`). This entry is a provenance refresh for the approved design input; it is not a new approval request and does not reopen or alter T007's canonical DESIGN contract. T008/T009 evidence was regenerated against this revision-59 manifest and its current assets on 2026-09-08.
