# Deterministic native macOS validation

T023b uses a terminal-driven harness. It does not use screenshots or Computer
Use for package identity, menu semantics, keyboard equivalents, or command
delegation.

## Commands

From the product worktree on macOS:

```sh
# Requires a clean commit. Runs the exact production build command and writes
# src-tauri/target/native-validation/<commit>/manifest.json.
pnpm run native:macos:seal

# Verifies the sealed .app and artifact hashes, then launches that exact
# executable and records structured JSON evidence.
pnpm run native:macos:validate -- \
  --manifest src-tauri/target/native-validation/<commit>/manifest.json \
  --report src-tauri/target/native-validation/<commit>/t023b-report.json

# Pure manifest/report/probe parsing tests; no GUI is launched.
pnpm run native:macos:test
```

The production build must emit these stderr probe records when launched by the
harness with `EXCALIDRAW_NATIVE_MENU_VALIDATION=1`:

```text
EXCALIDRAW_NATIVE_MENU_VALIDATION {"stage":"nativeEntry","validationId":1,"command":"save"}
EXCALIDRAW_NATIVE_MENU_VALIDATION {"stage":"applicationRoute","validationId":1,"command":"save"}
```

The harness checks File > Save, File > Export Image, View > Appearance >
System/Light/Dark, their enabled states and AX keyboard equivalents, a
1280x760 native window, and menu/keyboard invocation pairs. It refuses to
launch when an existing matching app process makes package identity ambiguous,
and it terminates only the child process it spawned.

No T023b acceptance fact currently requires Computer Use. The later HF-2 visual
parity gate still requires its deterministic captures and independent visual
review, including appearance after System/Light/Dark, but that separate gate is
not used to prove menu existence, labels, enabled state, shortcuts, package
identity, or application routing and does not itself require exploratory
Computer Use.

Validation writes `PASS`, `FAIL`, or `BLOCKED` checks as JSON. `BLOCKED` is used
for unavailable macOS/Accessibility/System Events prerequisites; it is not
converted into a pass.
