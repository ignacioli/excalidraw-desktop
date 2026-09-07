[English](AGENTS.md) | [简体中文](AGENTS.zh.md)

# excalidraw-desktop Project Instructions

## Project Intent

Build `excalidraw-desktop` as a macOS-first desktop application using Tauri 2.x, a React/TypeScript frontend, and a Rust backend. macOS is the required native acceptance platform; Ubuntu 24.04 Desktop is optional community validation, while Fedora/other Linux and Windows are outside the current support commitment. Preserve native desktop behavior, strong security boundaries, accessibility, and maintainable frontend/backend contracts.

The repository is a working Tauri 2.x + Vite/React application implementing seven user stories: offline editing and saving, crash-safe persistence, a workspace file sidebar, external-change detection and conflict resolution, PNG/SVG export, macOS native integration, and multi-workspace browsing with a continuous virtualized workspace tree and asset deduplication. The shell is canvas-first: the Workspace Sidebar starts hidden, opens as an overlay, and can be pinned. Do not restore FileTree, production `dir_list` listing, canvas-content thumbnails, or `thumb_*` IPC. The persistence core is reliability-first: coalesced hot-tier drafts, atomic cold-file writes, recovery snapshots, and fault-injection testing. Do not regress that contract to chase RSS or idle CPU—do not switch back to in-place overwrites, lengthen the draft window as a resource workaround, or remove recovery snapshots / idle checkpoints.

## Expected Structure

- `src/`: React 19 + TypeScript strict frontend.
- `src-tauri/`: Rust backend (Tauri 2.x).
- `specs/`: symlink to the private specs repository holding the authoritative feature specification, plan, research, data model, tasks, and checklists (ignored by Git, not part of this public repo). Before changing any linked specification, read `specs/AGENTS.md` and audit the private repository's Git status, staged content, and unpushed commits separately; this public repository's Git status does not cover linked files.
- `docs/`: implementation-facing architecture records and ADRs.
- `.codex/`: developer-local Codex configuration. It is ignored by Git and MUST NOT be required to build, test, review, or contribute to the project.

Tests follow the conventions of the selected frontend, Rust, and end-to-end tooling rather than a structure invented in advance.

## Architecture and Change Boundaries

The application is a Tauri 2.x dual-process layout: `src/` (React 19 + TypeScript strict frontend) and `src-tauri/` (Rust backend), communicating across an IPC contract boundary. See `docs/architecture.md` for the layered view, data flows, and trust boundaries; `docs/adr/` for decision records; and `docs/contracts/ipc-contracts.md` for the IPC contract.

What a change may touch is a project constraint, not a particular editor or assistant:

- A change that crosses React and Rust must keep the IPC contract, Tauri capabilities, and app lifecycle explicit. Do not expand permissions, bypass validation, or treat native APIs as frontend details. UI-only or Rust-only edits are appropriate only when the work is truly contained in that layer.
- OS compatibility, installers, file association, Gatekeeper behavior, and release packaging need native platform verification. Browser tests do not prove those paths.
- Performance-sensitive work MUST include measurement and a regression verdict in the same acceptance track. Do not ship a performance claim from implementation intent alone.
- Atomic persistence, abnormal-exit recovery, conflict resolution, and native desktop E2E MUST include process-level reliability testing. Browser-only evidence is insufficient.
- Do not use an ordinary feature slice to redesign core IPC architecture, crash recovery, atomic persistence, native packaging, platform support, or performance/reliability gates.

## Documentation Map

Spec-driven deliverables are recorded at these canonical paths. The private specs repository names deliverables; this public repo owns the paths.

User-facing and root contributor docs use English as the canonical filename (no suffix) and Simplified Chinese as a `*.zh.md` sibling next to it. `docs/adr/` is not bilingual. Public user-facing pages (`README.md`, `DESIGN.md`, `CONTEXT.md`, `CHANGELOG.md`, `docs/architecture.md`, `docs/quickstart.md`) describe the product, architecture, and how to run it; they must not cite private-spec numbering such as feature `001`/`002`, spec user-story IDs, or `T0xx` task IDs. Those identifiers belong in `docs/evidence/` and, when needed, ADRs.

| Deliverable | Path |
|-------------|------|
| User README (English / Chinese) | `README.md` / `README.zh.md` |
| Visual and interaction contract (English / Chinese) | `DESIGN.md` / `DESIGN.zh.md` |
| Ubiquitous language (English / Chinese) | `CONTEXT.md` / `CONTEXT.zh.md` |
| Contributor and maintainer instructions (English / Chinese) | `AGENTS.md` / `AGENTS.zh.md` |
| Changelog | `CHANGELOG.md` |
| Architecture decision records (ADR) | `docs/adr/` |
| Architecture overview (English / Chinese) | `docs/architecture.md` / `docs/architecture.zh.md` |
| IPC contract | `docs/contracts/ipc-contracts.md` |
| Getting started and verification (English / Chinese) | `docs/quickstart.md` / `docs/quickstart.zh.md` |
| Native verification evidence | `docs/evidence/native-verification.md` |
| Accessibility audit | `docs/evidence/a11y-audit.md` |
| Validation summaries | `docs/evidence/validation-summary.md` |

