<!--
Sync Impact Report
==================
Version change: 3.2.0 → 3.3.0
Modified principles:
  - Core Principle IV: idle process-tree RSS 150MB → 500MB, 10k RSS 350MB → 950MB,
    idle CPU 1% → 35% of one logical core; T090 pan workload is constant-zoom pan;
    T108 quiescent-write observation starts 5 s after scripted editing (ADR-007)
Added sections: none
Governance: MINOR change; substantive revision of measurement constraints recorded through
  ADR-007 rather than a silent threshold edit, honoring the ADR-004 baseline-series rule
Removed sections: none
Templates requiring updates: none; templates read this constitution at runtime
Follow-up TODOs: none
-->

# Excalidraw Desktop Constitution

## Core Principles

### I. Code Quality

Code MUST follow SOLID and DRY paradigms: small single-responsibility modules, dependency
direction oriented to interfaces, and no copy-paste duplicated logic. Domain invariants MUST
live in a single authoritative layer — the same business rule MUST NOT be implemented twice
across the TypeScript and Rust sides; cross-boundary behavior is expressed through small,
explicit, strongly typed, version-aware IPC contracts.

- TypeScript MUST remain in strict mode; MUST NOT use `any` or assertions used only to
  silence type errors.
- Rust MUST NOT use `unwrap`, `expect`, `panic`, or `unsafe` on reachable production input
  unless a proven invariant justifies it and a comment explains it.
- Abstractions MUST be driven by at least two real call sites (no speculative abstractions);
  refactoring MUST NOT incidentally change behavior.
- Any PR MUST pass formatting, lint, strict typecheck, and `cargo clippy` before merge.

**Rationale**: The product's core promise is data reliability; reliability comes from
reason-about-able code. Clear boundaries and a single authoritative layer let critical paths
such as atomic writes, recovery, and conflict resolution be verified and evolved independently.

### II. Testing Standards — Desktop E2E First

The testing strategy is centered on desktop end-to-end verification, supported by unit and
integration tests.

- Every user-visible feature MUST have corresponding E2E coverage (the Playwright desktop
  suite), delivered in the same PR as the feature; a task MUST NOT be declared complete while
  its tests fail.
- Data-reliability paths (atomic writes, crash recovery, external-change conflict resolution)
  MUST have automated fault-injection tests (kill-during-save, external write conflict, and
  corrupted-file recovery are the minimum set).
- Browser-testable behavior and native-shell verification MUST be clearly distinguished:
  windows, menus, dialogs, file associations, installers, and other behavior a browser cannot
  prove MUST be closed out with manual or automated checks in the target OS native environment.
- macOS is the only required native acceptance platform for the current version; a fully
  configured and recorded macOS VM is a valid acceptance environment. Ubuntu 24.04 Desktop is
  an optional community-validation environment only and does not block merge, release, or task
  phase completion.
- Fedora, other Linux distributions, desktop environments, display protocols, and input-method
  combinations are outside the required acceptance matrix for the current version; the project
  MUST NOT claim native coverage for platforms it has not run.
- All VM delivery evidence MUST record host hardware, virtualization software and version,
  guest OS, virtual CPU/memory, and display protocol, and MUST honestly disclose the physical
  hardware boundaries the VM does not cover.
- Fixing a defect MUST first add a test that reproduces it, then implement the fix.

**Rationale**: Desktop failure modes (power loss, hard kill, external concurrent writes)
cannot be covered by unit tests; only E2E and fault injection can prove the product promise of
"zero corruption, zero silent overwrite".

### III. UX Consistency

- macOS is the primary platform for interaction and release acceptance; Ubuntu 24.04 Desktop
  compatibility is optional community validation. Platform differences are allowed only where
  each platform's own conventions apply (shortcut modifiers, menu placement, system dialog
  styling).
- Accessibility is mandatory: semantic structure, full keyboard operation, visible focus,
  accessible names, and reduced-motion support MUST ship with the feature, not as a retrofit.
- Loading, empty, error, conflict, offline, and permission-denied states MUST be treated as
  part of the feature with clear UI presentation; silent failures or long operations without
  feedback MUST NOT occur.
