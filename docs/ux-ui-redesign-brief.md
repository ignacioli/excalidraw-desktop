# Excalidraw Desktop UX/UI Redesign Brief

**Status**: Working document — discovery not yet approved

**Purpose**: Establish a consistent desktop interaction model and visual system for Excalidraw Desktop, prioritizing the core workflow while preserving the existing product and reliability contracts.

## Confirmed objective

> 为 Excalidraw Desktop 建立一套一致的桌面应用交互模型和视觉系统，并优先改造核心工作流。

This objective is a UX/UI discovery goal. It does not yet authorize implementation, changes to IPC, changes to persistence behavior, or replacement of the approved design contract.

## Current repository baseline

The repository already contains design decisions that this work must audit and respect:

- `DESIGN.md` is the current approved visual and interaction contract for the application shell, desktop-specific UI, and embedded Excalidraw editor.
- `docs/adr/ADR-009-desktop-ui-interactions.md` records accepted decisions for the native title bar, canvas-first workspace sidebar, tabs, workspace entries, and the unified menu/dialog layer.
- The official Excalidraw editor remains the visual and interaction authority for the embedded canvas; desktop-specific shell work must not silently fork its private UI or CSS.

The first task is therefore to identify which existing decisions remain valid, which are not implemented or are difficult to use, and which new decisions require product-owner approval.

## Overall workflow

### 1. Establish the design brief

Clarify the target user, primary jobs, product character, desktop constraints, release scope, and success criteria. Separate confirmed facts, observations, hypotheses, and decisions.

**Output**: this brief with an agreed scope and decision log.

### 2. Perform a UX baseline audit

Audit the current 0.2.0 experience by task rather than by isolated controls. Map the application shell, core workflows, navigation model, document lifecycle, and important states such as empty, loading, unsaved, save failure, conflict, recovery, permission denial, and close.

**Output**: current-state journey map, information-architecture map, state matrix, and prioritized problem list.

### 3. Define interaction principles and scope boundaries

Turn the audit into a small set of principles and explicit boundaries. Resolve whether a problem belongs to the shell, the embedded editor, product behavior, native macOS behavior, or implementation debt.

**Output**: approved UX principles, in-scope/out-of-scope list, and a prioritized core workflow.

### 4. Explore low-fidelity alternatives

Create grayscale, clickable alternatives for the core workflow. Test hierarchy, navigation, density, focus, keyboard behavior, resizing, and state transitions before investing in visual polish.

**Output**: a small set of comparable low-fidelity prototypes and a selected interaction direction.

### 5. Review and approve product decisions

Review the selected direction against the existing `DESIGN.md`, ADRs, reliability guarantees, accessibility expectations, and macOS conventions. Any change to behavior, state, permissions, or document lifecycle must be recorded as a product decision before implementation planning.

**Output**: approved interaction direction and updated decision record.

### 6. Produce high-fidelity key-path designs

Design the selected core workflow in high fidelity, including normal, empty, loading, disabled, error, conflict, recovery, offline, and unsaved states. Define layout rules, component anatomy, semantic tokens, keyboard/focus behavior, reduced-motion behavior, and responsive window-size behavior.

**Output**: reviewable high-fidelity interaction design, component/token inventory, and state-complete handoff.

### 7. Convert approved design into an implementation plan

Map approved design decisions to the existing React/Tauri architecture. Identify UI-only changes, IPC-boundary changes, native-platform work, tests, and documentation. Do not let the design tool become a parallel source of truth.

**Output**: implementation plan and dependency-ordered tasks created only after high-fidelity approval.

### 8. Implement in vertical slices

Implement the shell and core workflow incrementally, preserving persistence, recovery, IPC, capability, and native-window contracts. Update tests whenever interaction behavior changes.

**Output**: working vertical slices with focused code and test changes.

### 9. Validate and iterate

Use targeted unit/integration tests, browser-visible interaction checks, visual snapshots, keyboard/accessibility checks, and native macOS verification where browser evidence is insufficient.

**Output**: validation evidence, residual-risk list, and a decision on whether the slice is ready for release.

## Tool roles

