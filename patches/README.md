# Dependency patches

## `@excalidraw/excalidraw@0.18.1`

One patch file carries two independent changes.

### Complete the zh-CN catalog

- **Why**: the SDK's zh-CN catalog lacks 91 of the 513 English keys (canvas search, command palette, help dialog, stats, font list, and others). Those strings fell back to English inside an otherwise Simplified Chinese UI. The SDK has no public API for supplying translations.
- **What**: `dist/dev/locales/zh-CN-*.js` and `dist/prod/locales/zh-CN-*.js` gain only the missing strings. Existing upstream translations are never overwritten. Sections the file lacked entirely are added as named exports, because the SDK reads the module namespace rather than its default export.
- **Guard**: `src/i18n/sdkLocaleCoverage.test.ts` loads both builds and fails if any English key has no zh-CN value. An SDK upgrade that renames the locale files or adds keys fails it, and the patch must be regenerated.
- **Upstream**: the strings are to be contributed through the Excalidraw translation project (Crowdin). Not yet submitted.
- **Removal**: drop this patch once the locked SDK version ships a zh-CN catalog that passes the guard test without it.

### Name the canvas menu trigger

- **Why**: the SDK's hamburger button that opens the canvas main menu has no accessible name, so VoiceOver announces only "button" and tests cannot find it by role and name.
- **What**: `dist/dev/index.js` and `dist/prod/index.js` add `aria-label` to that button, using the SDK's own `buttons.menu` string ("Menu" / "菜单"). Nothing else changes.
- **Guard**: `src/editor/sdkMenuTriggerPatch.test.ts` fails if either build no longer contains the patched line.
- **Upstream**: to be proposed as a small accessibility fix to the Excalidraw repository. Not yet submitted.
- **Removal**: drop this hunk once the locked SDK version names the trigger itself.
