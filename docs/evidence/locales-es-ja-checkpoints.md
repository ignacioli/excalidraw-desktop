# Spanish and Japanese locale checkpoints

Execution record for adding Spanish (Español) and Japanese (日本語) to the
interface languages: language matching, translations, canvas editor strings,
the native menu, independent code and translation reviews, and the visual
spot-check.

Each section records the candidate commit, the commands that ran, the result
(PASS, FAIL, or BLOCKED), and the gaps that the run did not cover. Automated
results, reviewer conclusions, and product-owner conclusions are recorded
separately; none stands in for another. Screenshots are not used as evidence
for structural facts such as menu items, labels, routing, or catalog
completeness.

## Language set and matching

Preference values `es` and `ja`, system-language matching, the five-option
language menus, the IPC value extension, the native menu model, and the
bundle localization list. Spanish and Japanese catalog text is still English,
except the language names Español and 日本語.

- Candidate: the commit that adds this section (parent `1e43088`), on macOS
  (Darwin 25.6.0), 2026-10-16.
- Result: PASS.

| Command                                                                                                          | Result                     |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `pnpm typecheck`                                                                                                 | PASS                       |
| `pnpm lint`                                                                                                      | PASS, 0 warnings           |
| `pnpm test`                                                                                                      | PASS, 86 files / 752 tests |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check`                                                         | PASS                       |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`                                 | PASS                       |
| `cargo test --manifest-path src-tauri/Cargo.toml`                                                                | PASS, 347 tests            |
| `APP_E2E=1 pnpm e2e e2e/tests/preferences-i18n-language.spec.ts e2e/tests/preferences-i18n-menu-entries.spec.ts` | PASS, 13 passed            |
| `pnpm native:menu:test`                                                                                          | PASS, 1 test               |
| `pnpm native:window:test`                                                                                        | PASS, 24 tests             |

What the checks cover:

- System matching: `es-MX`, `es-419`, `es-ES`, bare `es`, `ja-JP`, bare `ja`,
  traditional Chinese followed by Japanese, Spanish after English, Simplified
  Chinese before Spanish and Japanese, and a list with no supported language.
  A manual `es` or `ja` choice ignores the system list. Stored `es` and `ja`
  preferences restore; an unknown value still falls back to follow system.
- The canvas language menu lists Follow system, English, 简体中文, Español,
  and 日本語. Selecting Español or 日本語 reports `es` or `ja`.
- The canvas editor receives SDK language codes `en`, `zh-CN`, `es-ES`, and
  `ja-JP`.
- The IPC language value and the native menu commands add `es` / `ja` and
  `languageEs` / `languageJa`. The contract version stays 5. Unknown language
  values are still rejected. The native menu label set is 41 ids, and the
  new items use the language names.
- The Rust menu checks exactly one of the five language items. The menu
  check script reads labels from the matching catalog. Its unit test and the
  window-check unit test passed. `Info.plist` lists `es` and `ja`.
- Quantity text still uses `.one` when the count is 1 and `.other` otherwise.
  That already matches Spanish, and Japanese can use the same sentence for
  both keys, so the selector was not changed.

Gaps and open items:

- An earlier browser launch failed before any assertion because the browser
  executable path pointed at an empty sandbox cache. The recorded e2e result
  is the rerun against the installed browsers.
- `pnpm native:menu:check` was not run. It takes the foreground and is left
  for the later native-menu checkpoint. Bundle localization was not observed
  on a launched app.
- Spanish and Japanese sentences are still the English text, apart from the
  two language names. Equality with English, placeholder coverage beyond the
  existing catalog shape, SDK locale patches, date samples, and the README
  language note are not claimed here.
- No screenshots were taken.

## Translations

Spanish and Japanese app copy, written key by key with no English spread.
The first translation was produced by Grok 4.7.

- Candidate: the commit that adds this section (parent `2b47d17`), on macOS
  (Darwin 25.6.0), 2026-10-16.
- Result: PASS.

| Command                                                   | Result                     |
| --------------------------------------------------------- | -------------------------- |
| `pnpm test src/i18n src/history src/editor`               | PASS, 28 files / 242 tests |
| `pnpm build`                                              | PASS                       |
| `APP_E2E=1 pnpm e2e e2e/tests/preferences-i18n-*.spec.ts` | PASS, 33 passed            |

What the checks cover:

- Spanish and Japanese catalogs contain every English key. A missing key
  fails the type check because the catalogs no longer spread English.
- Strings that still match English are listed in the catalog test, each with
  a reason: language names, the window-title patterns, the product name
  Excalidraw Desktop, the `{value}x` scale notation, the Spanish adjective
  Manual, the placeholder announcement pattern, and the macOS Spanish Zoom
  label.