- ChatGPT/Codex: clarify facts, assumptions, user jobs, flows, states, decisions, and acceptance criteria.
- Open-Design: optionally explore low-fidelity alternatives and complex interaction concepts.
- Figma or another selected design carrier: maintain the reviewable high-fidelity design and component/token handoff.
- Repository documents: remain the authoritative record of approved product, interaction, architecture, and verification decisions.

The design carrier is replaceable; the reviewable and approvable design expression is not.

## Decision log

| ID    | Decision                                                                                                                                                                                                                                     | Status                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| D-001 | Establish a staged UX/UI redesign process before changing UI code.                                                                                                                                                                           | Confirmed                    |
| D-002 | Treat `DESIGN.md` and ADR-009 as the current baseline to audit, not silently replace.                                                                                                                                                        | Confirmed                    |
| D-003 | Prioritize the core workflow before broad visual polish.                                                                                                                                                                                     | Confirmed                    |
| D-004 | The product position is a desktop-enhanced version of the official Excalidraw PWA for multiple user types.                                                                                                                                   | Confirmed                    |
| D-005 | The first redesign scope includes the desktop shell, title area, tabs, workspace sidebar, menus/dialogs, theme, and design tokens; it excludes the toolbar/canvas-peripheral controls and the internal official Excalidraw editor UI.        | Confirmed                    |
| D-006 | The workspace structure is allowed to change; persistence, recovery, file format, export capability, and other established behavior must not regress.                                                                                        | Confirmed                    |
| D-007 | Existing SDK-provided `Save To` and `Export Image` capabilities are not to be duplicated with a redundant top-level Export action. The sidebar should move toward a more compact, icon-led direction, subject to low-fidelity validation.    | Confirmed direction          |
| D-008 | Work is delivered incrementally rather than as one large redesign.                                                                                                                                                                           | Confirmed                    |
| D-009 | `DESIGN.md` is the canonical in-repository design-system document. ADR-009 remains historical rationale and existing implementation context; it is not silently erased, and any behavior conflict requires an explicit superseding decision. | Confirmed governance         |
| D-010 | Penpot SaaS plus the official local Penpot MCP is the provisional high-fidelity design workflow, pending a small runtime smoke test.                                                                                                         | Provisional                  |
| D-011 | The current reference benchmark is limited to Cursor, VS Code, the official Excalidraw PWA, and ExcaliApp; ChatGPT is deferred.                                                                                                              | Confirmed                    |
| D-012 | Each application window has one current Workspace. A Workspace may contain multiple directories; another Workspace opens in another window.                                                                                                  | Confirmed                    |
| D-013 | Do not provide a Back icon in the first redesign; avoid introducing an undefined navigation-history model.                                                                                                                                   | Confirmed                    |
| D-014 | Row-level overflow actions use a hidden vertical ellipsis `⋮` trigger revealed only when needed; the interaction must remain keyboard- and focus-accessible.                                                                                 | Confirmed direction          |
| D-015 | Do not add a standalone Export button. Export remains an application/menu-level action and may delegate to the official SDK shortcut/action.                                                                                                 | Confirmed                    |
| D-016 | The first redesign delivery is limited to Welcome Page, Workspace Sidebar, Tabs, and file-row operations. Do not expand the reference set or redesign the editor toolbar/canvas UI.                                                          | Confirmed                    |
| D-017 | The tab strip must integrate the close affordance with each tab, remove the visible tab-strip scrollbar, and use a compact overflow strategy. The Workspace Sidebar scrollbar should be visually thin and unobtrusive.                       | Confirmed direction          |
| D-018 | The shell should feel technical, restrained, and hard-edged, aligned with the official Excalidraw PWA language; avoid large rounded cards and excessive corner rounding.                                                                     | Confirmed visual direction   |
| D-019 | The row-level overflow trigger must use a vertical three-dot icon (`⋮` / vertical ellipsis), not a horizontal ellipsis, to minimize row width and align with compact file-management controls.                                               | Confirmed interaction detail |

## Round 1: confirmed product direction

### Core workflow priority

The first core workflow to audit is:

`launch application → open a directory/file → restore the last workspace or document when applicable → edit → automatic persistence without manual save → exit/abnormal interruption without data loss → close application`

