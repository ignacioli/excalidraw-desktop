# Documentation

This directory holds the public, contributor-facing documentation for `excalidraw-desktop`.

## Contents

- `architecture.md` — layered view, data flows, module responsibilities, and trust boundaries
- `quickstart.md` — quick start guide
- `contracts/ipc-contracts.md` — IPC contract between the React frontend and the Rust backend
- `adr/` — architecture decision records (ADR-001 through ADR-005)
- `evidence/` — verification and audit evidence (accessibility audit, native verification matrix, validation summaries)

## Specs

The spec-driven development (SDD) lifecycle artifacts — feature specification, implementation
plan, research notes, data model, task tracking, and checklists — live in a separate private
repository rather than in this public repo. Core maintainers access them locally through a
gitignored `specs/` symlink.