- Placeholder names match across English, Simplified Chinese, Spanish, and
  Japanese. Every `menu.native.*` label and every language name is at most
  64 characters in all four languages.
- History dates for Spanish and Japanese use that language's medium date and
  differ from the English medium date. Panel titles and source labels follow
  the selected language.
- `es-MX` on first launch shows Spanish, including the welcome action, the
  shell, the canvas rectangle and undo labels, and the native Save label.
- Switching between Spanish and Japanese twenty times keeps the in-progress
  text and the drawn shape. Undo still removes the text. The Japanese choice
  is still selected after reload.

Gaps and open items:

- A non-interactive shell set `CI=true` so pnpm would not stop to confirm a
  modules-directory refresh. The recorded commands and results are otherwise
  the commands above.
- While a drawing is open, the canvas editor sets the document language to
  `es-ES` or `ja-JP`. The switch test therefore checks the app menu language
  and the shell copy. The welcome screen still reports `es`.
- An earlier layout case failed because the canvas box was briefly
  unavailable. The helper waits until the box is measurable. The recorded
  e2e result is the rerun, 33 passed.
- `pnpm native:menu:check` was not run. No screenshots were taken. Independent
  review of the wording is not part of this run.

## Canvas editor strings

Missing SDK strings for es-ES (106) and ja-JP (132), in both the dev and
prod locale files. Existing upstream translations, the Simplified Chinese
fill, and the menu-button accessible name are unchanged.

- Candidate: the same commit as Translations (parent `2b47d17`), on macOS
  (Darwin 25.6.0), 2026-10-16.
- Result: PASS.

| Command                                     | Result                     |
| ------------------------------------------- | -------------------------- |
| `pnpm test src/i18n src/history src/editor` | PASS, 28 files / 242 tests |
| `pnpm build`                                | PASS                       |

What the checks cover:

- The coverage test loads the dev and prod locale modules for zh-CN, es-ES,
  and ja-JP and fails if any English key is missing or blank.
- The patch adds only keys that were missing. A check before the patch was
  written compared the previous non-empty values and rejected the edit if any
  of them changed. es-ES kept 407 existing values and gained 106. ja-JP kept
  381 and gained 132. Both totals are the 513 English keys.
- SDK placeholders stay in `{{name}}` form. The Simplified Chinese fill and
  the menu trigger `aria-label` remain in the same patch file.
- The production build emits the patched es-ES and ja-JP locale chunks.

Gaps and open items:

- The same `CI=true` note as Translations applies. No screenshots were taken.
- Upstream strings that were already translated were not reviewed or replaced.

## Code review

Independent read-only review of the code part of the change (`origin/main`
to `ca18bd9`; translation strings, the SDK locale patch, the lockfile, and
Markdown excluded). Reviewer model: DeepSeek V4.1 Flash, run in OpenCode,
2026-10-17. The reviewer wrote no files; each finding below was checked
against the cited lines before it was recorded.

- Result: PASS for production code. The five language values agree across the
  TypeScript types and runtime guards, the IPC contract, the Rust enums, serde
  names, menu ids and label ids, the native menu check script, and
  `Info.plist`. Unknown values are still rejected at the Rust boundary, stored
  unknown preferences still fall back to follow system, no assertion was
  weakened, English and Simplified Chinese behavior is unchanged, and no
  production code gained an `unwrap`, `expect`, or panic.

Findings and how they are handled:

| Finding                                                                                                                                                             | Severity   | Handling                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------- |
| The 1280×760 layout suite (`e2e/tests/preferences-i18n-layout.spec.ts`) checks overflow only in English and Simplified Chinese, so Spanish-only overflow would pass | must-fix   | Done: the suite now runs in English, Simplified Chinese, Spanish, and Japanese    |
| The no-English-residue browser check (`e2e/tests/preferences-i18n-language.spec.ts`) runs only in Simplified Chinese                                                | must-fix   | Done: the check now runs under Spanish and Japanese as well                        |
| The Japanese persistence test polls the same value twice after reload                                                                                               | should-fix | Done: the duplicate poll after reload was removed                                 |
| The one-second switch timer also covers a poll whose retry budget is longer                                                                                         | note       | Kept: the pattern predates this change and backs the one-second switch requirement |
| The accessibility audit and two dialog helpers still use English and Simplified Chinese only                                                                        | note       | Not extended in this change; recorded as a coverage gap                            |

## Translation review

Two-round independent review of the Spanish (`es`) and Japanese (`ja`)
translations across application catalogs and SDK locale additions.