- Similar operations MUST use consistent interaction and copy patterns across the app (save
  status indicators, confirmation dialogs, shortcuts).

**Rationale**: Consistency and accessibility determine the perceived quality of a "mature
desktop application"; retrofitting them costs far more than shipping them with the feature.

### IV. Performance and Resource Budgets

The Success Criteria of the authoritative PRD (in the private `specs/` repository) are
performance-budget red lines; a performance regression is equivalent to a functional defect:

- Performance acceptance MUST run the full workload in the maintainer-declared macOS reference
  environment. The first reference environment is a macOS 26.5.2 VM (4 vCPU / 8GB RAM) in
  Parallels Desktop Pro 26.4.1; reports MUST record host hardware, virtualization software and
  version, guest OS/WebView, and virtual resources.
- Cold start to editable canvas ≤ 2 s; idle application process-tree RSS ≤ 500MB (ADR-007).
- Idle CPU P95 ≤ 35% of a single logical core; after a 10,000-element scene stabilizes, process-
  tree RSS ≤ 950MB; after 15 minutes of scripted editing (ADR-006), RSS growth over the
  warm-up baseline
  MUST be both ≤ 50MB and ≤ 15%; when the app has been idle for 60 s after the crash-safety
  flush has settled (ADR-007), its managed data
  directory and mounted workspaces MUST have zero persistent writes.
- Pan at constant zoom must stay usable and smooth in a 10,000+ element scene (T090 scripted
  pan, ADR-007), with no perceptible >100ms freeze during editing.
- The high-frequency editing path MUST NOT serialize the full scene, transfer over IPC, or
  write to disk on every event; persistence MUST go through debounce/coalescing scheduling
  (≥95% reduction over per-event disk writes).
- Changes touching performance-sensitive paths MUST include before/after measurements in the
  same reference environment; subjective judgment is not a substitute.
- T090/T108 MUST run in full in the recorded reference environment and retain machine-readable
  reports. Budget results MUST be honestly marked `pass` or `fail`, but are no longer a hard
  gate for merge, open-source release, or installer delivery.

**Rationale**: The whole point of choosing a lightweight desktop architecture is performance
and resource advantages; performance goals without budget constraints erode incrementally
across iterations.

### V. Documentation Discipline — Globally Enforced

- All external behavior, IPC contracts, data formats, and architecture decisions MUST have
  corresponding documentation: product specifications live in the private `specs/` repository
  (accessed via a gitignored symlink), architecture and development documentation live in
  `docs/`.
- Architecture decisions MUST record context, alternatives, and trade-off rationale (ADR form
  or an equivalent section).
- Documentation inconsistent with the implementation MUST be treated as a defect, with fix
  priority equal to code defects.
- New commands, configuration, and environment requirements MUST synchronously update the
  corresponding section of `AGENTS.md`.

**Rationale**: This project uses a spec-driven process (spec-kit); documentation is the input
to each stage rather than an accessory. Stale documentation directly causes later stages to
produce incorrect output.

### VI. Git & Pull Request Discipline

Collaboration history is the basis for audit and rollback. Commits and pull requests MUST be
predictable, reviewable, and traceable.

**Branching and safety**

- The primary branch is `main`; MUST NOT force-push to `main`/`master`; MUST NOT skip hooks
  (`--no-verify`, `--no-gpg-sign`, etc.).