The phrase “without data loss” is a product expectation. The redesign must preserve the repository's existing atomic persistence, draft, recovery, and conflict contracts; it must not redefine them through visual changes.

### First problem priorities

The initial UX audit prioritizes:

1. Navigation;
2. Visual hierarchy;
3. Desktop identity and conventions.

These are problem categories, not yet diagnoses of the attached screenshots.

### Tool decision: Penpot

Penpot is adopted provisionally as the high-fidelity design carrier because it supports a SaaS workspace and a local MCP integration path. The official local MCP workflow requires a local MCP/plugin process, a Penpot file opened in the browser, loading the local plugin, and an active connection; “Penpot account works” and “MCP runtime works” are separate facts.

Before it becomes a dependency of the design workflow, run a read-only smoke test that proves:

- the local MCP server starts;
- the Penpot plugin loads in the selected Penpot SaaS workspace;
- the local MCP client connects to the open design file;
- the agent can inspect a test file and perform one controlled, reversible design operation;
- the design file remains reviewable without the MCP process running.

The repository remains the authority for approved decisions. Penpot is the design carrier, not a replacement for `DESIGN.md`, ADRs, specs, or validation evidence.

## Round 2: confirmed direction and reference benchmark

### Product entry and session restoration

The application should support a welcome page for the no-workspace/no-document state. The initial entry model is:

`Welcome page → Open (directory or file) / New Drawing / Recent Workspaces`

Opening a directory or a file is supported from the same entry point. A Workspace is an OS folder and is a first-class navigation object; it may contain multiple directories, and directories may contain multiple drawings.

When a previous session exists, the application should restore the previous Workspace and open tabs, then activate the file that was active at the previous exit. This is a session-restoration UX requirement; it must preserve the existing persistence and recovery guarantees rather than introduce a second document-storage mechanism.

The technical-architecture-drawing scenario is the first prioritization anchor for testing, not a restriction on improving the general UX. User scenarios determine hierarchy and task priority; they do not prevent a general visual-system improvement.

### Shell and navigation direction

- Workspace is the primary navigation object.
- The Workspace Sidebar is hidden by default and opened through one compact, visually clear button.
- Sidebar actions should be compact and icon-led. `New Drawing`, `New Folder`, expand/collapse, and refresh are candidates for first-level actions; open, new, save as, and export belong in the top-level menu unless later testing shows a stronger reason.
- Sidebar action icons may remain hidden until hover or keyboard focus to reduce density, but every action must remain keyboard-accessible and have an accessible name. Hover-only discovery is not sufficient.
- Automatic saving should be nearly silent during normal operation; visible feedback is primarily for failures or recovery-relevant states.
- Desktop identity should be emphasized through the sidebar, tabs, and menu bar.

### Reference benchmark: what to borrow

The supplied Cursor and VS Code screenshots justify a short reference-benchmark stage before asking more detailed product questions. The benchmark should extract reusable interaction principles, not copy product-specific features or screenshots into requirements.

#### Welcome-page patterns

- Cursor demonstrates a calm no-project state with a small set of high-intent entry actions and a recent-project list.
- VS Code demonstrates a welcome document that can coexist with the normal desktop shell and uses clear `Start` and `Recent` groupings.
- For Excalidraw Desktop, the reusable pattern is: a focused welcome state with `Open`, `New Drawing`, and `Recent Workspaces`; Cursor-specific actions such as clone, SSH, or device control are not in scope.
- The welcome page must not compete with the editor once a Workspace/document is open. It is an entry state, not a permanent dashboard.

#### Sidebar patterns

- Cursor demonstrates a compact project header with context-sensitive actions that appear on hover/focus rather than occupying permanent text-heavy space.
- The pattern is useful for reducing visual noise in Excalidraw's Workspace Sidebar, but file-tree semantics cannot be copied blindly because Excalidraw has Workspace → directory → drawing hierarchy rather than a source-code repository tree.
- The empty sidebar state exposes a risk: hidden actions can create a visually blank or undiscoverable area. The redesigned sidebar needs a clear header affordance, tooltip/focus behavior, and an explicit empty state where appropriate.
- Icon-only controls should be treated as compact controls with tooltips and accessible names, not as unlabeled glyphs.

#### Token extraction boundary