- Initial translation model: Grok 4.7 (2026-10-16).
- Round 1 reviewer model: Gemini 3.8 Flash (2026-10-16). Round 1 updated only
  5 Spanish application strings and listed 6 pending SDK patch items, while
  missing at least 8 terminology and phrasing violations against the glossary
  (including `directorio` / `ディレクトリ` in `workspace.error.mountNoDialog`,
  `restaurar` / `復元` in `recovery.*` keys, and literal "history document"
  translations) and prematurely recording `PASS`.
- Round 2 reviewer model: Gemini 4 Argon (2026-10-17). Performed a complete
  key-by-key audit of all 198 application message keys in `es` and `ja` plus
  all 106 `es-ES` and 132 `ja-JP` SDK locale additions against the English
  source and glossary rules.
- Candidate: working tree on `topic/locales-es-ja` (parent `ca18bd9`), on macOS
  (Darwin 25.6.0), 2026-10-17.
- Overall result: PASS (all application must-fix and should-fix items are
  resolved in the working tree; 7 SDK locale items are recorded as
  `pending SDK patch`).

| Command                            | Result                   |
| ---------------------------------- | ------------------------ |
| `CI=true pnpm vitest run src/i18n` | PASS, 7 files / 79 tests |
| `pnpm typecheck`                   | PASS                     |
| `pnpm format`                      | PASS                     |

Area conclusions:

- Shell copy (`src/i18n/messages/shell.ts` and `error.*` / `recovery.error.*` in `es.ts` and `ja.ts`):
  - Spanish: PASS. 4 must-fix items from Round 1 (quit-failure phrasing and clear-canvas terminology) and 4 items from Round 2 (`error.unknown` duplicate word, explicit object on `tabs.closeOthers` / `tabs.closeAll`, and quotes around `"Bienvenida"` in `welcome.sessionNote`) are applied. Neutral `usted` forms, infinitive actions, and sentence case hold across all keys.
  - Japanese: PASS. 3 items from Round 2 (`tabs.closeOthers`, `tabs.closeAll`, and quoting `「ようこそ」` while replacing `文書` in `welcome.sessionNote`) are applied. Explanatory sentences use `です・ます`, action labels use concise forms without periods, and half-width spaces around Latin characters, numbers, and placeholders are preserved.
- Documents copy (`src/i18n/messages/documents.ts`):
  - Spanish: PASS. 6 items from Round 2 (`workspace.error.mountNoDialog` `directorio` -> `carpeta`, `recovery.restore` / `recovery.notice.one` / `recovery.notice.other` `restaurar` -> `recuperar`, and explicit `como un dibujo nuevo` on `conflict.saveAsNew` / `recovery.saveAsNew`) are applied.
  - Japanese: PASS. 6 items from Round 2 (`workspace.error.mountNoDialog` `ディレクトリ` -> `フォルダ`, `recovery.restore` / `recovery.notice.one` / `recovery.notice.other` `復元` -> `復旧`, and explicit `新しい図として保存` on `conflict.saveAsNew` / `recovery.saveAsNew`) are applied.
- History copy (`src/i18n/messages/history.ts`):
  - Spanish: PASS. 1 must-fix item from Round 1 (`history.source.beforeClear`) and 1 must-fix item from Round 2 (`history.panel.guard.documentChanged` avoiding `documento`) are applied.
  - Japanese: PASS. 3 must-fix items from Round 2 (`history.panel.guard.documentChanged` avoiding `文書`, `history.preview.renderFailed` avoiding `描画`, and `history.panel.retention.body` natural Japanese phrasing) are applied.
- Canvas menu / native menu (`menu.canvas.*` and `menu.native.*` in `es.ts` and `ja.ts`):
  - Spanish: PASS. All labels follow macOS Spanish conventions and sentence case (with `Modo Zen` and `Zoom` preserved per glossary), and all `menu.native.*` strings are well within the 64-character limit.
  - Japanese: PASS. All labels match macOS Japanese menu conventions (`ウインドウ`, `しまう`, `拡大/縮小`, `ほかを非表示`, etc.) and stay well within the 64-character limit.
- SDK additions (`patches/@excalidraw__excalidraw@0.18.1.patch`):
  - `es-ES` additions (106 keys): PASS with 1 item (`labels.clearCanvas`) recorded as `pending SDK patch`.
  - `ja-JP` additions (132 keys): PASS with 6 items (`element.freedraw`, `labels.textToDiagram`, 3 export strings using `書き出`, and `mermaid.description` using `描画`) recorded as `pending SDK patch`.

Mechanical checks (across all 198 application keys and 106 `es-ES` / 132 `ja-JP` SDK additions):

