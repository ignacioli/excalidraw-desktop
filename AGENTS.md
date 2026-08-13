# excalidraw-desktop Project Instructions

## Project Intent

Build `excalidraw-desktop` as a macOS-first desktop application using Tauri 2.x, a React/TypeScript frontend, and a Rust backend. macOS is the required native acceptance platform; Ubuntu 24.04 Desktop is optional community validation, while Fedora/other Linux and Windows are outside the current support commitment. Preserve native desktop behavior, strong security boundaries, accessibility, and maintainable frontend/backend contracts.

The repository is a working Tauri 2.x + Vite/React application implementing seven user stories: offline editing and saving, crash-safe persistence, a workspace file sidebar, external-change detection and conflict resolution, PNG/SVG export, macOS native integration, and multi-workspace browsing with thumbnails and asset deduplication. The persistence core is reliability-first: atomic writes, recovery snapshots, and fault-injection testing.

## Expected Structure

- `src/`: React 19 + TypeScript strict frontend.
- `src-tauri/`: Rust backend (Tauri 2.x).
- `specs/`: symlink to the private specs repository holding the authoritative feature specification, plan, research, data model, tasks, and checklists (ignored by Git, not part of this public repo).
- `docs/`: implementation-facing architecture records and ADRs.
- `.codex/`: developer-local Codex configuration. It is ignored by Git and MUST NOT be required to build, test, review, or contribute to the project.

Tests follow the conventions of the selected frontend, Rust, and end-to-end tooling rather than a structure invented in advance.

## Architecture and Ownership

The application is a Tauri 2.x dual-process layout: `src/` (React 19 + TypeScript strict frontend) and `src-tauri/` (Rust backend), communicating across an IPC contract boundary. See `docs/architecture.md` for the layered view, data flows, and trust boundaries; `docs/adr/` for decision records; and `docs/contracts/ipc-contracts.md` for the IPC contract.

The main agent owns requirements, integration, final edits, and validation. Ownership boundaries below describe the capabilities a change requires, not any named agent; each coding tool maps these roles to its own local configuration (for example Codex `.codex/agents/*.toml`, opencode `.agents/`).

- For a Tauri feature crossing React and Rust, use a Tauri-contract role when IPC, permissions, shared native APIs, or lifecycle is central. Use a desktop-platform role when OS compatibility or packaging is central. Use a general full-stack role for ordinary application-level vertical slices. Use UI or Rust specialist roles alone only for work contained within that layer.
- Performance-sensitive work MUST include measurement and a regression verdict in its acceptance track. Implementation stays with the owning role; measurement methodology and the verdict stay with a performance-measurement role.
- Atomic persistence, abnormal-exit recovery, conflict resolution, and native desktop E2E MUST include desktop-reliability testing. Browser-only evidence is insufficient.
- Platform integration and release packaging are owned by a desktop-platform role; the Tauri-contract role reviews the shared Tauri contract but does not duplicate platform implementation.
- Use a single-layer reviewer role for small, predominantly single-layer diffs. Use a full-stack reviewer role for Rust/TypeScript, IPC, persistence, infrastructure, reliability, or performance-boundary review.
- A general full-stack role MUST NOT own core IPC architecture, crash recovery, atomic persistence, native packaging, platform compatibility, or performance/reliability gates.

## Documentation Map

Spec-driven deliverables are recorded at these canonical paths. The private specs repository names deliverables; this public repo owns the paths:

| Deliverable | Path |
|-------------|------|
| Architecture decision records (ADR) | `docs/adr/` |
| Architecture overview | `docs/architecture.md` |
| IPC contract | `docs/contracts/ipc-contracts.md` |
| Quick start guide | `docs/quickstart.md` |
| Native verification evidence | `docs/evidence/native-verification.md` |
| Accessibility audit | `docs/evidence/a11y-audit.md` |
| Validation summaries | `docs/evidence/validation-summary.md` |

## Spec-Driven Development (SDD) Workflow

1. Translate a fuzzy request into the smallest coherent user-visible outcome. Identify assumptions, affected boundaries, and what success looks like.
2. Inspect relevant code, configuration, tests, and established conventions before editing. Never invent commands, APIs, paths, Tauri permissions, or repository behavior.
3. For low-risk ambiguity resolved by repository conventions, proceed and state the assumption. Ask one targeted question when the choice materially changes UX, data, APIs, security, dependencies, compatibility, or architecture.
4. Implement a complete vertical slice rather than disconnected placeholders. Keep scope tight and preserve behavior outside the request.
5. Add or update tests for changed behavior and run the narrowest relevant checks across every affected layer.
6. Review the final diff for correctness, security, accessibility, compatibility, and unrelated churn before handoff.

Do not add speculative abstractions, dependencies, services, configuration formats, or platform support. Do not rewrite working architecture to solve a local problem.

## Engineering Boundaries