`Phase N` in `specs/` (`tasks.md`, `plan.md`) means the Spec-Driven Development stages (Setup, Foundational, US1–US7, Polish). Do not reuse `Phase 1/2/3/4` in ADRs or evidence for the 2026-08-14 performance measurement work; that numbering is not SDD. Name those activities by date and what they did (full-tree remeasure, physical attribution, ADR-007 budget/workload calibration).

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
- **Codex managed macOS sandbox**: for browser-visible Playwright runs, do not let Playwright start its configured `webServer` inside the sandbox. Start `pnpm dev --host 127.0.0.1` outside the sandbox and wait for the ready URL, then run Playwright with `PLAYWRIGHT_SKIP_WEBSERVER=1` (and set `PLAYWRIGHT_BASE_URL` when using a non-default port). Ordinary developer shells and CI may continue to use the configured `webServer`.
- `pnpm fonts:build`: build the bundled CJK hand-drawn font from the licensed local source fonts.
- `pnpm tauri dev`: run the Tauri development application through the package script.
- `pnpm tauri build`: build the current Tauri bundle through the package script.
- `VITE_E2E_HARNESS=1 pnpm tauri build --features e2e-harness`: build the test-only native binary required by T090/T108; production releases MUST omit this feature.
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`: check Rust formatting.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: run the Rust lint gate.
- `cargo test --manifest-path src-tauri/Cargo.toml`: run the Rust unit and integration tests.

The reference-performance workflow and test-only fault-injection harness are implemented infrastructure. T090/T108 produce auditable `pass`/`fail` measurements on the declared macOS 26.5.2, 4 vCPU / 8GB Parallels Desktop Pro VM; budget failures remain visible but do not block merging or open-source releases. Reference runs set `PERF_TEST=1`, `PERF_REFERENCE_RUN=1`, `PERF_EXECUTION_ENVIRONMENT=virtual`, `PERF_HOST_HARDWARE`, `PERF_VIRTUALIZATION_NAME="Parallels Desktop Pro"`, and `PERF_VIRTUALIZATION_VERSION`; the GitHub workflow reads host hardware and Parallels version from repository variables. macOS bundles are permanently distributed unsigned and unnotarized through GitHub Releases; App Store, Developer ID, and Apple notarization are not project requirements. Merging a version-bump PR to `main` (four version files plus one `CHANGELOG.md` section) creates annotated tag `vX.Y.Z` and publishes the GitHub Release. Pushing a `v*` tag still publishes. Ordinary feature PRs must not edit `CHANGELOG.md` or create tags. Do not open an empty GitHub Release in the UI before the workflow runs.

Performance validation order: after feature development, run the physical-macOS functional and performance measurements first (fast iteration that surfaces product regressions and workload-design flaws before the slow VM gate), then the declared-reference VM measurement (T090/T108) as the auditable gate. The VM report is authoritative evidence, but the physical run precedes it.

Validation must be proportional to risk and should eventually include, as applicable:

- Frontend formatter, lint, strict typecheck, focused tests, and production build.
- Rust formatting check, targeted compilation, Clippy, and focused tests.
- Contract or IPC integration tests for changed frontend/backend boundaries.
- Playwright CLI flows for browser-visible UI behavior.
- Manual macOS/Tauri checks for windows, menus, dialogs, permissions, filesystem behavior, Gatekeeper user override, and packaging that browser tests cannot prove. A recorded target-OS VM or physical machine is acceptable evidence; never claim unexecuted physical-device coverage.

### UI debugging and visual-evidence efficiency

- Validate app-owned shell UI through source inspection, focused unit/integration tests, semantic DOM/accessibility locators, and deterministic Playwright fixtures before using screenshots. Prefer roles, names, and labels; add `data-testid` only for stable app-owned gaps, and never depend on private Excalidraw SDK DOM or test IDs.
- Use the viewport, theme, fixture, font state, and tolerances defined by the active feature contract. Do not replace them with a generic viewport or ad-hoc desktop state.
- Capture or inspect images only at an explicit visual/native evidence gate or when structured checks cannot explain a failure. Work one required screen or failing region at a time; do not impose an arbitrary screenshot cap when the gate requires multiple captures.
- Treat browser rendering as preflight. Use the exact packaged Tauri build for native menus, windows, dialogs, filesystem error paths, system appearance, packaging, and other behavior that browser automation cannot prove.
- Bind evidence to the exact product commit, package identity, and recorded environment. Keep automated results, independent visual-review verdicts, and product-owner decisions distinct; none substitutes for another.

Never claim a check passed unless it actually ran successfully. If validation requires unavailable services, target operating systems, or declared VM configuration details, report the exact gap without weakening code or tests.

## Long-Running Tasks

These rules bind anyone who starts a command expected to run longer than a few minutes (performance measurements, soak tests, builds, VM runs):

1. **Announce before starting**: state in the conversation, before launching, the expected duration and the concrete completion signal (for example "canvas-io spec, ~8–10 minutes, done when the report JSON lands"). The user must be able to leave and work on other things instead of waiting blind.
2. **Heartbeat while running**: proactively check the task's health on a fixed interval (about every 5 minutes) and report the result into the conversation — even a no-progress report ("still running healthily, N samples collected") counts. A live process alone is not health; check observable intermediate artifacts (sample counts, report files, `error.json`). Tasks that cannot expose such signals should be fixed to expose them before being relied on.
3. **30-minute cap with explicit exemption**: a single background command must not exceed 30 minutes by default. Splittable work must be split (for example, run the three perf specs as three commands; each boundary is a natural report point). A genuinely unsplittable longer task requires announcing the expected duration to the user and getting acknowledgment before launch, and must still satisfy the heartbeat rule.

## Git and Completion

The primary branch is `main`. Keep changes focused, use short imperative commit subjects, and never bypass hooks or force-push the primary branch. Do not discard or overwrite unrelated local work. Automated coding tools MUST NOT create a commit unless the operator explicitly asked.

**Protected primary branch.** Do not modify tracked files, stage, or commit on `main` or `master`. Fetch `origin/main` and create a topic branch from that up-to-date tip (or merge `origin/main` into the topic branch) before changing tracked files. Prefer a dedicated git worktree so the primary checkout can remain on `main`. Direct commits to `main`/`master` are forbidden even when they look small; land them through a branch and pull request. Gitignored local state on the primary checkout is allowed: editor/agent skills, `.codex/`, and `.handoff/`.

A task is complete only when the requested outcome works across the affected path, relevant tests and documentation are updated, applicable checks pass or exact gaps are reported, no secrets are introduced, and the final handoff lists changed files, validation, assumptions, and residual risks.

## Worktree Safety and SDD Commit Cadence

Two related policies apply to every contributor and every automated coding tool. Destructive worktree operations and commit cadence are shared failure modes; they are not specific to one editor.

- **Worktree Safety (all development modes)**: pre-work uncommitted-change audit, WIP-branch backup before destructive worktree operations, and native-Git integration. This applies to every repository and every development mode, including manual spec → plan → task → implement → validate loops that do not use SpecKit tools.
- **Spec-Driven Development Commit Cadence**: checkpoint-level commits with safety and boundary triggers, plus task-tracking checkboxes committed with the code that satisfies them. This applies whenever work is driven by this repository's private `specs/` spec/plan/tasks artifacts, whether executed with SpecKit tools or manually.

**Local toolchain bootstrap.** Editor skills, SpecKit scripts/templates, Codex project agents, the private `specs/` symlink, and `.handoff/` are developer-local and gitignored so the public repository does not ship one editor's toolchain. They live on the primary checkout only. After `git worktree add` for this product repository, and before using project skills, SpecKit scripts, `.handoff`, Cursor subagents, or Codex project subagents in that worktree, run `scripts/bootstrap-local-worktree.sh` with the worktree as the current working directory. Before this script exists on the branch you are in, invoke the copy from another up-to-date checkout the same way: `cwd` is the worktree to wire, not the script's location. The script is idempotent: it relative-symlinks whatever exists on the primary checkout and skips missing sources. If a destination already exists as a real directory, stop and report it; `--force` backs that path up and replaces it, and is invalid on the primary checkout. Do not copy another developer's `.agents`, `.cursor`, or `.codex` into git or into a worktree. Do not symlink all of `.specify/`, `.cursor/`, or `.codex/` — only the ignored runtime subtrees listed by the script (including `.codex/agents`, not the rest of `.codex/`). Private specs worktrees are a different Git repository and are not wired by this script.

**Switching a product worktree to Codex.** Codex reads `.codex/agents/*.toml` from the worktree root, not from the primary checkout. An agent that is asked to continue this branch in Codex, or that is opening Codex against an existing product worktree, must: (1) use that worktree as `cwd`, never `main`; (2) run `scripts/bootstrap-local-worktree.sh` (idempotent); (3) confirm `.codex/agents` is a symlink whose real path is the primary checkout's `.codex/agents` and that the TOML files parse; (4) confirm `specs/003-desktop-shell-ux-ui` (or the current `feature.json` directory) resolves. Then start Codex with that worktree as the working directory. Do not copy TOML files, do not symlink all of `.codex/`, and do not start implementation on `main`.

This project adds no conflicting rules; if a future project-specific exception is needed, document it here explicitly rather than duplicating the global policy.