| Language | Rule checked                                                                    | Hits before (App / SDK) | Hits after (App / SDK) | Notes                                                                                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------- | ----------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `es`     | `directorio` (must be `carpeta`)                                                | 1 / 0                   | 0 / 0                  | Fixed in `workspace.error.mountNoDialog`.                                                                                                                                                                                                                          |
| `es`     | `restaurar` / `restaurado` in `recovery.*` (must be `recuperar` / `recuperado`) | 3 / 0                   | 0 / 0                  | Fixed in `recovery.restore`, `recovery.notice.one`, and `recovery.notice.other`.                                                                                                                                                                                   |
| `es`     | `tú` forms (pronouns or imperative/indicative conjugations)                     | 0 / 0                   | 0 / 0                  | All user-facing sentences use `usted`; actions use infinitives.                                                                                                                                                                                                    |
| `es`     | `vosotros` conjugations or pronouns                                             | 0 / 0                   | 0 / 0                  | None found.                                                                                                                                                                                                                                                        |
| `es`     | Spain-only vocabulary (`ordenador`, `fichero`, `vale`)                          | 0 / 0                   | 0 / 0                  | None found.                                                                                                                                                                                                                                                        |
| `es`     | Questions missing opening `¿` or exclamations missing opening `¡`               | 0 / 0                   | 0 / 0                  | All questions and exclamations have matching inverted punctuation.                                                                                                                                                                                                 |
| `es`     | Buttons and menu items in sentence case                                         | 0 violations            | 0 violations           | Only proper nouns (`Excalidraw`, `Finder`, `Zen`, `PNG`, `SVG`) capitalize non-initial words.                                                                                                                                                                      |
| `ja`     | `ディレクトリ` (must be `フォルダ`)                                             | 1 / 0                   | 0 / 0                  | Fixed in `workspace.error.mountNoDialog`.                                                                                                                                                                                                                          |
| `ja`     | `復元` in `recovery.*` (must be `復旧`)                                         | 3 / 0                   | 0 / 0                  | Fixed in `recovery.restore`, `recovery.notice.one`, and `recovery.notice.other`.                                                                                                                                                                                   |
| `ja`     | `復旧` in `history.*` (must be `復元`)                                          | 0 / 0                   | 0 / 0                  | None found.                                                                                                                                                                                                                                                        |
| `ja`     | `書き出` (must be `エクスポート`)                                               | 0 / 3                   | 0 / 3                  | 0 in app copy; 3 in SDK `ja-JP` recorded as `pending SDK patch`.                                                                                                                                                                                                   |
| `ja`     | Drawing translated as `図面` / `描画` / `ドキュメント` (or `文書`)              | 3 / 1                   | 0 / 1                  | Fixed `welcome.sessionNote`, `history.panel.guard.documentChanged`, and `history.preview.renderFailed` in app copy; `mermaid.description` in SDK `ja-JP` recorded as `pending SDK patch` (and `element.freedraw` pending change to match upstream toolbar `描画`). |
| `ja`     | Smart quotes `“…”` instead of `「…」` for user content                          | 0 / 0                   | 0 / 0                  | All quoted names use `「…」`.                                                                                                                                                                                                                                      |
| `ja`     | Half-width parentheses `()` in application copy                                 | 0 / 1                   | 0 / 1                  | 0 in app copy (all use full-width `（）`). In SDK `ja-JP`, `toast.copyToClipboardAsSvg` uses `\n({{exportColorScheme}})` to match upstream `toast.copyToClipboardAsPng` per glossary ruling 5.                                                                     |
| `ja`     | Explanatory text in `です・ます` style                                          | 0 violations            | 0 violations           | All body, error, and confirmation sentences use `です・ます`.                                                                                                                                                                                                      |
| `ja`     | Half-width space between Japanese and Latin letters, numbers, or placeholders   | 0 violations            | 0 violations           | Consistent spacing across all app and SDK strings.                                                                                                                                                                                                                 |

Must-fix items:

| Key / Path                                                        | Original value                                                                                                                                                                                                            | New / Recommended value                                                                                                                                                                                                             | Issue category                                                                                                            | Status            | Found in |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------- |
| `error.QUIT_CHECKPOINT_FAILED` (`es`)                             | `"No se pudo guardar un dibujo de esta ventana, así que Excalidraw no salió."`                                                                                                                                            | `"No se pudo guardar un dibujo de esta ventana, por lo que Excalidraw no se cerró."`                                                                                                                                                | Tone / phrasing (natural sentence on quit failure, glossary ruling 4)                                                     | fixed             | Round 1  |
| `shell.quit.cancelled` (`es`)                                     | `"Excalidraw no salió. {reason}"`                                                                                                                                                                                         | `"Excalidraw no se cerró. {reason}"`                                                                                                                                                                                                | Tone / phrasing (quit failure wording, glossary ruling 4)                                                                 | fixed             | Round 1  |
| `shell.history.clearSaved` (`es`)                                 | `"Se guardó una versión anterior a la acción y se vació el lienzo."`                                                                                                                                                      | `"Se guardó una versión anterior a la acción y se borró el lienzo."`                                                                                                                                                                | Terminology (clear canvas verb, glossary ruling 1)                                                                        | fixed             | Round 1  |
| `shell.history.beforeClear` (`es`)                                | `"Antes de vaciar"`                                                                                                                                                                                                       | `"Antes de borrar"`                                                                                                                                                                                                                 | Terminology (clear canvas action, glossary ruling 1)                                                                      | fixed             | Round 1  |
| `history.source.beforeClear` (`es`)                               | `"Antes de vaciar"`                                                                                                                                                                                                       | `"Antes de borrar"`                                                                                                                                                                                                                 | Terminology (clear canvas action, glossary ruling 1)                                                                      | fixed             | Round 1  |
| `workspace.error.mountNoDialog` (`es`)                            | `"Elija un directorio en el diálogo de archivos del sistema para abrir un espacio de trabajo."`                                                                                                                           | `"Elija una carpeta en el diálogo de archivos del sistema para abrir un espacio de trabajo."`                                                                                                                                       | Terminology (`carpeta` instead of `directorio`, glossary ruling 7)                                                        | fixed             | Round 2  |
| `workspace.error.mountNoDialog` (`ja`)                            | `"ワークスペースを開くには、システムのファイルダイアログでディレクトリを選んでください。"`                                                                                                                                | `"ワークスペースを開くには、システムのファイルダイアログでフォルダを選んでください。"`                                                                                                                                              | Terminology (`フォルダ` instead of `ディレクトリ`, glossary ruling 7)                                                     | fixed             | Round 2  |
| `recovery.restore` (`es`)                                         | `"Restaurar {name}"`                                                                                                                                                                                                      | `"Recuperar {name}"`                                                                                                                                                                                                                | Terminology (`recuperar` for crash recovery, glossary ruling 6)                                                           | fixed             | Round 2  |
| `recovery.notice.one` (`es`)                                      | `"Recuperado · {count} dibujo restaurado"`                                                                                                                                                                                | `"Recuperado · {count} dibujo recuperado"`                                                                                                                                                                                          | Terminology (`recuperado` for crash recovery, glossary ruling 6)                                                          | fixed             | Round 2  |
| `recovery.notice.other` (`es`)                                    | `"Recuperado · {count} dibujos restaurados"`                                                                                                                                                                              | `"Recuperado · {count} dibujos recuperados"`                                                                                                                                                                                        | Terminology (`recuperados` for crash recovery, glossary ruling 6)                                                         | fixed             | Round 2  |
| `recovery.restore` (`ja`)                                         | `"{name} を復元"`                                                                                                                                                                                                         | `"{name} を復旧する"`                                                                                                                                                                                                               | Terminology (`復旧する` for crash recovery, glossary ruling 6)                                                            | fixed             | Round 2  |
| `recovery.notice.one` (`ja`)                                      | `"復旧しました · 図 {count} 個を復元しました"`                                                                                                                                                                            | `"復旧しました · 図 {count} 個を復旧しました"`                                                                                                                                                                                      | Terminology (`復旧` for crash recovery, glossary ruling 6)                                                                | fixed             | Round 2  |
| `recovery.notice.other` (`ja`)                                    | `"復旧しました · 図 {count} 個を復元しました"`                                                                                                                                                                            | `"復旧しました · 図 {count} 個を復旧しました"`                                                                                                                                                                                      | Terminology (`復旧` for crash recovery, glossary ruling 6)                                                                | fixed             | Round 2  |
| `history.panel.guard.documentChanged` (`es`)                      | `"El documento del historial cambió. Vuelva a abrir el menú de la versión antes de actuar."`                                                                                                                              | `"El dibujo del historial cambió. Vuelva a abrir el menú de la versión antes de actuar."`                                                                                                                                           | Terminology / accuracy (`dibujo` instead of `documento`, and natural phrasing for the drawing under version history)      | fixed             | Round 2  |
| `history.panel.guard.documentChanged` (`ja`)                      | `"履歴の文書が変更されました。操作する前に、バージョンのメニューを開き直してください。"`                                                                                                                                  | `"履歴の対象の図が変更されました。操作する前に、バージョンのメニューを開き直してください。"`                                                                                                                                        | Terminology / accuracy (`履歴の対象の図` instead of `履歴の文書`)                                                         | fixed             | Round 2  |
| `history.panel.retention.body` (`ja`)                             | `"自動バージョンと操作前バージョンは、新しい 20 件を共有します。経過時間では期限切れになりません。手動マークは、削除するまで残ります。"`                                                                                  | `"自動バージョンと操作前バージョンは、合わせて最新 20 件まで保持され、時間の経過では消えません。手動マークは、削除するまで残ります。"`                                                                                              | Accuracy / naturalness (avoid literal translation of "share the newest 20 entries" and "expire by age")                   | fixed             | Round 2  |
| `history.preview.renderFailed` (`ja`)                             | `"このバージョンを安全に描画できませんでした。"`                                                                                                                                                                          | `"このバージョンを安全に表示できませんでした。"`                                                                                                                                                                                    | Terminology (avoid `描画` in application copy; use `表示`)                                                                | fixed             | Round 2  |
| `conflict.saveAsNew` (`es`)                                       | `"Guardar los cambios locales como nuevo…"`                                                                                                                                                                               | `"Guardar los cambios locales como un dibujo nuevo…"`                                                                                                                                                                               | Grammar / accuracy (supply missing noun after `como` to match `conflict.saveDialog.title`)                                | fixed             | Round 2  |
| `recovery.saveAsNew` (`es`)                                       | `"Guardar {name} como nuevo"`                                                                                                                                                                                             | `"Guardar {name} como un dibujo nuevo"`                                                                                                                                                                                             | Grammar / accuracy (supply missing noun after `como`, gender-safe regardless of `{name}`)                                 | fixed             | Round 2  |
| `conflict.saveAsNew` (`ja`)                                       | `"ローカルの変更を新規として保存…"`                                                                                                                                                                                       | `"ローカルの変更を新しい図として保存…"`                                                                                                                                                                                             | Naturalness / consistency (supply object `新しい図` to match `conflict.saveDialog.title`)                                 | fixed             | Round 2  |
| `recovery.saveAsNew` (`ja`)                                       | `"{name} を新規として保存"`                                                                                                                                                                                               | `"{name} を新しい図として保存"`                                                                                                                                                                                                     | Naturalness / consistency (supply object `新しい図` to match `recovery.error.chooseDestination`)                          | fixed             | Round 2  |
| `labels.clearCanvas` (SDK `es-ES`)                                | `"Vaciar el lienzo"`                                                                                                                                                                                                      | `"Borrar lienzo"`                                                                                                                                                                                                                   | Terminology (align with upstream dialog title `Borrar lienzo`, glossary ruling 1)                                         | fixed             | Round 1  |
| `element.freedraw` (SDK `ja-JP`)                                  | `"フリーハンド"`                                                                                                                                                                                                          | `"描画"`                                                                                                                                                                                                                            | Terminology (align with upstream toolbar `toolBar.freedraw` `"描画"`, glossary ruling 2)                                  | fixed             | Round 1  |
| `labels.textToDiagram` (SDK `ja-JP`)                              | `"テキストから図へ"`                                                                                                                                                                                                      | `"テキストからダイアグラム"`                                                                                                                                                                                                        | Terminology (avoid collision with file drawing `"図"`, match upstream welcome screen `"ダイアグラム"`, glossary ruling 3) | fixed             | Round 1  |
| `imageExportDialog.tooltip.embedScene` (SDK `ja-JP`)              | `"シーンのデータは、書き出した PNG/SVG ファイルに保存され、あとからシーンを復元できます。\n書き出したファイルのサイズは大きくなります。"`                                                                                 | `"シーンのデータは、エクスポートした PNG/SVG ファイルに保存され、あとからシーンを復元できます。\nエクスポートしたファイルのサイズは大きくなります。"`                                                                               | Terminology (use `エクスポート` instead of `書き出す`)                                                                    | fixed             | Round 1  |
| `overwriteConfirm.action.exportToImage.description` (SDK `ja-JP`) | `"シーンのデータを、あとから読み込める画像として書き出します。"`                                                                                                                                                          | `"シーンのデータを、あとから読み込める画像としてエクスポートします。"`                                                                                                                                                              | Terminology (use `エクスポート` instead of `書き出す`)                                                                    | fixed             | Round 1  |
| `overwriteConfirm.action.saveToDisk.description` (SDK `ja-JP`)    | `"シーンのデータを、あとから読み込めるファイルに書き出します。"`                                                                                                                                                          | `"シーンのデータを、あとから読み込めるファイルにエクスポートします。"`                                                                                                                                                              | Terminology (use `エクスポート` instead of `書き出す`)                                                                    | fixed             | Round 1  |
| `mermaid.description` (SDK `ja-JP`)                               | `"現在対応しているのは <flowchartLink>フローチャート</flowchartLink>、<sequenceLink> シーケンス、 </sequenceLink> および <classLink>クラス </classLink>図のみです。その他の種類は Excalidraw で画像として描画されます。"` | `"現在対応しているのは <flowchartLink>フローチャート</flowchartLink>、<sequenceLink> シーケンス、 </sequenceLink> および <classLink>クラス </classLink>ダイアグラムのみです。その他の種類は Excalidraw で画像として表示されます。"` | Terminology (use `ダイアグラム` for diagrams per glossary ruling 3 and avoid `描画` for rendering)                        | fixed             | Round 2  |