- Keep TypeScript strict and faithful to runtime data. Avoid `any` and assertions used only to silence type errors.
- Keep domain invariants in one authoritative layer. Do not duplicate business rules across TypeScript and Rust.
- Make IPC and API contracts small, typed, explicit, and version-aware. Validate all frontend and external input at the Rust or backend trust boundary.
- Grant the minimum Tauri capabilities and OS permissions. Never disable CSP, broaden permissions, bypass validation, or weaken signing as a default workaround.
- Keep secrets out of source, frontend state, logs, fixtures, and committed environment files.
- Preserve semantic HTML, keyboard operation, focus behavior, accessible names, reduced motion, responsive layouts, and macOS interaction conventions.
- Avoid `unsafe`, panics, `unwrap`, and `expect` on reachable production input unless a proven invariant and repository convention justify them.
- Treat loading, empty, cancellation, timeout, retry, offline, permission-denied, and failure states as part of a feature when applicable.

## Commands and Validation

The manifests establish the following workflows:

- `pnpm dev`: run the Vite development server.
- `pnpm build`: run the strict TypeScript check and Vite production build.
- `pnpm lint`: run the frontend ESLint gate.
- `pnpm typecheck`: run the standalone strict TypeScript gate.
- `pnpm test`: run the Vitest unit suite.
- `APP_E2E=1 pnpm e2e`: run the Playwright suites; native-shell and fault-injection cases require the test-only Tauri build described by the E2E fixture.
- `pnpm fonts:build`: build the bundled CJK hand-drawn font from the licensed local source fonts.
- `pnpm tauri dev`: run the Tauri development application through the package script.
- `pnpm tauri build`: build the current Tauri bundle through the package script.
- `VITE_E2E_HARNESS=1 pnpm tauri build --features e2e-harness`: build the test-only native binary required by T090/T108; production releases MUST omit this feature.
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`: check Rust formatting.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: run the Rust lint gate.
- `cargo test --manifest-path src-tauri/Cargo.toml`: run the Rust unit and integration tests.

The reference-performance workflow and test-only fault-injection harness are implemented infrastructure. T090/T108 produce auditable `pass`/`fail` measurements on the declared macOS 26.5.2, 4 vCPU / 8GB Parallels Desktop Pro VM; budget failures remain visible but do not block merging or open-source releases. Reference runs set `PERF_TEST=1`, `PERF_REFERENCE_RUN=1`, `PERF_EXECUTION_ENVIRONMENT=virtual`, `PERF_HOST_HARDWARE`, `PERF_VIRTUALIZATION_NAME="Parallels Desktop Pro"`, and `PERF_VIRTUALIZATION_VERSION`; the GitHub workflow reads host hardware and Parallels version from repository variables. macOS bundles are permanently distributed unsigned and unnotarized through GitHub Releases; pushing a `v*` tag publishes them, while App Store, Developer ID, and Apple notarization are not project requirements.

Performance validation order: after feature development, run the physical-macOS functional and performance measurements first (fast iteration that surfaces product regressions and workload-design flaws before the slow VM gate), then the declared-reference VM measurement (T090/T108) as the auditable gate. The VM report is authoritative evidence, but the physical run precedes it.

Validation must be proportional to risk and should eventually include, as applicable:

- Frontend formatter, lint, strict typecheck, focused tests, and production build.
- Rust formatting check, targeted compilation, Clippy, and focused tests.
- Contract or IPC integration tests for changed frontend/backend boundaries.
- Playwright CLI flows for browser-visible UI behavior.
- Manual macOS/Tauri checks for windows, menus, dialogs, permissions, filesystem behavior, Gatekeeper user override, and packaging that browser tests cannot prove. A recorded target-OS VM or physical machine is acceptable evidence; never claim unexecuted physical-device coverage.

Never claim a check passed unless it actually ran successfully. If validation requires unavailable services, target operating systems, or declared VM configuration details, report the exact gap without weakening code or tests.

## Git and Completion

The primary branch is `main`. Do not commit unless explicitly requested. Keep changes focused, use short imperative commit subjects when asked to commit, and never bypass hooks or force-push the primary branch. Do not discard or overwrite user changes.

A task is complete only when the requested outcome works across the affected path, relevant tests and documentation are updated, applicable checks pass or exact gaps are reported, no secrets are introduced, and the final handoff lists changed files, validation, assumptions, and residual risks.

## Worktree Safety and SDD Commit Cadence

Two related policies apply here and are defined in the global user-level agent instructions. They are deliberately tool-agnostic: they bind every coding agent (Codex, opencode, Cursor, and others), because destructive worktree operations and commit cadence are failure modes shared by all AI coding agents, not by any single tool.

- **Worktree Safety (all development modes)**: pre-work uncommitted-change audit, WIP-branch backup before destructive worktree operations, and native-Git integration. This applies to every repository and every development mode, including manual spec → plan → task → implement → validate loops that do not use SpecKit tools.
- **Spec-Driven Development Commit Cadence**: checkpoint-level commits with safety and boundary triggers, plus task-tracking checkboxes committed with the code that satisfies them. This applies whenever work is driven by this repository's private `specs/` spec/plan/tasks artifacts, whether executed with SpecKit tools or manually.

This project adds no conflicting rules; if a future project-specific exception is needed, document it here explicitly rather than duplicating the global policy.