Screenshots can suggest relationships such as density, surface contrast, border restraint, icon scale, and hover behavior. They cannot reliably establish exact production tokens. Exact values must be selected in Penpot and reconciled with the semantic token roles already defined in `DESIGN.md`, then validated in the application.

### Reference-benchmark decision

Add one bounded reference-benchmark step before the next detailed clarification round:

1. Compare Cursor, VS Code, the official Excalidraw PWA, and ExcaliApp as the current reference set.
2. Record only reusable principles, candidate patterns, risks, and non-goals.
3. Map candidates to Excalidraw Desktop's existing `DESIGN.md` tokens and shell boundaries.
4. Select a small number of patterns for low-fidelity exploration.

This benchmark is a decision aid, not a request to reproduce another product's branding, proprietary copy, or complete information architecture.

## Benchmark findings

### Evidence register

| Reference               | Evidence                                                                                                                             | Confidence                             | Scope                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------- |
| Cursor                  | `cursor-welcome-page.png`, `cursor-sidebar-hover.png`, `cursor-sidebar-empty.png`, `hove-over-a-file.png`, `sidebar-goback-icon.png` | Direct visual snapshot                 | Welcome, sidebar, row hover, tooltip, navigation affordances              |
| VS Code                 | `vscode-welcome-page.png`                                                                                                            | Direct visual snapshot                 | Welcome state, Start/Recent grouping, persistent desktop shell            |
| Official Excalidraw PWA | `excalidraw-official-pwa.png`                                                                                                        | Direct visual snapshot                 | Canvas-first shell and transient menu relationship                        |
| ExcaliApp               | `excaliapp-menue.png` plus the public repository README                                                                              | Direct snapshot + public documentation | Local file management, tree navigation, tabs, auto-save, row/file actions |

The screenshots are snapshots, not authoritative implementation specifications. The ExcaliApp README documents local file management, tree navigation, tabs, auto-save, and rename/delete through file actions, but the exact contents of the screenshot's overflow menu are not independently confirmed from the README. See the [ExcaliApp repository](https://github.com/tyrchen/excaliapp).

### Pattern matrix

| Pattern                                      | Reference signal                              | Assessment for Excalidraw Desktop                                                                           | Decision                                                   |
| -------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Welcome state with a few high-intent actions | Cursor, VS Code                               | Resolves the no-session state without forcing users into an empty sidebar                                   | Adopt                                                      |
| Recent workspaces                            | Cursor, VS Code                               | Directly supports multi-workspace use and last-session recovery                                             | Adopt                                                      |
| Workspace as primary navigation              | Cursor-like project model, user direction     | More stable than treating individual drawings as the root object                                            | Adopt, adapt to Workspace → directory → drawing            |
| Sidebar hidden until requested               | Official PWA, existing `DESIGN.md`            | Protects canvas priority                                                                                    | Adopt                                                      |
| Header actions revealed on hover/focus       | Cursor sidebar                                | Reduces permanent text and button density                                                                   | Adopt with keyboard/focus parity                           |
| Current row hover highlight                  | Cursor file hover                             | Improves pointer tracking and makes long names easier to follow                                             | Adopt with sufficient contrast and non-color state support |
| Full path tooltip on truncated row           | Cursor file hover                             | Useful for disambiguation, but should not replace visible names or accessible labels                        | Adopt with delay/focus behavior                            |
| Compact primary sidebar icon                 | Cursor/VS Code-style shell                    | Makes the hidden sidebar discoverable without adding a text-heavy control                                   | Adopt; final icon remains open                             |
| Back navigation icon with tooltip/shortcut   | Cursor shell                                  | Useful when navigating Workspace/directory context, but only if the app has a meaningful navigation history | Adopt conditionally                                        |
| Row-level three-dot action affordance        | ExcaliApp screenshot                          | Efficiently exposes rename/delete and future row actions without permanently widening every row             | Adopt with node-specific menus and confirmation rules      |
| Global context menu                          | Existing app contract and ExcaliApp analogy   | Should remain a single context-menu layer; do not create competing menu systems                             | Adopt the layer, not duplicate triggers                    |
| Quiet auto-save                              | User direction; ExcaliApp documents auto-save | Fits a drawing workflow where manual Save is not the primary task                                           | Adopt; errors/recovery remain visible                      |
| PWA/browser chrome                           | Some reference framing                        | Conflicts with native desktop identity and `DESIGN.md`                                                      | Do not adopt                                               |
| Reference-product branding and exact layout  | All references                                | Not necessary for the UX benefit and creates visual inconsistency                                           | Do not adopt                                               |