Should-fix items (all applied to application copy in Round 2) and terminology suggestions:

- `error.unknown` (`es`, fixed in Round 2): Changed `"Se produjo un error (error {code})."` to `"Se produjo un error (código {code})."` to eliminate the awkward repetition of `error` while preserving `{code}`.
- `tabs.closeOthers` and `tabs.closeAll` (`ja` and `es`, fixed in Round 2): Changed `ja` `"ほかを閉じる"` / `"すべて閉じる"` to `"ほかのタブを閉じる"` / `"すべてのタブを閉じる"`, and `es` `"Cerrar las demás"` / `"Cerrar todas"` to `"Cerrar las demás pestañas"` / `"Cerrar todas las pestañas"`, matching the explicit object in `tabs.closeToRight` and the Simplified Chinese catalog.
- `welcome.sessionNote` (`es` and `ja`, fixed in Round 2): Changed `es` to `"No hay una sesión recuperable · “Bienvenida” es un estado del documento, no una pestaña permanente adicional."` and `ja` to `"復旧できるセッションはありません · 「ようこそ」は画面の状態であり、常設の追加タブではありません。"`, quoting the Welcome screen name (as in Simplified Chinese) and replacing `文書` in Japanese.
- Terminology suggestion 1 (`menu.native.window.zoom` in `ja`, glossary section 3): The glossary currently specifies `拡大/縮小` (matching older macOS Japanese Window menus), and the catalog follows the glossary (`"拡大/縮小"`). On modern macOS (Ventura through Sequoia / macOS 26), Apple's Japanese Window menu uses `ズーム`. No change was made to `ja.ts`; if the product owner prefers matching modern macOS, update glossary section 3 first.
- Terminology suggestion 2 (colon spacing in `ja`): Two strings (`recovery.error.startupCheck`: `"リカバリスナップショットを確認できませんでした： {reason}"` and `history.panel.restoreDialog.target`: `"対象： {version} · {summary}"`) place a half-width space after a full-width colon `：` before `{reason}` / `{version}` because of the general rule to insert a half-width space before placeholders. Since full-width `：` already includes visual width, the glossary could clarify that no extra half-width space is needed immediately after full-width punctuation (`：`, `「`, `（`).

