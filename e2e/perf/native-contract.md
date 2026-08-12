# Native performance control contract

The performance specs set `EXCALIDRAW_PERF_CONTROL_DIR` only on an
`e2e-harness` build. Production builds must ignore this variable and must not
include the driver.

The directory contains these UTF-8 JSON files. Writers publish each file by
renaming a complete temporary file; readers must process each `commandId` once.

- `bootstrap.json` exists before process spawn. It selects
  `startup-editable`, `canvas-10k`, or `edit-soak`, supplies a deterministic
  seed, and may identify the generated 10,000-element fixture.
- `ready.json` is written only after the Excalidraw imperative API is present,
  accepts edits, the requested scene has finished loading, and the document is
  visible. It reports the exact live element count.
- `command.json` requests one visible `pan-zoom`, `high-frequency-edit`, or
  `edit-soak` workload for the stated monotonic duration.
- `result.json` echoes the `commandId`, actual duration and edit-event count.
  Visible frame workloads include every `requestAnimationFrame` interval
  measured with `performance.now()` for at least 95% of the requested window.

The TypeScript interfaces and runtime validation in
`helpers/nativePerformanceContract.ts` are authoritative. Missing, malformed,
hidden-window, short-duration, wrong-element-count, or uncovered-frame results
are `not_evaluated`, and the test exits with an error because incomplete native
evidence cannot close T090/T108. Complete reference runs record honest `pass`
or `fail` budget verdicts without turning a budget miss into a merge or release
block. This prevents process-alive timing or browser-only automation from being
reported as native editable-canvas evidence.

Every report records `executionEnvironment.type`. Local diagnostic runs that do
not explicitly set `PERF_EXECUTION_ENVIRONMENT=physical|virtual` use
`unspecified`; they must not be interpreted as physical-machine evidence. A
declared reference run requires `virtual` plus the recorded host hardware and
exact Parallels Desktop Pro version.
