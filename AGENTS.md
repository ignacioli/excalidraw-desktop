# excalidraw-desktop Project Instructions

## Project Intent

Build `excalidraw-desktop` as a macOS-first desktop application using Tauri 2.x, a React/TypeScript frontend, and a Rust backend. Preserve native desktop behavior, strong security boundaries, accessibility, and maintainable frontend/backend contracts. Do not assume the final packaging, persistence, update, synchronization, or upstream-Excalidraw integration strategy until repository code or an approved product decision establishes it.

The repository currently contains a Tauri 2.x + Vite/React bootstrap scaffold and the complete SpecKit design set under `specs/001-excalidraw-desktop/`. Product features, project test infrastructure, and CI workflows have not yet been implemented. Treat the manifests and scaffold source as real current state, while paths described only by the plan remain expected future structure.

## Expected Structure

- `.codex/`: developer-local Codex configuration. It is ignored by Git and MUST NOT be required to build, test, review, or contribute to the project.
- `src/`: current Vite/React scaffold; expected to evolve into the domain-oriented frontend described by the approved plan.
- `src-tauri/`: current Tauri 2.x Rust scaffold and configuration; expected to evolve into the approved backend modules.
- `specs/001-excalidraw-desktop/`: authoritative feature specification, plan, research, data model, IPC contracts, tasks, and validation guide.
- Tests should follow the conventions of the selected frontend, Rust, and end-to-end tooling rather than a structure invented in advance.

Treat these paths as expectations, not verified current structure. Inspect the repository before every task.

## Vibe-Coding Workflow

1. Translate a fuzzy request into the smallest coherent user-visible outcome. Identify assumptions, affected boundaries, and what success looks like.
2. Inspect relevant code, configuration, tests, and established conventions before editing. Never invent commands, APIs, paths, Tauri permissions, or repository behavior.
3. For low-risk ambiguity resolved by repository conventions, proceed and state the assumption. Ask one targeted question when the choice materially changes UX, data, APIs, security, dependencies, compatibility, or architecture.
4. Implement a complete vertical slice rather than disconnected placeholders. Keep scope tight and preserve behavior outside the request.
5. Add or update tests for changed behavior and run the narrowest relevant checks across every affected layer.
6. Review the final diff for correctness, security, accessibility, compatibility, and unrelated churn before handoff.

Do not add speculative abstractions, dependencies, services, configuration formats, or platform support. Do not rewrite working architecture to solve a local problem.

## Agent Routing

The main agent owns requirements, integration, final edits, and validation. The names below describe logical capability roles and ownership boundaries, not repository-required Codex configurations. Contributors may map them to their own agents, tools, or review process:

- `prod-arch`: requirements, product specification, MVP scope, user stories, and delivery phases.
- `fullstack-developer`: one bounded feature spanning ordinary frontend and backend behavior.
- `ui-dev`: React/TypeScript UI, accessibility, responsive behavior, Tailwind, shadcn/ui, and frontend performance.
- `rust-expert`: Rust persistence, atomic writes, recovery primitives, SQLite, indexing, watcher internals, concurrency, backpressure, and measured performance fixes.
- `tauri-dev`: Tauri architecture, typed IPC, commands/events, managed state, capabilities, CSP, lifecycle, and coordinated React/Rust security boundaries.
- `desktop-platform-dev`: macOS/Linux Tauri platform behavior, WKWebView/WebKitGTK, IME, clipboard/drag-drop, file association, signing/notarization, Universal Binary, and AppImage/deb/rpm delivery. Windows is out of scope.
- `e2e-tester`: browser-visible workflows, accessibility, visual fidelity, and Playwright UI coverage; it does not prove native-shell or filesystem durability behavior.
- `desktop-reliability-tester`: Tauri process-level E2E, SIGKILL, atomic-write fault points, disk/resource failures, recovery, conflicts, event storms, and long-running stability.
- `performance-engineer`: performance budgets, deterministic fixtures, CPU/RSS/frame/IPC/disk measurement, profiling, soak tests, fixed-hardware baselines, and CI regression verdicts.
- `code-reviewer`: language-agnostic review of a bounded diff or implementation path.
- `fs-reviewer`: deep full-stack review across Rust, TypeScript, frontend/backend boundaries, IPC, or IaC.
- `doc-writer`: user, developer, API, troubleshooting, and operational documentation.
- `arch-doc-gener`: evidence-based architecture documentation and diagrams.

Use no subagents for straightforward single-track work. When work splits into at least two independent tracks, delegate all independent tracks together and give each agent a non-overlapping scope and concrete return format. Never launch exactly one subagent as a sequential handoff. Do not let multiple agents edit the same files concurrently. The main agent must reconcile contracts and validate the integrated result.