Product-manager verification (2026-10-17):

- The catalogs define 399 message keys; the reviewer's figure of 198 counts
  only part of them. Completeness, placeholder, and length checks run over
  all 399 keys in every language.
- A terminology scan over every Spanish and Japanese string (folder,
  recovery versus version restore, export, drawing, quotation marks,
  half-width parentheses, `¿`) found 8 violations before round 2 and 0 after.
- A manual read of 33 conflict, recovery, delete, Workspace removal, and
  version restore strings in both languages found no meaning or terminology
  errors. Three phrasing items remain open as should-fix: the redundant
  recovery notice in both languages, the Japanese label for keeping the disk
  version, and the extra space after a full-width colon in two Japanese
  strings.
- The suggestion to rename the Japanese Window menu Zoom item was not
  adopted: it could not be confirmed against the current macOS menu, and the
  native menu check compares against the catalog either way.

## Review follow-up

The follow-up round applied the seven SDK must-fix strings in both dev and prod builds, the
three code-review items above, and glossary rulings 8, 10, and 11. Extending
the 1280×760 layout check then showed that `history.panel.count` overflowed
at the 300px drawer in Spanish and Japanese; English and Simplified Chinese
fit.

Product owner decision on the history count:

- The panel layout stays unchanged. A layout change would affect the whole
  panel component and need broad regression testing, while only this one
  label overflows.
- The label is shortened instead. The panel already says that these are the
  versions shown, so dropping "shown" keeps the meaning. Spanish:
  `{count} versión` / `{count} versiones` (for example `6 versiones`).
  Japanese: `{count} バージョン` for both forms (for example `6 バージョン`),
  a common, unambiguous form in business software.
- If copy overflows the panel again and product or translation review does
  not accept dropping the verb, the fallback is `overflow: hidden` with a
  tooltip that shows the full text on hover.

| Command                                                            | Result                    |
| ------------------------------------------------------------------ | ------------------------- |
| `pnpm typecheck`                                                   | PASS                      |
| `pnpm lint`                                                        | PASS                      |
| `pnpm format`                                                      | PASS                      |
| `CI=true pnpm test`                                                | PASS, 86 files / 760 tests |
| `pnpm build`                                                       | PASS                      |
| `APP_E2E=1 pnpm e2e e2e/tests/preferences-i18n-*.spec.ts`          | PASS, 47 tests            |