### Reference-specific assessment

#### Cursor

The strongest reusable idea is progressive disclosure: the persistent structure is quiet, while actions appear in the local context where they are needed. Its Welcome page also demonstrates that an empty application can offer a small set of clear next actions without presenting a full file manager.

The important adaptation is semantic. Cursor's hierarchy is a code-project tree; Excalidraw needs a Workspace → directory → drawing tree. The interaction pattern transfers, but the labels, icons, row actions, and destructive-action rules must be redesigned for drawings.

#### VS Code

The strongest reusable idea is explicit grouping of `Start` and `Recent`, with direct text actions. This is valuable for a multi-user application because it supports both first-time entry and return-to-work behavior.

The application shell can remain present around a Welcome document, but Excalidraw should avoid importing VS Code's many activity-bar concepts. The first version needs one primary Workspace control, not an IDE-style collection of tools.

#### Official Excalidraw PWA

The strongest reusable idea is canvas-first behavior: the editor is the primary surface, and supporting navigation enters as a transient layer. This aligns with the existing `DESIGN.md` contract.

The PWA's browser-like title area and unrelated service/account entry points are not part of the desktop target. The desktop version should preserve the Excalidraw editor's visual language while using an ordinary native window and a dedicated document-management shell.

#### ExcaliApp

The strongest reusable idea in the supplied menu screenshot is the row-level overflow action: a selected/hovered row reveals a compact `⋮` trigger, which opens actions for that specific Workspace Entry. This is more precise than showing permanent action buttons on every row.

The correct name for the pattern is “row action menu” or “row-level overflow menu”; it may open a context-style menu, but it is not the same as the global right-click context-menu layer. The final design should define one trigger model for pointer, keyboard, and accessibility use, and should not assume that the screenshot proves the exact action list.

### Candidate target model after benchmark

The benchmark supports the following target model for low-fidelity exploration:

1. **No recoverable session**: show a Welcome state with `Open`, `New Drawing`, and `Recent Workspaces`.
2. **Recoverable session**: restore the last Workspace, open tabs, and active drawing; do not show Welcome over a usable session.
3. **Workspace control**: expose one compact sidebar button with an accessible name and tooltip.
4. **Workspace Sidebar**: show the Workspace header and a compact tree; reveal header/row actions on hover or keyboard focus.
5. **Tree rows**: show stable type icons and names; highlight the hovered and selected row; reveal a row-level overflow trigger when actions are available.
6. **Menus**: keep open/new/save-as/export in the native/top menu where appropriate; do not add a redundant standalone Export button when the official SDK already provides `Export Image`.
7. **Editor priority**: keep the official Excalidraw canvas and its internal controls outside this redesign.

This target model is a benchmark result and a low-fidelity starting hypothesis, not yet an implementation specification.

## Additional shell findings from 0.2.0 feedback

These are now first-class shell constraints for the low-fidelity designs:

- The tab close affordance must belong to the tab's own interaction area and remain spatially associated with the active/hovered tab. It must not appear as a detached control separated from the active tab bar.
- The tab strip must not expose a thick scrollbar. Overflow should be handled through a compact, discoverable tab-navigation strategy without a permanently visible scrollbar.
- The Workspace Sidebar may scroll, but its scrollbar should be thin, low-contrast, and non-competitive with the content. Auto-hide behavior may be considered if it does not harm discoverability or keyboard operation.
- The visual language should use restrained radii, crisp edges, cool neutral surfaces, and clear hierarchy. “Technical” and “hard-edged” do not justify decorative gradients, heavy borders, or dense dashboard styling.
- The row-level overflow trigger uses a vertical ellipsis (`⋮`) so the action remains compact and visually aligned within the trailing edge of a file or directory row. Its tooltip and accessible name should describe the action, for example `File actions` or `Directory actions`; the glyph itself is not the accessible label.