For a Tauri feature crossing React and Rust, prefer `tauri-dev` when IPC, permissions, shared native APIs, or lifecycle is central. Prefer `desktop-platform-dev` when OS compatibility or packaging is central, and `fullstack-developer` for ordinary application-level vertical slices. Use `ui-dev` or `rust-expert` alone only for work contained within that layer.

Keep high-risk ownership explicit:

- Performance-sensitive work MUST include `performance-engineer` in its acceptance track. Implementation stays with the owning UI, Rust, Tauri, or platform agent; measurement methodology and the regression verdict stay with `performance-engineer`.
- Atomic persistence, abnormal exit, recovery, conflict resolution, or native desktop E2E MUST include `desktop-reliability-tester`. Browser-only evidence is insufficient.
- User Story 6 platform integration and release packaging is owned by `desktop-platform-dev`; `tauri-dev` reviews the shared Tauri contract but does not duplicate platform implementation.
- Use `code-reviewer` only for small predominantly single-layer diffs. Use `fs-reviewer` for Rust/TypeScript, IPC, persistence, infrastructure, reliability, or performance-boundary review.
- `fullstack-developer` MUST NOT own core IPC architecture, crash recovery, atomic persistence, native packaging, platform compatibility, or performance/reliability gates.

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
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`: check Rust formatting.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: run the Rust lint gate.
- `cargo test --manifest-path src-tauri/Cargo.toml`: run the Rust unit and integration tests.

The fixed-runner performance workflow and test-only fault-injection harness are implemented infrastructure, but their absolute verdicts are valid only on the configured Apple M1 / 8GB runner. Signing, notarization, and release CI remain outside the current local validation scope.

Validation must be proportional to risk and should eventually include, as applicable:

- Frontend formatter, lint, strict typecheck, focused tests, and production build.
- Rust formatting check, targeted compilation, Clippy, and focused tests.
- Contract or IPC integration tests for changed frontend/backend boundaries.
- Playwright CLI flows for browser-visible UI behavior.
- Manual macOS/Tauri checks for windows, menus, dialogs, permissions, filesystem behavior, signing, and packaging that browser tests cannot prove.

Never claim a check passed unless it actually ran successfully. If validation requires unavailable credentials, services, signing identities, devices, or operating systems, report the exact gap without weakening code or tests.

## Git and Completion

The primary branch is `main`. Do not commit unless explicitly requested. Keep changes focused, use short imperative commit subjects when asked to commit, and never bypass hooks or force-push the primary branch. Do not discard or overwrite user changes.

A task is complete only when the requested outcome works across the affected path, relevant tests and documentation are updated, applicable checks pass or exact gaps are reported, no secrets are introduced, and the final handoff lists changed files, validation, assumptions, and residual risks.

## Spec-Driven Development (SpecKit) Workflow Protection

These rules govern every SpecKit development round, whether driven by `speckit-implement` or controlled manually by the user. They override the default "commit only when requested" behavior only at the explicit triggers below; the user may always narrow or broaden the scope.

### Pre-work uncommitted-change audit

Before starting any new development round, run `git status --short` and `git diff --stat`, then classify every change as tracked modification, untracked file, or staged content. Record the list in the plan and do not proceed until the state is understood. Treat all existing uncommitted changes as user-owned: never discard, reset, or overwrite them without explicit confirmation.

### Backup before destructive worktree operations

The following operations MAY silently destroy or overwrite uncommitted work and MUST be preceded by a WIP-branch commit backup (create a `wip/` or `codex/wip-*` branch and commit the full worktree state), or by explicit user confirmation to discard:

- Worktree-level merge, checkout, branch switch, or worktree add/remove when the worktree is dirty.
- `git reset --hard`, `git checkout -- <path>`, `git clean -fd`, and any archive extraction that overwrites tracked files (for example `git archive | tar -x`).
- Bulk file copies or scripted rewrites that touch files outside the current task's ownership.

Prefer native Git operations (`git merge`, `git cherry-pick`) over archive extraction or manual copying; native operations either preserve uncommitted work or fail loudly instead of silently replacing it.

### Commit triggers

- **Checkpoint level (primary)**: commit once at each story/phase Checkpoint after its validation gates pass. Intermediate TDD states (tests written and failing before implementation) may stay uncommitted until the checkpoint.
- **Safety trigger**: commit the full worktree to a WIP branch before any destructive operation listed above, even mid-checkpoint.
- **Boundary trigger**: commit when a session is handed off (for example a `.handoff` note is generated) and whenever a task changes from `[ ]` to `[X]` in `tasks.md`.

`tasks.md` checkboxes MUST be committed together with, or immediately after, the code that satisfies them; never commit task checkmarks ahead of their implementation. Integration of parallel branches uses merges only and never archive extraction over a dirty worktree.