Chromium was taken from the installed Playwright cache
(`PLAYWRIGHT_BROWSERS_PATH`) because the shell's default cache path was
empty. `pnpm native:menu:check` was not run.

### Maintainer check of the follow-up

A second read-only cross-layer review of `origin/main` to `7933930` was run
on 2026-10-17 (Claude Sonnet 5, full-stack reviewer profile; it wrote no
files). It found no must-fix items. The five values, their order in the
native and canvas menus, the Rust boundary, and the 41 label ids agree, and no
production panic path was added. The installed SDK strings were read back from
both the dev and prod builds; the seven corrected strings are present and
upstream translations are unchanged.

| Finding                                                                                                                                                                            | Severity   | Handling                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Spanish residue check allowed every word found in the Spanish catalog, including placeholder names such as `{drawing}`, so an untranslated `Excalidraw drawing` would pass | should-fix | Fixed in `a5c1827`: placeholders are removed first, whole words are matched with accents, a word is allowed only when the Spanish catalog has it and the English catalog does not, and `e2e/helpers/englishResidue.test.ts` proves the untranslated case fails |
| The glossary exception list is empty, so its consistency test loops over nothing                                                                                                  | note       | Kept: it starts checking once an exception is added                                                                                                                                                                                                       |
| The Japanese quotation and parenthesis rules and the Spanish question-mark rule are narrow                                                                                         | note       | Kept: they guard the observed mistakes, not every variant                                                                                                                                                                                                 |
| `CanvasMainMenu.tsx` lists the language options both in an array and in JSX                                                                                                       | note       | Kept: both lists are updated; a future drift risk only                                                                                                                                                                                                    |

Gates after `a5c1827`, rerun by the maintainer:

| Command                                                      | Result                                     |
| ------------------------------------------------------------ | ------------------------------------------ |
| `pnpm typecheck`, `pnpm lint`                                | PASS                                       |
| `CI=true pnpm vitest run e2e/helpers/englishResidue.test.ts` | PASS, 3 tests                              |
| `APP_E2E=1 pnpm e2e e2e/tests/preferences-i18n-*.spec.ts`    | PASS, 47 tests (default browser cache)     |

One run of the same suite had a single failure in
`e2e/tests/preferences-i18n-tab-state.spec.ts`, an English-only file this
change does not touch. The file passed 32 of 32 when run alone with
`--repeat-each=8`, and `origin/main` (`7c5416b`) under the same load
(`--repeat-each=4`) also failed once in that file. It is an existing timing
flake under parallel load, not a regression from this change.

## Native menu

Run on 2026-10-17 on macOS 26.6.2 (physical Mac) with
`pnpm native:menu:check`, against the debug binary from
`pnpm tauri build --debug --no-bundle` at `f56dbf6` (SHA-256
`61733740d3eacab17713b11d51c10910cef34cb89425a12e0fa6f62cc343a8ca`). Each run
launches the app twice (without and with a document), reads the menu tree,
labels, enabled and checked state through System Events, then drives every
managed item and Command-S and confirms each is routed exactly once.

| `--languages`        | Resolved | Result         |
| -------------------- | -------- | -------------- |
| `(es-MX, en-US)`     | `es`     | PASS, 105 checks |
| `(ja-JP)`            | `ja`     | PASS, 105 checks |
| `(en-US, zh-Hans)`   | `en`     | PASS, 105 checks |

- All three runs started from the Follow System preference, so the label
  checks ran in the resolved language: for example `App > Idioma > Según el
  sistema`, `App > 言語 > システムに合わせる`, and `ウインドウ > 拡大/縮小`.
- Each run routed all five language items (`system`, `en`, `zh-CN`, `es`,
  `ja`) once, then restored the starting preference.
- `src-tauri/Info.plist` lists `CFBundleLocalizations` `en`, `zh-Hans`, `es`,
  `ja`. The `.app` bundle itself is checked during the visual spot-check.

Isolation gap found: the script points `HOME` at a temporary directory, but
the language preference lives in WebKit storage, which is keyed by bundle id
(`~/Library/WebKit/excalidraw-desktop`) and shared with any installed copy of
the app. A first `(es-MX, en-US)` run started from a stored Simplified Chinese
preference, so it resolved to `zh-CN` and checked Chinese labels while still
reporting PASS. That run is not counted. The preference was set to Follow
System in the installed app before the three runs above. A later change
should make the script fail or warn when the starting preference is not
Follow System, because `--languages` then has no effect.

## Visual spot-check

Not run yet.
