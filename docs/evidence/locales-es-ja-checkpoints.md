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

Not run yet.

## Translation review

Not run yet. Record the model used for the first translation and the model
used for the review, the verdict per area, every must-fix item, and how each
was resolved.

## Native menu

Not run yet.

## Visual spot-check

Not run yet.