## Separate native bug: macOS window close button

### Observed behavior

The supplied `can-not-close-excalidraw-window.png` records that clicking the macOS red close control does not close the Excalidraw Desktop window, while choosing `Quit Excalidraw` from the system menu does.

### Current code evidence

- `src/app/AppShell.tsx` registers the native close handler when `hasNativeWindowRuntime()` is true.
- `src/app/exitCheckpoint.ts` calls `event.preventDefault()`, awaits `documentManager.checkpointAll("appExit")`, then calls `appWindow.destroy()`.
- `src-tauri/tauri.conf.json` does not disable native closing and configures an ordinary decorated window.
- Existing `src/app/exitCheckpoint.test.ts` tests a mocked event/window only; `e2e/tests/native-window-contract.spec.ts` checks window configuration but does not click the real macOS close control.

### Status and next verification

This is a high-priority native lifecycle bug, not yet a confirmed root cause. Tauri's current API documents that `destroy()` force-closes without emitting another `closeRequested` event, so the likely verification points are listener registration in the packaged runtime and whether `checkpointAll` resolves or reports an error. A native macOS reproduction with observable checkpoint/close evidence is required before changing the handler.

### Token implications

The benchmark suggests a token direction rather than exact values:

- quiet neutral surfaces for the shell and sidebar;
- one restrained accent for active tab, selected row, and primary focus;
- a distinct but subtle hover surface;
- low-contrast separators that do not compete with the canvas;
- one compact control height and one row height family;
- consistent icon size and stroke weight across sidebar, navigation, and menus;
- tooltip and focus-ring tokens that remain visible in both light and dark modes.

Exact values remain governed by `DESIGN.md` and must be selected in Penpot after the interaction direction is approved.

## Benchmark execution plan

### Objective

Use a small set of strong desktop references to answer one question:

> What should Excalidraw Desktop's shell, welcome state, Workspace navigation, tabs, and menus feel like when the user is managing technical-architecture drawings?

The benchmark is not intended to decide the embedded canvas UI, which remains outside this redesign scope.

### Work products

1. **Evidence register** — reference name, evidence source, inspected state, and confidence.
2. **Pattern matrix** — welcome state, Workspace hierarchy, sidebar actions, tabs, menus, session restore, feedback, keyboard/focus, density, and theme.
3. **Pattern cards** — for each useful pattern: what it solves, why it works, what can be borrowed, and what must not be copied.
4. **Excalidraw mapping** — fit, conflict, or unknown against `DESIGN.md`, ADRs, persistence/recovery, and the official editor boundary.
5. **Target UX statement** — a concise proposed model for Welcome, Workspace, Sidebar, Tabs, and top menu.
6. **Decision gate** — the user's approval or rejection of candidate patterns before low-fidelity design.

### Execution sequence

1. Analyze the supplied Cursor and VS Code screenshots as direct visual evidence.
2. Use the supplied screenshots and the public ExcaliApp repository only as evidence for the selected reference set; do not add ChatGPT to this benchmark.
3. Compare only the agreed shell dimensions; defer low-priority details.
4. Translate useful patterns into Excalidraw-specific principles and non-goals.
5. Record the matrix, candidate target model, and unresolved decisions in this brief.
6. Ask one short confirmation round, then proceed to low-fidelity alternatives only for the approved patterns.

### Collaboration protocol

- Codex owns evidence organization, comparison, repository-boundary checks, and persistence of the working brief.
- The user supplies missing product context, rejects misleading analogies, and approves or rejects candidate patterns at the decision gate.
- The user does not need to manually extract pixel values or write design documentation during this phase.
- A screenshot, live inspection, or official documentation is evidence; a remembered behavior is labeled as an assumption.
- No implementation, token lock-in, or change to `DESIGN.md` occurs before the benchmark decision gate.

### Current user input needed

No new evidence is required before the first benchmark pass. The supplied screenshots plus the public ExcaliApp repository are sufficient for the selected reference set.

## Open questions

The next round will first resolve only the benchmark outputs and the welcome-page/sidebar information architecture. Lower-priority details such as exact icon choice, pixel values, and individual menu labels remain deferred.