- MUST NOT discard or overwrite user changes that were not requested; MUST NOT perform
  destructive git operations without explicit authorization (e.g. `push --force` to the
  primary branch, hard reset discarding others' work).
- Keys, credentials, `.env`, and other sensitive material MUST NOT enter commits; if asked to
  commit such files, MUST refuse and warn.

**Commits**

- MUST NOT create a commit without explicit user request.
- Each commit MUST focus on a single intent; the commit message MUST use a short imperative
  subject that states the motivation (why), passed via HEREDOC to avoid formatting issues.
- `--amend` is allowed only when: (1) the user explicitly requests it; or (2) a pre-commit
  hook rewrote files automatically and the commit was created by the current session and has
  not yet been pushed. After a commit is rejected by a hook, MUST create a new commit; MUST
  NOT use amend to mask the failure.
- MUST NOT amend commits already pushed to remote; if the user explicitly requests amending a
  pushed commit, MUST first explain the force-push consequences and proceed only after user
  confirmation, and the target MUST NOT be the primary branch.

**Pull requests**

- GitHub operations (issues, PRs, checks, releases) MUST use `gh`.
- Before opening a PR, MUST check: worktree status, the full branch diff against base, commit
  history, and remote tracking status; run `git push -u` first when needed.
- The PR description MUST include a Summary (1–3 points) and a Test plan (checkable validation
  items); scope MUST stay small and focused, and MUST NOT carry unrelated churn.
- Before merge, MUST satisfy existing quality gates (Principle I formatting/lint/typecheck/
  clippy, Principle II test requirements, and the Docs-Code Sync Gate); MUST NOT merge while
  CI or review is failing.
- MUST NOT force-push a feature branch by default to "tidy history"; allowed only when the
  user explicitly requests it and the target is not the primary branch.

**Rationale**: Predictable commit and PR discipline reduces mistakes and review cost, keeps
the boundaries of spec-driven changes clear and auditable, and protects the primary branch and
user worktree from accidental damage.

## Architecture Diagram Standards

- Architecture diagrams MUST be delivered as PlantUML or Mermaid text sources under version
  control; MUST NOT deliver only images or non-regenerable drawing files (exported images may
  be supplementary artifacts only).
- Any architecture-level delivery (architecture documents, design documents touching boundary
  changes, `$speckit-plan` outputs) MUST include at least two diagram types:
  1. **Layered View**: frontend (React/canvas), IPC boundary, Rust backend, and persistence
     layers with their dependency directions;
  2. **Data Flow**: key-chain data flows, covering at minimum the "edit event → in-memory
     state → draft layer → target file flush" and "external file change → detection → conflict
     resolution" chains.
- Diagrams MUST stay consistent with the implementation: code changes that alter component
  boundaries, IPC contracts, or data flows MUST update the corresponding diagram sources in
  the same PR; inconsistency is treated as a documentation defect (see Principle V).

## Docs-Code Sync Gate

- Code changes that alter external behavior, IPC/data contracts, or architecture MUST include
  the corresponding user-facing documentation and architecture-diagram updates in the same
  commit/PR; missing updates MUST NOT be merged.
- Spec-driven artifacts (`specs/` spec/plan/tasks) are the upstream source of a change: they
  are updated first in the private specs repository, and the PR then implements the spec and
  ships the corresponding user-facing documentation. specs are a prerequisite of the PR, not a
  deliverable bundled into it.
- Behavior-neutral changes (pure refactors, dependency upgrades, formatting) MUST explicitly
  declare "no documentation impact" in the commit message as a review checkpoint.
- The code-review checklist MUST include a documentation-sync item: the reviewer confirms the
  user-facing documentation/diagrams were updated, or that the "no documentation impact"
  declaration holds, before approval.
- Spec-driven artifacts (`specs/` spec/plan/tasks) MUST keep their state consistent with
  implementation progress; the state where implementation is complete but the spec still
  describes stale behavior MUST NOT occur.

## Governance

- This constitution takes precedence over other practice conventions in the repository;
  `AGENTS.md` provides runtime development guidance, and where it conflicts with this
  constitution, this constitution prevails and `AGENTS.md` is revised accordingly.
- **Revision process**: proposal (state motivation and impact scope) → impact assessment
  (affected templates, documentation, processes) → bump the semantic version → update the
  Sync Impact Report at the top of the file → commit.
- **Version determination**: MAJOR = backward-incompatible removal or redefinition of a
  principle; MINOR = new principle/section or substantive expansion of constraints; PATCH =
  clarification, wording, formatting, and other non-semantic revisions.
- Every PR review MUST verify constitution compliance; violations MUST be fixed before merge,
  or recorded as a written exception with a recovery deadline.
- Commit and PR process compliance follows Principle VI; exceptions MUST be recorded in
  writing with a recovery deadline.
- Complexity and deviations (new dependencies, abstraction layers, permission expansion) MUST
  have written justification, otherwise they are treated as violations.

**Version**: 3.3.0 | **Ratified**: 2026-08-04 | **Last Amended**: 2026-08-15
