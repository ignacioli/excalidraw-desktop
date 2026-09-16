# 验证证据汇总（Phase 10 / T095；002 T066 指令）

**日期**：2026-08-10（文首一览与 §5 成绩单更新于 2026-08-17；§6/§7 原生发版与 T078/T080/T094 更新于 2026-08-18；002 修改前基线更新于 2026-08-19；002 Polish 验证指令 T066 更新于 2026-08-23；T067 前端/Rust 门禁更新于 2026-08-23；T068 浏览器 E2E 与 T069 二进制证明更新于 2026-08-23；T071 物理机 10k 树与 T072 可观测性更新于 2026-08-23；T070 原生矩阵更新于 2026-08-24；T073–T075 参考 VM 与 quickstart 收口更新于 2026-08-24）
**范围**：Phase 10 全量回归执行结果与三类验证证据（Playwright 浏览器 UI、`APP_E2E=1` Tauri 进程级可靠性、macOS 原生 OS 环境验收）的汇总，并包含 feature 002 的修改前诊断基线、Polish 门禁指令与 T067/T068/T069 成绩；2026-08-12 已按宪法 v3.0.0 同步 macOS 必选、Ubuntu 24.04 可选、性能参考测量与未签名开源分发政策。T066 只更新指令与证据边界，不重分类下列 001 历史数字。T070 见 [native-verification.md](./native-verification.md) §9（2026-08-23/24 已执行）；T071/T072 见 §0.6/§0.7；T073 见 §0.8；T074 见 §0.9；T075 见 §0.10。

先看下表再下钻各节。下表是 **001 Phase 10 / T095 历史成绩单一览**，不因 002 改写。性能当前有效序列是 2026-08-16 ADR-007（同一份 e2e-harness `e8bef9b7…`）；§5.3 的日期流水账不可与之混比。002 剩余门禁顺序与执行边界见 §0.1。

| 门禁 | 状态 | 说明 |
|------|------|------|
| 浏览器回归（T095，§1） | **36 pass** · 2 已知 fail · 12 skip | 两例失败为断言/定位符脆性，先于本阶段；skip 依赖原生测试二进制。此为 001 历史计数，不是 T068 |
| SC-012 可靠性（§2） | 前序 **pass**，本会话未复跑 | 合并阻断门禁；未在本会话重建 `e2e-harness` 复跑 |
| SC-014 外观（§3） | **pass**（4/4） | light/dark/system 与截图基线 |
| SC-015 无障碍（§4） | **pass**（15/15） | T093 历史：axe serious/critical = 0。002 跨故事审计结果以 [a11y-audit.md](./a11y-audit.md)（T063）为准，本文件不改写 |
| T090 startup/idle（§5.2） | 物理机 **pass** · 参考 VM **fail** | VM 只败在冷启动 3704 ms；8 vCPU 诊断仍 fail（§5.2），未改 specs；空载 RSS 两边过 500 MB。001 历史；002 不得复用为 T073 |
| T090 canvas/I/O（§5.2） | 物理机 **pass** · 参考 VM **pass** | 10k 恒定 zoom 平移/编辑约 60 fps。001 历史；002 不得复用为 T073 |
| T108 15 min soak（§5.2） | 物理机 **fail** · 参考 VM **fail** | 只败在 RSS 增长；idle CPU 与静置 0 写入两边过。001 历史；002 不得复用为 T074 |
| SC-010 开源分发（§6） | **v0.1.1 已发布** | 未签名/未公证 GitHub Release；macOS universal `.dmg` + Linux amd64 AppImage/deb/rpm |
| T078/T080 原生验收（§7） | **通过**（2026-08-18） | 001 历史：物理 macOS 26.5.2 下载真实 `v0.1.1`；T094 Ubuntu IME 可选已做。002 US1–US4 矩阵见 [native-verification.md](./native-verification.md) §9：2026-08-23/24 **已执行**（T070） |
| 002 Polish 门禁（§0.1） | T063–T075 已执行 | T067 见 §0.2，T068 见 §0.3，T069 见 §0.4，T070 见 §0.5，T071 见 §0.6，T072 见 §0.7，T073 见 §0.8，T074 见 §0.9，T075 见 §0.10。不得用 §5.2 的 001 T090/T108 代替 |

## Feature 003 final acceptance（进行中，2026-09-14）

### T059 final risk-proportional automated suite

本轮以产品 runtime commit `9bc3fd9b592f8d45cee5b1878474650ff2c8e40b` 为基础执行；为匹配该 runtime 已完成的 003 shell contract，只修改 browser E2E harness、语义定位和两个遗留 appearance 快照，不改生产 runtime。Codex managed macOS 下，Vite 在 sandbox 外以 `pnpm dev --host 127.0.0.1` 监听 `http://127.0.0.1:1420/`，Playwright 设置 `PLAYWRIGHT_SKIP_WEBSERVER=1` 与 `PLAYWRIGHT_BASE_URL=http://127.0.0.1:1420`。首次使用错误的 package-script 参数形式导致多跑非目标集合，以及 sandbox 内 Chromium Mach-port 权限失败，均不计入产品 verdict；下表只记录最终精确命令。

| 命令 | 结果 |
|------|------|
| `pnpm lint` | **pass**（exit 0） |
| `pnpm typecheck` | **pass**（exit 0） |
| `pnpm test` | **pass**（37 files / 295 tests） |
| `pnpm build` | **pass**（exit 0；仅保留既有 large-chunk warning） |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | **pass**（exit 0） |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | **pass**（exit 0） |
| `cargo test --manifest-path src-tauri/Cargo.toml` | **pass**（96 tests：lib 70、contract 23、untrusted-scene 3） |
| `APP_E2E=1 PLAYWRIGHT_SKIP_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://127.0.0.1:1420 pnpm exec playwright test --config e2e/playwright.config.ts e2e/tests/ui-desktop-shell-routing.spec.ts e2e/tests/ui-desktop-shell-visual.spec.ts e2e/tests/ui-sidebar-modes.spec.ts e2e/tests/ui-entry-dialogs.spec.ts e2e/tests/a11y-audit.spec.ts e2e/tests/us1-appearance.spec.ts e2e/tests/us5-export-fidelity.spec.ts --reporter=line` | **pass**（55/55，26.7s） |

本轮 focused Playwright 继续覆盖六个 HF-2 语义状态、legacy chrome absence、a11y/focus/reduced-motion、固定 geometry/tokens/font readiness/fallback、native menu event delegation，以及 deterministic PNG/SVG output。遗留 `us1-appearance` Light/Dark 快照已从含旧 Save/Export/Appearance 顶栏和 harness error 的 002 shell 更新为当前 003 shell；更新后逐张检查，无明显裁切、遮挡或主题错误。该浏览器检查不替代 T060 package identity、T067 native smoke 或 T068 product-owner visual sweep。

未重跑、未改写的 checkpoint evidence 按原 product commit/path 复用：

- VSL-001 / HF2-03: `docs/evidence/003-visual-acceptance/5743de8d5a2c611274debb9ce44ccc5115a73955/VSL-001/`
- HF2-01: `docs/evidence/003-visual-acceptance/6c78bebc4a922cbaf40bc6c60cf6b0be0e93b8df/HF2-01/`
- HF2-02: `docs/evidence/003-visual-acceptance/6e308c0859341a1ffcf19e5dabe35b7ad28cafe5/HF2-02/`
- HF2-04: `docs/evidence/003-visual-acceptance/a00d82b1f939299687128e697e4aef91cfc98466/HF2-04/`
- HF2-05: `docs/evidence/003-visual-acceptance/63417a0db7650bbdf6f323d98110f2685c10a17b/HF2-05/`
- HF2-06: `docs/evidence/003-visual-acceptance/06a4e34152fb8cdcdae7a6fd20ac137565ab651d/HF2-06/`

T067、T068 与最终 T069 owner decision 尚未执行，当前不得表述为通过或批准。

### T060 production package record

紧接 T059 checkpoint 后，`git status --short` 输出为空，`git rev-parse HEAD` 为 `f8125d00ab0e181e2aabf6de2a486ac0eb7b3653`。第一次在 restricted sandbox 中执行 `pnpm tauri build` 时，release compile 与 `Excalidraw.app` bundling 已完成，但 `bundle_dmg.sh` 无法使用所需 macOS 系统服务而 exit 1；该次不计 PASS。随后在获准的 sandbox 外以同一精确命令重跑，明确输出 `Finished 2 bundles` 并 exit 0。

| 事实 | 记录 |
|------|------|
| Build command / verdict | `pnpm tauri build` / **pass**（sandbox 外重跑，exit 0） |
| Clean product commit | `f8125d00ab0e181e2aabf6de2a486ac0eb7b3653` |
| Production `.app` | `/Users/liyongqiang/gitrepo/ignacioli/excalidraw-desktop/.worktrees/feat-003-desktop-shell-ux-ui/src-tauri/target/release/bundle/macos/Excalidraw.app` |
| Bundle identifier | `excalidraw-desktop` |
| Bundle short version / version | `0.2.0` / `0.2.0` |
| macOS | `26.6.2`（build `25G83`） |
| Main display | 1352×878 logical points；backing scale `2`；visible frame 1352×848 |
| Exact package window | Accessibility 记录 position `{4,61}`、size `1280×760` |

T067 与 T068 必须继续使用上表同一路径的 `.app`。该 package 当前启动到主 profile 的已有 recovery dialog；本记录没有读取其内容之外的数据，也没有 restore、discard、覆盖或清理任何 recovery candidate。T067/T068 与 T069 owner decision 仍为 PENDING。

### 2026-09-15 product-owner acceptance findings（FAIL，待修复/定界）

T060 后发现并修复 Recovery `Save … as new` 的 watcher self-write conflict，产品 runtime 前进到 clean commit `cab26bd4aacd098c187ceb196dd6bead24948b36`。修复后的 production `.app` 以 `pnpm tauri build --bundles app` 构建成功并安装到 `/Applications/Excalidraw.app`；安装副本与 worktree bundle 的可执行文件 SHA-256 均为 `f95ce5f18b28a773d2766de17e1a5ce08e4ab81d8ee481531806eb669d3ddd35`，bundle ID `excalidraw-desktop`，version `0.2.0`。原 `f8125d0` package 不再用于 T067/T068 的最终结果。

产品负责人在上述 `cab26bd` package 上继续人工验收，报告 T067/T068 检查中除下列问题外未观察到其他非预期视觉问题；下列结果不得被 Agent 改写为 PASS：

1. **SVG real export — FAIL**：Export Dialog 支持并可选择 `SVG image`，但实际导出显示 `The SVG export did not embed the drawing fonts. The export was not written.`，目标文件未写出。T067 的 task-scoped dialog-open/cancel 行为与真实 SVG filesystem outcome 是不同事实；即使前者满足，当前真实导出失败仍是 final acceptance 的 blocking product finding。
2. **Remove Workspace with open tabs — FAIL / scope pending**：当 Workspace 仍有已打开 Tabs 时先执行 Remove Workspace，现有 Tabs 随后显示 `Path is outside the mounted workspaces.`。这可能属于既有 workspace/tab lifecycle 边界而非 003 新视觉范围，但它是在 003 exact-package owner session 中发现的可达产品缺陷；在定界或修复前保留为阻断项。
3. **First-tab alignment — visual finding / owner decision pending**：Pinned Workspace 状态下，Sidebar controls 与第一个 Tab 之间的水平留白被产品负责人判断过大；建议第一个 Tab 至少与 Sidebar minimum-width boundary 对齐。该事实直接涉及 003 Tabs/shell composition，不能仅以旧 automated geometry PASS 覆盖；是否作为 003 blocking mismatch 需由 owner 明确决定或经设计合同变更/修复后复验。

三个 finding 已按产品负责人授权完成最小 remediation，但本记录仍保留原始 FAIL，不以 automated result 替代 owner 复验：SVG 检查改为以 serialized SVG 中实际存在的 `<text>` 为准，避免 deleted/未渲染 text 误触发缺字体校验；Remove Workspace 在卸载 root 前先保存并关闭该 root 下的 tabs；Pinned Sidebar 的首个 tab inset 收紧为 8 px。针对三项路径的 browser E2E 为 `3 passed`，frontend lint、strict typecheck、299 项 Vitest 与 production build 均通过。

产品负责人随后在安装的 `de9b44f` production `.app` 上复验上述三个 finding，并明确记录 SVG real export、Remove Workspace with open tabs 与 first-tab alignment **3/3 PASS**。该结果关闭这三个 remediation finding，但不自动完成 T067/T068 的其余 checklist，也不构成 T069 owner decision。

同一轮继续验收时发现新的 blocking finding：Remove 最后一个 Workspace 后，Welcome 的 `Recent Workspaces` 仍显示已被 Rust/SQLite 删除的旧记录；点击该 row 会以旧 workspace id 调用 `workspace_entry_list` 并显示 `Workspace was not found.`。根因是 `WorkspacePanel` 只更新自己的 mounted-workspace state，没有同步 `AppShell` 的 Welcome/Recent projection。产品 commit `5eb244d` 增加 mount/remove 完整列表同步，并用“启动时已有 Workspace → 打开 drawings → Remove → Welcome 不存在旧 Recent row”的 semantic E2E 精确覆盖；修复前该断言收到 1 行而 FAIL，修复后 1/1 PASS。Focused AppShell/WorkspacePanel Vitest 44/44、frontend lint、strict typecheck、全量 Vitest 38 files / 299 tests 与 production build 均 PASS。该 finding 仍等待新 production `.app` 上的产品负责人复验。

当前没有最终 `APPROVED|REJECTED`。T067/T068 不勾选，T069 保持 **BLOCKED/PENDING**；下一步必须重新构建并安装包含 `5eb244d` 的 clean production `.app`，由产品负责人复验 Recent Workspaces 后继续剩余 final checklist。

### 003 T060b–T060d Recent Workspace lifecycle forward-fix（2026-09-15）

产品负责人否决了 `5eb244d`/`7acb5c4` 的“Remove 后直接从 Recent 消失”语义，并 Review 通过 T060b written delta。替代行为在 clean product commit `4541629e90e0e769ee1b46db2889bea738335327` 实现：Remove Workspace 安全保存/关闭其文档后只解除挂载并保留 Recent；可访问 Recent remount 同一 record；不可访问路径不在启动时主动报错，只在激活时报告且保留 row；仅未挂载 row 暴露 Remove from Recents，并且只删除应用历史、绝不删除用户文件。Private-specs approval/task record commit 为 `6f956f2`。

自动化结果：

- `pnpm test -- src/app/WelcomeScreen.test.tsx src/app/AppShell.test.tsx src/ipc/contracts.test.ts`：因 package script 的参数转发规则实际执行全量 Vitest，38 files / 302 tests PASS。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`：PASS；production build 仅保留既有 Vite chunk-size warning。
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`、`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`、`cargo test --manifest-path src-tauri/Cargo.toml`：PASS；74 unit tests 与 10/9/3/3/3 integration suites 全部通过。
- `APP_E2E=1 PLAYWRIGHT_SKIP_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://127.0.0.1:1420 pnpm exec playwright test --config e2e/playwright.config.ts e2e/tests/us3-workspace-files.spec.ts --reporter=line --workers=1 --timeout=30000`：3/3 PASS，覆盖同 session 与 clean reload Recent retention、same-id remount、inaccessible activation/no-startup-alert、mounted rejection 与 unmounted history-only removal。关闭 browser preflight server 时出现 harness 未模拟 `transformCallback` 的 Tauri event-listener 日志；该日志不来自 production package，也未改变上述 Playwright verdict。

Package/session record：build 前 `git status --short` 为空，HEAD 为 `4541629e90e0e769ee1b46db2889bea738335327`。首次 sandbox 内 `pnpm tauri build` 已完成 release binary 与 `.app`，但在 DMG `bundle_dmg.sh` 退出 1，因此如实记为一次环境受限 FAIL；相同命令在 sandbox 外重跑 exit 0，生成 `/Users/liyongqiang/gitrepo/ignacioli/excalidraw-desktop/.worktrees/feat-003-desktop-shell-ux-ui/src-tauri/target/release/bundle/macos/Excalidraw.app` 与 `Excalidraw_0.2.0_aarch64.dmg`。该 `.app` 已安装到 `/Applications/Excalidraw.app`；安装后 bundle ID `excalidraw-desktop`、version `0.2.0`。环境为 macOS 26.6.2 (25G83)、Apple M5 Pro、3024×1964 built-in Liquid Retina XDR 主显示器。安装 package 已真实启动；初始窗口为 800×600，自动调整后只确认到 1076×760，尚未取得合同要求的 1280×760 owner-session fact。

T060d 当前为 **OWNER_RECHECK_PENDING**：产品负责人仍需在同一 `/Applications/Excalidraw.app` 上将窗口设为 1280×760，并明确复验完整 Remove Workspace → Recent retention → same-id remount、缺失目录激活报错但 row 保留、Remove from Recents 后 row 消失且磁盘内容不变。完成该 recheck 前不得勾选 T060d，也不得把 T067/T068/T069 写成 PASS。

#### Recent Workspace UX refinement（2026-09-15，owner visual recheck pending）

产品 checkpoint `366c056deff59738327c1ecc2233343d5c344b7d` 将未挂载 Recent row 的完整文字按钮替换为固定 trailing slot 内的 `×` action。该 action 默认低调，仅在 row hover、`:focus-within` 或 row unavailable 时显示；保留 `title="Remove from Recents"`、`Remove <workspace name> from Recents` accessible name、正常 Tab 顺序和 Enter 激活。mounted row 不渲染 removal action。Recent remount 失败只在对应 workspace id 的 row 显示轻微 unavailable 状态与 `Folder unavailable`，全局 `role="alert"` 继续拥有 live announcement；关闭/保存已有文档失败不会被误分类为 folder unavailable。remount 成功、对应 history removal 成功以及成功打开/选择其他 Workspace 会清除相应 row error。Rust、SQLite schema、IPC major version与磁盘语义均未修改。

自动化结果：

- `pnpm vitest run src/app/WelcomeScreen.test.tsx src/app/AppShell.test.tsx`：2 files / 41 tests **PASS**。
- `pnpm test`：38 files / 307 tests **PASS**。
- `pnpm lint`、`pnpm typecheck`、`pnpm build` 与 `git diff --check`：**PASS**；build 仅保留既有 Vite large-chunk warning。
- `APP_E2E=1 PLAYWRIGHT_SKIP_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://127.0.0.1:1420 pnpm e2e e2e/tests/us3-workspace-files.spec.ts --project=browser-ui --workers=1 --retries=0`：sandbox 内 Chromium 启动被 macOS Mach-port 权限拒绝，随后同一命令在 sandbox 外 **3/3 PASS**。语义断言覆盖 unavailable row retained、inline helper、默认/hover/focus/unavailable action visibility、Tab + Enter removal、removal 后 row 消失，以及 hover/focus 前后 row/path geometry 完全不变；没有以截图替代这些事实。
- 独立 validation/review subagent 完成三轮只读审查；最终 verdict **PASS**，无 remaining blocking findings。

package/session record：build 前 `git status --short` 为空，clean product commit 为 `366c056deff59738327c1ecc2233343d5c344b7d`。sandbox 外 `pnpm tauri build` exit 0，生成 production `.app` 与 DMG。source bundle 与 `/Applications/Excalidraw.app` 的 bundle ID 均为 `excalidraw-desktop`、version 均为 `0.2.0`，两处 executable SHA-256 均为 `0901f8aeff939dfb4867f9424d74f0af9bdb950145314b95991c578ddad78e60`。

该记录只证明实现、自动化、package identity 和安装完成。**T060d、T067、T068、T069 仍未完成**；下一步停在 product-owner visual recheck，不推断 `APPROVED|REJECTED`，也不把此前 10/10 functional PASS 扩大解释为本 refinement 的视觉验收。

## 0. Feature 002 修改前基线（T001，2026-08-19）

本节只记录 `HEAD 1346d29` 开始实现前的诊断状态，不替换、不重分类 §5.2 的正式物理机/参考 VM T090/T108 证据。浏览器 fixture 不证明原生文件系统或进程树性能；本机 startup/resource 运行未设置 `PERF_REFERENCE_RUN=1`，因此只属于 physical diagnostic。

| 基线面                    | 修改前结果                                                                                                                                                                                                                                                                       | 证据边界                                                                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10k Workspace tree        | **fail**：展开耗时 8088.5 ms（预算 ≤200 ms）；10,001 个 treeitem 全部进入 DOM（预算 <300）；`scrollHeightPx == clientHeightPx == 320032`，滚动位移 0、位置变化 0                                                                                                                 | `us3-scale-scroll.spec.ts` browser fixture；rAF 记录 118.98 fps，但由于容器不可滚动，该数值不是有效滚动 FPS；浏览器 heap 304,000,000 bytes 仅为诊断                                                            |
| Thumbnail activity        | 2/2 focused browser tests **pass**；可见 Drawing 行执行 `thumb_lookup`，miss 后执行额外 `doc_open`、worker/main-thread render 与 `thumb_store`，随后经 asset protocol 呈现；重载命中缓存且不增加 store 数                                                                        | 证明当前产品 UI 仍消费完整 thumbnail 链；不证明原生 cache I/O 性能                                                                                                                                             |
| Startup/resource snapshot | physical diagnostic **pass**：10 次冷启动 editable P95 648.879459 ms；空闲进程树 RSS P95 411,795,456 bytes；60 秒观察 0 filesystem event / 0 changed path                                                                                                                        | macOS 26.5.2、Apple M5 Pro / 48 GiB、WebKit 21624.2.5.11.8；现有 test-only binary SHA-256 `e8bef9b7…`；原始 `/tmp/excalidraw-002-t001-startup-idle.json` SHA-256 `4289ee61…`，临时文件不提交；不是参考 VM T090 |
| `prompt` / `confirm`      | 生产源码仍在 `FileTree.tsx` 使用 4 个 `window.prompt` 与 1 个 `window.confirm`，在 `WorkspacePanel.tsx` 使用 1 个 `window.confirm`。同日隔离原生复现确认 prompt 无声取消、confirm 无声接受；唯一 delete sentinel 未显示确认即进入 macOS Trash，随后通过 Finder **Put Back** 恢复 | 原生复现使用隔离 app-data/workspace/sentinel；本轮未重复执行 Trash mutation，避免把已完成的安全复现误当实现后验收                                                                                              |

Focused browser 命令实际以仓库本地 Vite/Playwright 可执行文件运行；标准 `pnpm exec` 在当前环境尝试访问 registry 而失败，沙箱内 Chromium/Mach port 与 localhost bind 也被拒绝，因此最终在获准的本机执行边界运行。最终产品断言结果为 2 pass / 1 fail；前述环境启动失败不计入该结果。

## 0.1 Feature 002 Polish 验证说明（T066，2026-08-23）

本节记录 Polish 门禁顺序与证据边界。T067 成绩见 §0.2，T068 成绩见 §0.3，T069 成绩见 §0.4，T070 见 §0.5，T071 见 §0.6，T072 见 §0.7，T073 见 §0.8，T074 见 §0.9，T075 见 §0.10。§0 的 T001 基线、§1 的 T095、§4 的 T093、§5.2 的 001 T090/T108、§7 的 T078/T080 一律保持历史身份，不得重分类为 002 已验收。

### 剩余门禁顺序

文档与无障碍指令先于可执行门禁。顺序不得跳步把后面的成绩提前写成通过：

1. **文档 / 无障碍（T063–T066）**：跨故事 a11y 审计写入 [a11y-audit.md](./a11y-audit.md)（T063，本文件不改写其结果）；产品文档与架构/IPC 由 T064/T065 同步；本文件与 [native-verification.md](./native-verification.md) 由 T066 更新指令。
2. **前端 / Rust 门禁（T067）**：已执行，见 §0.2。仅修复 002 回归（Prettier 折行与一处未使用的 TabBar 测试绑定）。
3. **全量浏览器 E2E（T068）**：已执行，见 §0.3。不得用 §1 的 T095「36 pass / 2 fail / 12 skip」代替。
4. **生产 vs `e2e-harness` 二进制（T069）**：已执行，见 §0.4。
5. **隔离 macOS 功能 / 原生矩阵（T070）**：已执行，见 §0.5 与 [native-verification.md](./native-verification.md) §9。
6. **物理机 10k 连续树（T071）**：已执行，见 §0.6。不得把 §0 的修改前 10k fail 或 §5.2 的 001 canvas/I/O 写成 002 复测。
7. **性能可观测性（T072）**：已执行且路径有效，见 §0.7。无效则记 `not_evaluated`，**不得消耗 T108 时间**。
8. **T090 / T108 参考 VM（T073 / T074）**：仅当 T072 有效时，才跑未缩短的完整 T090 与 15 分钟 T108，并记录真实 `pass` / `fail`（T108 允许有依据的 `not_evaluated`）。T073 已执行，见 §0.8；T074 已执行，见 §0.9。权威门禁仍是声明配置的参考 VM（Parallels 4 vCPU / 8GB），不是本机 48 GB 物理机。VM 结果不得表述为未执行的真机覆盖。不得用 §5.2 的 001 报告代替。

T075（`specs/002-desktop-ui-interactions/quickstart.md` 全量命令与手工场景、安全/无障碍/文档对齐）已收口，见 §0.10。Ubuntu 24.04 Desktop 仍为可选社区验证，002 未新跑；Fedora / 其他 Linux / Windows 不在当前支持承诺内。

### Codex macOS 沙箱：浏览器 E2E

在 **Codex managed macOS 沙箱**里跑浏览器可见 Playwright 时，不得让 Playwright 在沙箱内启动其配置的 `webServer`（`e2e/playwright.config.ts` 默认 `pnpm dev --host 127.0.0.1`，ready URL `http://127.0.0.1:1420`）。应：

1. 在沙箱**外**启动 `pnpm dev --host 127.0.0.1`，等到 ready URL；
2. 再设置 `PLAYWRIGHT_SKIP_WEBSERVER=1` 运行 Playwright；
3. 使用非默认端口时同时设置 `PLAYWRIGHT_BASE_URL`。

普通开发者 shell 与 CI 仍可使用配置中的 `webServer`。沙箱内 Chromium / Mach port / localhost bind 失败不得记进产品 pass/fail。

### 缩略图退役

002 **不得**把 thumbnail IPC / 渲染当作当前产品工作。§0 T001 记录的 `thumb_lookup` / 额外 `doc_open` / worker render / `thumb_store` 是**修改前**活动，只作历史对照。T069（§0.4）已证明当前生产二进制与生产 `dist` 无 harness / `thumb_*` handler，也无 thumbnail worker chunk。

### 前序 002 US3/US4 会话交接（非本会话、非 T068）

前序交接称：focused Vitest + `tsc` 通过；Playwright **18 pass / 1 skip**（skip = live native window-contract，因未配置 `APP_E2E=1` + `EXCALIDRAW_E2E_BINARY`）。这是**前序会话的 focused 浏览器证据**，T066 本会话未复跑这些命令，因此：

- 不得当作 T068 全量套件成绩；
- 不得当作 T067 前端/Rust 全部门禁（T067 以 §0.2 本会话复跑为准）；
- 不得关闭 T070 的真实 Cmd+W / 中键 / 触控板 / 窗口堆叠行（见 [native-verification.md](./native-verification.md) §10：合成 harness 不是真机输入）。

## 0.2 Feature 002 前端 / Rust 门禁（T067，2026-08-23）

在 `codex/wip-desktop-ui-interactions`（产品 `178e890`）上执行。Prettier 先对 18 个 002 UI 文件折行，并去掉 `TabBar.test.tsx` 中未使用的 `betaTab` 绑定；随后全部门禁通过。这不是浏览器 E2E，也不是原生矩阵。

| 命令 | 结果 |
|------|------|
| `pnpm format` | **pass**（修复后复跑） |
| `pnpm lint` | **pass** |
| `pnpm typecheck` | **pass** |
| `pnpm test` | **pass**（211 passed / 30 files） |
| `pnpm build` | **pass** |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | **pass** |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | **pass** |
| `cargo test --manifest-path src-tauri/Cargo.toml` | **pass**（lib 64；`contract_documents` 10；`contract_entries` 9；`contract_workspace` 1；`contract_workspace_tree` 3；`untrusted_scene` 3） |

沙箱内首次 clippy 因 `libsqlite3-sys` `PermissionDenied` 失败，不计入产品成绩；获准本机执行后通过。

## 0.3 Feature 002 全量浏览器 E2E（T068，2026-08-23）

在 `codex/wip-desktop-ui-interactions` 上执行。Vite 在沙箱外监听 `http://127.0.0.1:1420`，Playwright 使用 `PLAYWRIGHT_SKIP_WEBSERVER=1`、`--workers=1`。侧栏默认隐藏后，测试改为 `openWorkspaceSidebar` / `persistPinnedWorkspaceSidebar`；钉住布局给树有界高度；tree 行键变化后恢复滚动锚点；`invalidated` 不再清空子树。外观基线已按钉住侧栏重录。磁盘满用例在捕获文件快照前等待 create 的第一次 checkpoint。这不是原生矩阵，也不是 T069 二进制证明。合成 harness 仍不是真实 Cmd+W / 中键 / 触控板证据。

| 套件 | 命令 | 结果 |
|------|------|------|
| focused | `pnpm e2e tests/ui-entry-dialogs.spec.ts tests/ui-continuous-workspace-tree.spec.ts tests/ui-tab-close-wheel.spec.ts tests/ui-sidebar-modes.spec.ts tests/us3-scale-scroll.spec.ts tests/a11y-audit.spec.ts --workers=1` | **42 passed**（53.9s，exit 0） |
| 全量 | `pnpm e2e --workers=1` | **69 passed** · **0 failed** · **27 skipped**（1.3m，exit 0；96 tests） |

27 skip 均因未配置原生二进制，不计入产品失败：

- US1 `native-entry-mutations` 9、US2 kill/recovery/snapshot 11、US3 `native-tab-close` 5、US4 live window-contract 1：需要 `APP_E2E=1` + `EXCALIDRAW_E2E_BINARY`（T070）
- `production-harness-absence` 1：需要 `TAURI_PRODUCTION_BINARY`（T068 当时未设；随后 T069 对该生产二进制复跑 **1 passed**，见 §0.4）

002 产物：`e2e/tests/workspaceSidebar.ts`；`us1-appearance.spec.ts-snapshots/us1-shell-{light,dark}-browser-ui-darwin.png`（钉住侧栏后的壳层基线）。

## 0.4 Feature 002 生产 vs `e2e-harness` 二进制（T069，2026-08-23）

在 `codex/wip-desktop-ui-interactions`（产品 `6ea1b2e`）上构建本机 macOS `.app`（`--bundles app`，不为 T069 打 dmg）。产物在 `CARGO_TARGET_DIR` 下；可执行文件副本留在 `/tmp/excalidraw-t069/`，**不提交**。这不是 T070 真机矩阵，也不是 T090/T108。

| 构建 | 命令 | 结果 |
|------|------|------|
| 生产 | `pnpm tauri build --bundles app` | **pass**（exit 0；zsh 只读 `status` 使包装脚本非零，Tauri 本身 `Finished 1 bundle`） |
| 测试 | `VITE_E2E_HARNESS=1 pnpm tauri build --features e2e-harness --bundles app` | **pass**（exit 0） |
| 生产缺席 | `TAURI_PRODUCTION_BINARY=/tmp/excalidraw-t069/excalidraw-desktop.production pnpm e2e tests/production-harness-absence.spec.ts` | **1 passed** |

| 产物 | SHA-256 | 说明 |
|------|---------|------|
| 生产可执行文件 | `83d3140bff81eefa6c9a0ce7bcd485d12aae45404b8d15ae49865f92e6c4ddc6` | 无全部 `E2E_HARNESS_ARTIFACT_TOKENS`；无 `thumb_lookup` / `thumb_store` / `thumbnail_render` |
| `e2e-harness` 可执行文件 | `8d84d09561dc1ae0efe0e123d102de9dfedfbe5c1efd47f7dcf774dcee93379c` | 含 `e2e_set_atomic_write_fault`、`e2e_corrupt_latest_snapshot`、`e2e_perf_*`、`EXCALIDRAW_PERF_CONTROL_DIR`；仍无 `thumb_*` |
| 生产 `dist` | 构建时快照于 `/tmp/excalidraw-t069/dist.production` | 无 `thumb_*`；唯一 `*worker*` 是 Excalidraw 字体 `subset-worker.chunk-*.js`，不是 thumbnail worker；无 `performanceDriver` chunk |
| harness `dist` | 随后 `VITE_E2E_HARNESS=1` 覆盖工作区 `dist/` | 仍无 `thumb_*` / thumbnail worker；出现 `performanceDriver-*.js`（测试专用） |

## 0.5 Feature 002 隔离 macOS 原生矩阵（T070，2026-08-23/24 已执行）

在物理机 `macos-physical-02`（macOS 26.5.2 25F84，Apple M5 Pro / 48 GB）上执行。2026-08-23 用 T069 生产 `.app`（SHA-256 `83d3140b…`）完成标题栏与遮挡/最小化。2026-08-24 用新生产 `.app`（SHA-256 `1e7b07a8bc6dfcce5be18904722c5487653c9d6078bbe46978808ef227307baa`，隔离根 `/tmp/excalidraw-t070.JPjQrP`）完成 Trash/Put Back、Open in Finder、钉住 70%，以及操作员 VoiceOver / Cmd+W / 中键 / 滚轮。明细见 [native-verification.md](./native-verification.md) §9。

| 行 | 状态 | 一句话 |
|----|------|--------|
| Trash / Put Back | **pass** | 真实 Mount 后 Delete 进入系统废纸篓；Finder「放回原处」恢复 `empty-dir` 与 `drawing.excalidraw` |
| Open in Finder | **pass** | 非空 `has-hidden` 出现「Folder isn’t empty」；显式 Open in Finder 打开工作区文件夹且未删除 |
| VoiceOver | **pass** | 操作员开启系统 VoiceOver，菜单/对话框/树行/标签关闭朗读符合预期 |
| 真实 Cmd+W | **pass** | 操作员物理 Cmd+W 只关活动标签；关完后窗口与侧栏仍在 |
| 中键 | **pass** | 操作员对未激活标签真实中键关闭 |
| 滚轮 / 触控板 | **pass** | 操作员真实滚轮/触控板垂直切换符合预期 |
| 侧边栏 overlay / pin / 改宽 | **pass** | overlay 不改画布盒；默认 800×600 钉住画布 560/800=70%；无拖拽改宽控件（SC-010 不要求 splitter） |
| 标题栏选择 A | **pass** | 2026-08-23：标题 Excalidraw Whiteboard；AXStandardWindow；layer 0；生产 conf 无 alwaysOnTop |
| 遮挡 / 最小化 / 恢复 | **pass** | 2026-08-23：TextEdit 覆盖；缩小后 off-screen；Window 菜单恢复 |

用户 `~/Library/Application Support/excalidraw-desktop` sqlite mtime 启动前后不变。

同日进程级 `APP_E2E=1`（harness SHA-256 `8d84d09561dc1ae0efe0e123d102de9dfedfbe5c1efd47f7dcf774dcee93379c`）补跑 T068 跳过的原生套件：**30 passed** · **0 failed** · **1 skipped**（nightly 100-seed，未设 `RELIABILITY_NIGHTLY=1`）。含 US2 八点 SIGKILL。这是 CLI harness 进程证据，**不是** §9 的真实 Cmd+W / 中键 / 触控板 / VoiceOver / Put Back。

## 0.6 Feature 002 物理机 10k 连续树（T071，2026-08-23）

在 `macos-physical-02`（macOS 26.5.2 25F84，Apple M5 Pro / 48 GB）上，对产品 `e1058d7` 复跑与 T001 同一诊断面：`us3-scale-scroll.spec.ts` 浏览器 fixture（Vite `http://127.0.0.1:1420`，`PLAYWRIGHT_SKIP_WEBSERVER=1`）。这不是原生文件系统索引，也不是 §5.2 的 001 10k 画布 T090。原始观察 JSON 在 `/tmp/excalidraw-t071-observation.json`，**不提交**。

| 指标 | T001 before（2026-08-19，`1346d29`） | T071 after（2026-08-23，`e1058d7`） | 预算 |
|------|--------------------------------------|-------------------------------------|------|
| 展开延迟 | **fail** 8088.5 ms | **pass** 44.1 ms | ≤200 ms |
| 渲染行数 | **fail** 10,001 treeitem 全部进入 DOM | **pass** 26 行（估计 10,002） | <300 |
| 滚动容器 | **fail** `scrollHeightPx == clientHeightPx == 320032`，位移 0 | **pass** 320064 > 566；位移 51,425 px；121 次位置变化 | 可滚动且位移 ≥50 px |
| 滚动 FPS | 记录 118.98 但容器不可滚动，无效 | **pass** 119.99 | ≥50 |
| 缩略图工作量 | 可见行 `thumb_lookup` / extra `doc_open` / render / `thumb_store` | **pass** `thumbnailCommands=[]`，DOM 缩略图 0，额外 `doc_open` 0 | 零缩略图 |

命令：`pnpm e2e tests/us3-scale-scroll.spec.ts --workers=1` → **1 passed**（2.4 s，随后 JSON reporter 复跑 1 passed）。回归 verdict：**pass**（相对 T001 10k 树 fail 与缩略图链）。浏览器 rAF 不证明 Tauri/WebView 进程树 RSS。

## 0.7 Feature 002 原生性能可观测性（T072，2026-08-23）

在 `macos-physical-02` 上用 T069 二进制探测 `command.json` → `result.json`（及生产构建必须忽略该目录），再决定是否消耗 T108 时间。探针：`e2e/perf/observability-probe.spec.ts`（仅 `PERF_OBSERVABILITY=1` 执行，避免混进完整 T090）。

| 项 | 结果 |
|----|------|
| 环境 | `macos-physical-02`；macOS 26.5.2 (25F84) |
| harness | `/tmp/excalidraw-t069/excalidraw-desktop.e2e-harness` SHA-256 `8d84d09561dc1ae0efe0e123d102de9dfedfbe5c1efd47f7dcf774dcee93379c` |
| 生产 | `/tmp/excalidraw-t069/excalidraw-desktop.production` SHA-256 `83d3140bff81eefa6c9a0ce7bcd485d12aae45404b8d15ae49865f92e6c4ddc6` |
| 命令 | `PERF_TEST=1 PERF_OBSERVABILITY=1 APP_E2E=1 pnpm e2e perf/observability-probe.spec.ts --workers=1` |
| 成绩 | **2 passed**（12.4 s）：`startup-editable` 后 3 s 可见 `pan-zoom` 写出 `result.json`（`commandId` 一致、`frameIntervalsMs` 非空）；生产进程 8 s 内无 `ready.json` / `result.json` / `error.json` |
| 路径有效性 | **valid**。因此 **可以** 在声明配置的参考 VM 上跑未缩短的 T090/T108（T073/T074）。本机 48 GB 物理机 **不是** 该参考 VM，不得把本机 T090 写成 T073。 |

未跑 T108。未把 T072 记为 `not_evaluated`。

## 0.8 Feature 002 参考 VM T090（T073，2026-08-24）

在声明配置的 Parallels 参考 VM `macOS26.5.2` 上执行未缩短的 T090（`startup-idle` + `canvas-io`）。来宾：macOS 26.5.2 (25F84)、arm64、4 逻辑 CPU、8589934592 bytes（8 GiB）、WebKit 21624.2.5.11.8。宿主硬件 `Apple M5 Pro / 48GB`，虚拟化 Parallels Desktop Pro 26.4.1。`PERF_REFERENCE_RUN=1`，`PERF_EXECUTION_ENVIRONMENT=virtual`。测量 commit `10fc040`；e2e-harness SHA-256 `8504a87a8d08cba2a762a506eaff9af236666aaad9fbd09de305e52aad579fae`（由该 HEAD 在宿主机 ARM64 重建后拷入来宾）。跑 T090 前在同一来宾对 harness 做 `observability-probe`：`result.json` **1 passed** / 生产忽略用例因未设 `TAURI_PRODUCTION_BINARY` 而 skip（生产忽略已由 T072 在物理机证明）。这不是 §5.2 的 001 序列。15 分钟 T108 见 §0.9。

| 套件 | 报告 | overall | 要点 |
|------|------|---------|------|
| startup / idle | [startup-idle.002.ref.json](./startup-idle.002.ref.json) SHA-256 `b6d6c2ac…` | **fail** | 冷启动至可编辑 P95 **2175.199 ms**（预算 ≤2000 ms，n=10 最短 1598 ms、最长即 P95）；进程拉起 P95 26.6 ms；空载全树 RSS P95 **331.4 MB** · **pass**（≤500 MB） |
| canvas / I/O | [canvas-io.002.ref.json](./canvas-io.002.ref.json) SHA-256 `bca08ae0…` | **pass** | 10k 稳定全树 RSS P95 **554.2 MB**（≤950 MB）；平移 59.95 fps / 最大冻结 33 ms；编辑 60.01 fps / 25 ms；写/编辑比 0 |

Playwright 两份 spec 均 exit 0（预算失败仍写出完整 `fail` 报告，不把套件失败当成测量中断）。预算失败不阻断合并或开源发布（[ADR-008](../adr/ADR-008.md)）。§5.2 的 001 `startup-idle.ref.json` / `canvas-io.ref.json` 保持历史身份，未被覆盖。

## 0.9 Feature 002 参考 VM 15 分钟 T108（T074，2026-08-24）

同一声明参考 VM 与同一 e2e-harness SHA-256 `8504a87a…`、commit `10fc040`，在 T073 的来宾 `observability-probe` 有效之后跑**未缩短**的 `edit-soak.spec.ts`。Playwright 墙钟 **17.6 min**；工作负载 `editing.actualDurationMs` **900000**（= 要求的 15 分钟，seed 40000）。报告 [edit-soak.002.ref.json](./edit-soak.002.ref.json) SHA-256 `32ab2cd9…`。这不是 §5.2 的 001 soak，也未缩短为诊断时长。

| 指标 | 预算 | 测量 | 判定 |
|------|------|------|------|
| RSS 增长绝对值 | ≤ 50 MB | +672.7 MB（预热 P95 556.6 MB → 静置 P95 1229.4 MB） | **fail** |
| RSS 增长相对值 | ≤ 15% | +120.9% | **fail** |
| 静置 idle CPU P95 | ≤ 35% 单逻辑核 | 23.5% | **pass** |
| 静置写入 | 0 事件 / 0 路径 | 0 / 0 | **pass** |
| 套件 overall | 全部过才 pass | RSS 增长两项失败 | **fail** |

编辑事件 3600。预算失败不阻断合并或开源发布（[ADR-008](../adr/ADR-008.md)）。§5.2 的 001 `edit-soak.ref.json` 保持历史身份，未被覆盖。

## 0.10 Feature 002 quickstart 收口（T075，2026-08-24）

对照 `specs/002-desktop-ui-interactions/quickstart.md` 的适用命令与手工场景。本任务不重写 §1–§8 的 001 历史，也不把 Ubuntu/Fedora/Windows 写成已覆盖。

| Quickstart 节 | 执行 | 证据 |
|---------------|------|------|
| 2 静态/单元 | 已执行 | T067 §0.2：typecheck/lint/test/build、cargo fmt/clippy/test **pass** |
| 3 聚焦浏览器 UI | 已执行 | T068 §0.3：focused 42 passed；全量 69 passed / 27 skipped |
| 4 原生测试二进制 | 已执行 | T069 §0.4；T073 另用当前 HEAD harness `8504a87a…` |
| 5 隔离 macOS 功能矩阵 | 已执行 | T070 §0.5 与 [native-verification.md](./native-verification.md) §9 |
| 6 标题栏选择 A | 已执行 | T070：标题栏 / 遮挡 / 最小化 / 恢复 **pass** |
| 7 进程可靠性 | 已执行 | T070 同日 `APP_E2E=1`：**30 passed** / 1 skipped（nightly 100-seed） |
| 8 性能回归 | 已执行 | 物理机 10k 树 T071 §0.6 **pass**；参考 VM T090 T073 §0.8（startup **fail** / canvas **pass**）；15 min T108 T074 §0.9 **fail** |
| 9 文档与契约同步 | 已执行 | T063–T066；本轮 `git diff --check` 无空白错误；无产品代码改动，仅证据 JSON 与 tasks 勾选待提交 |

安全 / 无障碍 / 文档对齐复查：T063 跨故事 axe serious/critical = 0，T070 含操作员 VoiceOver；T064–T066 已同步 DESIGN/README/AGENTS/CONTEXT、architecture/IPC/ADR-009 与证据指令；公开产品页不引用 SDD 任务号。本 Polish 切片未扩大 Tauri capabilities、未关 CSP、未把密钥写入仓库。

剩余缺口（诚实保留，不阻断 002 收口）：

- Ubuntu 24.04 Desktop 仍为可选社区验证；002 未新跑。001 T094 IME smoke 仍是该可选面的历史证据。
- Fedora / 其他 Linux / Windows 不在当前支持承诺内。
- 参考 VM 冷启动 2 s（T073）与 15 min soak RSS 增长（T074）为预算 **fail**，按 ADR-008 可见但不阻断合并或开源发布。
- §1.1 两个 001 浏览器断言脆性仍在历史成绩单中；T068 全量已绿，不得把 T095 的 2 fail 算进 T068。

## 1. 全量浏览器回归（T095 执行）

**命令**：`pnpm e2e`（Playwright `browser-ui`，Vite dev server + 浏览器 Tauri IPC harness）。

| 结果 | 数量 | 说明 |
|------|------|------|
| 通过 | 36 | 全部浏览器可测套件：US1 离线/格式/并发/磁盘满/外观、US3 文件管理/万级滚动、US4 外部变更/事件风暴、US5 导出 fidelity/失败、US7 缩略图/资产去重、T093 a11y 审计 |
| 跳过 | 12 | 原生可靠性（US2 八点故障注入、快照损坏、恢复窗口等）依赖 `APP_E2E=1` + `EXCALIDRAW_E2E_BINARY` 的测试构建；`production-harness-absence` 依赖 `TAURI_PRODUCTION_BINARY` |
| 失败 | 2 | `us1-concurrent-tabs-save`（严格模式定位到 2 个画布）与 `us3-scale-scroll`（`scrollHeight == clientHeight` 边界断言）——见 §1.1 |

### 1.1 已知失败（pre-existing，非本阶段回归）

两个失败用例在干净 `HEAD 9e6ea21`（相同依赖、独立快照目录）上以相同方式复现，且本阶段对 `src/` 的唯一改动是两个语义 token 颜色值（`src/app/theme/tokens.css`），不参与任何布局或虚拟化路径。结论：失败为环境/断言脆性，先于 Phase 10 存在。

- `us1-concurrent-tabs-save.spec.ts`：`locator(".excalidraw__canvas.interactive")` 严格模式命中两个画布（首个标签的 0×0 画布仍在 DOM）。
- `us3-scale-scroll.spec.ts:194`：`scrollHeightPx` 与 `clientHeightPx` 恰好相等（320032），1px 布局漂移即翻转断言；与 T093 审计中记录的外观基线像素漂移（字体/环境级）一致。

处理意见：作为已知偏差记录在案，后续以定位符收敛（`.first()`/可见性过滤）与 `>=` 边界修正消除；修复不属本阶段范围。

**002 现况（不改写上表）**：两条已在当前产品代码中消除，不得把 T068 的 69 passed 写回本节 T095 计数。`us1-concurrent-tabs-save` 只定位 `.canvas-document:not([hidden])` 内的画布；`us3-scale-scroll` 断言改为 `scrollHeightPx > clientHeightPx`，连续树虚拟化后容器可滚动。T068 全量浏览器 **69 passed / 0 failed**（2026-08-23）；T071 复跑 `us3-scale-scroll` **pass**（展开 44.1 ms，26 行虚拟化）。上表「失败 2」仍是 Phase 10 / `HEAD 9e6ea21` 的历史记录。

## 2. SC-012 统一可靠性阻断门禁

三类可靠性故障测试合并为统一的 SC-012 合并阻断门禁，任一失败即阻止合并：

| 套件 | 任务 | 覆盖 |
|------|------|------|
| `e2e/tests/us2-kill-during-save.spec.ts` | T037 | 原子写八个故障点逐点 SIGKILL，目标文件完整、恢复 UI 正确 |
| `e2e/tests/us2-snapshot-corruption.spec.ts` | T045 | 最新快照自损 → 回退次新并提示实际恢复时间点 |
| `e2e/tests/us4-external-changes.spec.ts` | T066 | 外部变更自动重载/冲突弹窗/失联另存，决策前零写入 |

**执行方式**：`APP_E2E=1 pnpm e2e`，要求 `EXCALIDRAW_E2E_BINARY` 指向故障注入测试构建（Harness 仅测试构建编译注册，生产构建无该接口）。当前证据状态：前序会话（Phase 8/9 交接）报告三套件通过；本会话未重新执行（未构建本地测试二进制），缺口记录见 §7。

## 3. SC-014 外观矩阵与视觉基线（T111）

- `e2e/tests/us1-appearance.spec.ts` 本次 4/4 通过：light/dark/system 初始解析、运行中系统变化、重启恢复、损坏偏好回退、壳层/画布同步、浅色/深色截图基线 `maxDiffPixelRatio <= 0.001`。
- 基线更新：T093 期间重新生成 `us1-shell-light/dark-browser-ui-darwin.png`。审计确认提交基线在生成前已存在约 35k 像素的环境级漂移（字体/渲染），重生成同时捕获当前渲染与 T093 的 token 颜色修正；该修正只改颜色，不改变断言阈值。

## 4. SC-015 无障碍证据（T097–T102 + T093）

- 各故事 a11y 最低线 T097–T102 随功能交付（壳层/标签/外观选择/文件对话框、恢复/冲突对话框、文件树键盘导航、缩略图/多工作区区域、导出对话框表单关联）。
- T093 跨故事审计：axe-core 4.12.1（`@axe-core/playwright`），标签 `wcag2a/wcag2aa/wcag21aa/wcag22aa`，浅色与深色各表面 serious/critical 均为 0；15 个用例全部通过。修复：`--warning`/`--success` 浅色值（白底 2.99:1 → 5.47:1、4.36:1 → 5.40:1）。完整矩阵与键盘/焦点/reduced motion 结论见 [a11y-audit.md](./a11y-audit.md)。

## 5. 参考环境性能测量（T089/T090/T108/T091）

当前有效成绩单是 **2026-08-16 ADR-007 序列**：物理机 + 声明参考 VM，同一份 e2e-harness SHA-256 `e8bef9b754c526632b49655ad3a23c81ac060b3004ab8881ed7a00fe384b1f99`，commit `0a77e1f`。恒定 zoom=1 平移；T108 编辑结束后先等 5 s 再采静置窗。空载 RSS 500 MB、10k RSS 950 MB、idle CPU 35%（ADR-007）；冷启动 2 s 与 soak RSS 增长未改（ADR-008）。权威门禁是参考 VM；物理机先行。§5.3 的 8/13–8/15 流水账不可与下表混比。

### 5.1 结论

没有发现产品热路径上的严重性能缺陷：10k 场景平移/编辑约 60 fps，冻结远低于 100 ms，空载与 10k RSS 过校准后的预算，静置 0 写入。增长不在 Tauri / GPU / 磁盘，也不在崩溃安全持久化。

仍诚实保留的两项 `fail`（预算未抬，不阻断合并或开源发布，[ADR-008](../adr/ADR-008.md)）：

1. **官方 15 min T108 soak RSS 增长**：物理机 +368 MB / +47%，参考 VM +217 MB / +30%。形态是开编约 40 s 抬升后高位平台，不是编满 15 分钟才堆出来的无界泄漏。物理机 180 s 分角色（非门禁）证明只有 WebContent 上涨；WebContent 是 WKWebView 进程（WebKit + 上游 Excalidraw + 壳层），不等于「TypeScript 壳设计过重」。undo/`captureUpdate` 是否为涨因尚未 A/B。
2. **参考 VM 冷启动 2 s**：P95 3704 ms。进程拉起约 30 ms（比物理机还快）；慢在 spawn 之后的 WebView + 空场景就绪。物理机 615 ms 已过。2026-08-17 把同一来宾临时改成 8 vCPU 只跑冷启动（非门禁）：暖启动大约快 200 ms，P95 仍被第一次冷缓存拉到 3991 ms，去掉第一次后最慢仍 2028 ms。核数帮不上这条预算，specs / 4 vCPU 门禁未改。

能说的同级别对照只有空载全树 RSS（同一套 launchd-reparent 口径，物理机热身 30 s + 采样 60 s；[ADR-007](../adr/ADR-007.md)）。仓库里没有 Figma、tldraw 桌面版或 Electron Excalidraw 壳的 15 min soak。

| 场景 | 全树 RSS P95 | 说明 |
|------|----------------|------|
| 空白 Tauri v2 窗口 | 201.2 MB | 无插件、空白 HTML |
| 本应用空闲 | 411–427 MB | WebContent 约 195 MB |
| Safari 打开 [excalidraw.com](https://excalidraw.com/) | 629.4 MB | WebContent 约 300 MB |

本应用落在空壳与 Safari+Excalidraw 之间；WebContent 低于 Safari 加载同一画布。500 MB 空载预算对照的是 WKWebView+Excalidraw 基线，不是把 411 MB 算进壳层泄漏。报告：[`idle-control-tauri.json`](./idle-control-tauri.json)、[`idle-control-safari.json`](./idle-control-safari.json)。

### 5.2 最终成绩单（ADR-007 序列）

三张表对应 T090 的两份报告与 T108 官方 15 min 门禁。单元格为测量值 + `pass`/`fail`。十进制 MB = 10^6 bytes；P95 为 nearest-rank。

**表 1 · T090 startup / idle**（[`startup-idle.host.json`](./startup-idle.host.json) SHA-256 `ad753249…`；[`startup-idle.ref.json`](./startup-idle.ref.json) `3747832d…`）

| 指标 | 预算 | 物理机 | 参考 VM |
|------|------|--------|---------|
| 冷启动至可编辑 P95 | ≤ 2000 ms | 615 ms · **pass** | 3704 ms · **fail** |
| 空载全树 RSS P95 | ≤ 500 MB | 427.3 MB · **pass** | 411.4 MB · **pass** |
| 套件 overall | 两项都过才 pass | **pass** | **fail** |

**诊断 · 8 vCPU 冷启动（非门禁，2026-08-17）**。同一份来宾 scratch 与 `startup-idle` spec；未设 `PERF_REFERENCE_RUN`（否则 4 核断言会拒跑）；未覆盖 [`startup-idle.ref.json`](./startup-idle.ref.json)。nearest-rank P95 在 n=10 时等于最大值。报告 [`startup-idle.ref.8vcpu.json`](./startup-idle.ref.8vcpu.json)（SHA-256 `8fb28477…`）；来宾 `commit` 字段仍是旧副本 `8c75caa`，不可信。

| 指标 | 4 vCPU 官方 | 8 vCPU 诊断 | 物理机 |
|------|-------------|-------------|--------|
| 逻辑核 / 内存 | 4 / 8 GiB | 8 / 8 GiB | 15 / 48 GiB |
| 进程拉起 P95 | 30 ms | 19 ms | 40 ms |
| 冷启动 P95 | 3704 ms · **fail** | 3991 ms · **fail** | 615 ms · **pass** |
| 第 1 次（冷缓存） | 3704 ms | 3991 ms | — |
| 其余 9 次 | 2118–2238 ms | 1927–2028 ms | — |
| 空载 RSS P95 | 411.4 MB · **pass** | 422.6 MB · **pass** | 427.3 MB · **pass** |
| 套件 overall | **fail** | **fail**（诊断） | **pass** |

暖启动大约快 200 ms，仍贴着 2 s；P95 继续被第一次冷缓存主导。不因此改 specs 或把参考 VM 调到 8 vCPU。

**表 2 · T090 canvas / I/O**（[`canvas-io.host.json`](./canvas-io.host.json) SHA-256 `814cdc5e…`；[`canvas-io.ref.json`](./canvas-io.ref.json) `d6fbb45f…`）

| 指标 | 预算 | 物理机 | 参考 VM |
|------|------|--------|---------|
| 10k 稳定全树 RSS P95 | ≤ 950 MB | 866.6 MB · **pass** | 742.7 MB · **pass** |
| 平移观测 fps | ≥ 30 | 59.91 · **pass** | 59.93 · **pass** |
| 平移最大冻结 | ≤ 100 ms | 33 ms · **pass** | 34 ms · **pass** |
| 编辑观测 fps / 最大冻结 | 冻结 ≤ 100 ms | 60.00 / 24 ms · **pass** | 59.99 / 45 ms · **pass** |
| 写 / 编辑比 | ≤ 0.01 | 0 · **pass** | 0 · **pass** |
| 套件 overall | 全部过才 pass | **pass** | **pass** |

**表 3 · 官方 15 min T108 soak**（[`edit-soak.host.json`](./edit-soak.host.json) SHA-256 `5c17040b…`；[`edit-soak.ref.json`](./edit-soak.ref.json) `ed8c0bef…`）

| 指标 | 预算 | 物理机 | 参考 VM |
|------|------|--------|---------|
| RSS 增长绝对值 | ≤ 50 MB | +368.0 MB · **fail** | +216.9 MB · **fail** |
| RSS 增长相对值 | ≤ 15% | +46.8% · **fail** | +29.9% · **fail** |
| 静置 CPU P95 | ≤ 单核 35% | 14.4% · **pass** | 31.2% · **pass** |
| 静置写盘 | 0 事件 / 0 路径 | 0 / 0 · **pass** | 0 / 0 · **pass** |
| 套件 overall | 增长两项都过才 pass | **fail** | **fail** |

180 s 分角色是诊断，不是第四张门禁，不能改写表 3。两次物理机跑只有 WebContent 上涨，结束全树低于开编：[`soak-rss-attribution.host.json`](./soak-rss-attribution.host.json)、[`soak-rss-attribution.host.quiet.json`](./soak-rss-attribution.host.quiet.json)。

### 5.3 测量流水账（历史，不可与 §5.2 混比）

- 基础设施：T089 测量夹具与报告 schema v2.0.0 记录宿主、虚拟化层与客体环境；T091 `performance.yml` 由维护者手动触发参考 VM 完整测量并归档报告。
- 首个参考环境：Apple M5 Pro / 48GB 宿主上的 Parallels Desktop Pro 26.4.1、macOS 26.5.2（25F84）、4 vCPU / 8 GiB VM（客体 `VirtualMac2,1 (Apple M5 Pro (Virtual))`，arm64，WebKit 21624.2.5.11.8）。测量 commit `8c75caafd6e2e1dde19c8ee2afdbb79030e6512f`，e2e-harness 可执行文件 SHA-256 `0235da4dadc0f847fd995db57f4b0f9969bd701791e238b1a818d378fd8273a5`。
- 2026-08-13 根因修复：此前 canvas/I/O 与 soak 的 `not_evaluated` 源于前端 driver `parseCommand` 的序列化缺口——Rust 将 `Option::None` 序列化为 `"targetEvents": null`，而 TS 校验用 `!== undefined`，导致所有不带 `targetEvents` 的 pan-zoom/edit-soak 命令被拒、`result.json` 永不产出。修复为 `PerformanceCommand.target_events` 增加 `#[serde(skip_serializing_if = "Option::is_none")]`，并补 Rust/TS 回归测试。
- 2026-08-13 T090 startup/idle 完整执行，verdict `fail`：10 次冷启动均发布可编辑画布信号，nearest-rank P95 为 2229.164333 ms（超过 2000 ms 预算）；空闲进程树 RSS P95 为 140328960 bytes（低于 150000000 bytes 预算）；60 秒空闲观察 0 个文件系统事件、0 个持久路径变化。
- 2026-08-13 T090 canvas/I/O 完整执行，verdict `fail`：10k 场景稳定后进程树 RSS P95 233537536 bytes（≤350 MB 预算）；pan/zoom 观测 2.04 fps（<30 fps 预算）、最大帧间隔 15668 ms（>100 ms 冻结预算）；60 秒高频编辑 58.72 fps 但最大帧间隔 750 ms（>100 ms）；写合并比 0.00194（≤0.01 预算）。pan/zoom 低帧率与长冻结与 paravirtual GPU 软件渲染一致，需复测并区分产品回归与虚拟化噪声（ADR-004）。
- 2026-08-13 T108 30 分钟 soak 完整执行，verdict `fail`：RSS 增长 18235392 bytes（≤50 MB）且 7.82%（≤15%）；静置 60 秒 CPU P95 为 9.7% 单逻辑核（>1% 预算）；静置观察 8 个文件系统事件、8 个持久路径变化（>0 预算）。空闲 CPU 与静置写盘超出预算，需定位静置期后台写入来源（draftScheduler 兜底/索引/缩略图等）。
- 进程树计量边界（2026-08-13 记录，2026-08-14 已修复，见下）：macOS 上 WKWebView 的 WebContent/GPU/Network 进程被 reparent 到 launchd（ppid=1）且命令行不含 app token，`processMetrics` 的「递归父闭包 + 令牌归属」无法将其归入进程树，故 2026-08-13 报告的 RSS 样本 `processCount=1`、仅计 Tauri 主进程。
- 报告归档：`e2e/perf/results/startup-idle.json`（SHA-256 `0d3a1091…`）、`canvas-io.json`（`62568c47…`）、`edit-soak.json`（`a336a2f6…`），三者 schemaVersion `2.0.0`、commit `8c75caa…`、verdict 均为真实 `fail`。
- 2026-08-14 soak 时长政策变更：经 ADR-006（宪法 v3.2.0、私有 specs 同步），T108 必要编辑 soak 时长由 30 分钟缩短为 15 分钟；RSS 增长预算（≤50 MB 且 ≤15%）与静置检查不变。15 分钟序列的 `rssGrowthBytes` 不得与旧 30 分钟报告直接比较。
- 2026-08-14 测量基础设施修复（`e2e/helpers/webkitProcesses.ts`、`app.ts`、`processMetrics.ts`、driver 错误桥）：
  1. 进程树 RSS 归因改为「启动时间窗口」：ppid=1、启动晚于 app 启动、且不在启动前快照中的 WebKit 角色进程归入应用树。物理机验证 `processCount` 由 1 变为 4（Tauri/WebContent/GPU/Networking）。诚实计量后，物理机（Apple M5 Pro）diagnostic 空闲 RSS P95 为 413.4 MB，超过 150 MB 预算——2026-08-13 VM 报告的 140 MB「通过」是 Tauri-only 口径假象，RSS 全序列需按新口径在参考 VM 重测（构成新测量序列）。
  2. `launchTauriTestApp.close()` 现按同一追踪集终止被 reparent 的 WebKit 孤儿进程；物理机多次启动后确认零泄漏（交接文档所记跨启动进程累积问题关闭）。
  3. driver 错误桥：driver 致命错误经新 Tauri 命令 `e2e_perf_publish_error` 原子发布 `error.json`，Node 侧 `waitForReady/waitForResult` 轮询即刻快速失败；`launchTauriTestApp` 改为捕获 stderr 尾部并入契约错误。WebKit 的 `error.stack` 不含 message，错误格式化已改为 message+stack。
  4. 宿主机「`result.json` 不返回」根因确诊：性能工作负载由 rAF 驱动，窗口被遮挡（用户在其他 Space/全屏应用）或显示器休眠时 WKWebView 暂停 rAF 且 `visibilityState=hidden`，driver 在 `nextAnimationFrame` 上无限挂起、无任何错误输出。driver 的 rAF 停摆看门狗：`visibilityState=hidden` 时 10 秒失败（遮挡/App Nap）；可见但慢的帧等到 60 秒，以便把 10k pan/zoom 的长冻结记成样本而不是 `not_evaluated`（2026-08-13 VM 最大冻结 15668 ms；2026-08-15 第一次 10 秒看门狗在 `visibilityState=visible` 下误杀）。Node 侧 `waitForResult` 松弛 75 秒，须长于可见挂起看门狗。harness 构建禁用 App Nap（`NSProcessInfo` activity）并在 perf 控制模式下窗口置顶。宿主机 diagnostic 跑的硬性前提：测量窗口全程可见；参考 VM 独占 GUI 会话且 Parallels 窗口在前台时不受遮挡暂停影响。
  5. 物理机 2026-08-14 diagnostic startup-idle（修复后口径）：冷启动 P95 1982 ms（贴近 2 s 预算）、空闲全树 RSS P95 413.4 MB（fail）、60 秒空闲 0 写入。报告保留为 `e2e/perf/results/startup-idle.json`（commit `53e6c20`）。
- 2026-08-15 物理机 diagnostic **全树新序列**（`PERF_EXECUTION_ENVIRONMENT=physical`，二进制 `837c5cd82bf4fb316c4405aec131b84640d4d2a2ea608e6f291aa4c1448aca7e`，与 VM canvas-io/soak 同一份；测量窗口 `always_on_top`。报告 JSON 的 `commit` 为测量时宿主 `eb41486`；该二进制已含随后提交的可见慢帧看门狗与 `waitForResult` 松弛）：
  1. startup-idle，verdict `fail`：冷启动 P95 **2049.818417 ms**（略超 2000 ms）；空闲全树 RSS P95 **411025408 bytes**（411.0 MB，> 150 MB）；`processCount=4`；60 秒空闲 0 写入。与 VM 410.7 MB、前次 diagnostic 413.4 MB 同量级。报告：`e2e/perf/results/startup-idle.host.json`（SHA-256 `2d93d88f7464db13ce083d9840553f723ad109dd5d585f390678075bb3304d59`）。
  2. canvas-io，verdict `fail`：10k 全树 RSS P95 **730546176 bytes**（730.5 MB，> 350 MB）；pan/zoom **21.82 fps**（<30）但最大冻结仅 **108 ms**（>100，贴近预算）；高频编辑 **59.97 fps**、最大冻结 **46 ms**（两项冻结/编辑帧率通过）；写合并比 0（通过）。相对 VM 的 2.10 fps / 15396 ms 冻结，物理机 pan/zoom 约高一个数量级，坐实 VM 低帧率主要是 paravirtual GPU；21.82 fps 仍低于 30 fps 预算，属随后物理机归因要分清的产品/workload 问题。报告：`e2e/perf/results/canvas-io.host.json`（SHA-256 `9312a02e11b5ae118237701c6c7f43d1ddeb653d1016e2798047884f18899254`）。
  3. T108 15 分钟 soak，verdict `fail`：预热全树 RSS P95 780976128 bytes（781.0 MB），soak 后 872366080 bytes（872.4 MB）；RSS 增长 **91389952 bytes**（91.4 MB，> 50 MB）但相对增长 **11.70%**（≤15%，通过）；静置 CPU P95 **16.3%**（>1%）；静置写 8 事件 / 8 路径（>0）。`processCount=4`，3600 次编辑、53988 帧。相对 VM 的 167 MB / 22.6% / 28.9% CPU，物理机泄漏与空闲 CPU 更轻，但 8 次静置写盘与 VM 相同，属产品路径而非虚拟化噪声。报告：`e2e/perf/results/edit-soak.host.json`（SHA-256 `fb2569d54e9306b640814ca053a2e28f440bf9572c8d6b250991f56a218f6a37`）。
- 2026-08-14/15 参考 VM **全树归因新序列**（ADR-006 的 15 分钟 soak。报告 JSON 的 `commit` 字段仍是来宾旧仓库副本的 `8c75caa`，**不可信**，取证以二进制 SHA-256 为准。`startup-idle` 二进制 `8246ecf0dfe976580fb228b96d24b1510ea1654fdd822ee09d4e75c749d59a5d`（宿主 `HEAD` `eb41486`）；`canvas-io` / `edit-soak` 二进制 `837c5cd82bf4fb316c4405aec131b84640d4d2a2ea608e6f291aa4c1448aca7e`，含可见慢帧 60 秒看门狗与 75 秒 `waitForResult` 松弛，测量时相对 `eb41486` 尚未提交该 driver/spec 修复。2026-08-16 ADR-007 重测后 `*.ref.json` 路径改存新序列；本条 SHA 对应的文件另存为 `*.ref.2026-08-15.json`）：
  1. T090 startup/idle 完整执行，verdict `fail`：冷启动 P95 **3650.417292 ms**（> 2000 ms）；空闲全树 RSS P95 **410746880 bytes**（410.7 MB，> 150 MB）；`processCount=4`（Tauri + WebContent + GPU + Networking）；60 秒空闲 0 个文件系统事件、0 个持久路径变化。与物理机 diagnostic 空闲 RSS 413.4 MB 同量级，坐实 2026-08-13 VM 的 140 MB「通过」是 Tauri-only 假象。报告：`e2e/perf/results/startup-idle.ref.json`（SHA-256 `b8d6b29d4728853f3e0369639832608e4e7ebf4d94d5a7dd3c26714648975f65`）。
  2. T090 canvas/I/O 完整执行，verdict `fail`：10k 场景稳定后全树 RSS P95 **726368256 bytes**（726.4 MB，> 350 MB）；pan/zoom 观测 2.10 fps（<30 fps）、最大帧间隔 15396 ms（>100 ms）；60 秒高频编辑 58.71 fps 但最大帧间隔 625 ms（>100 ms）；写合并比 0.00111（≤0.01 预算，通过）。`processCount=4`。相对 2026-08-13 Tauri-only 的 233.5 MB「通过」，10k RSS 在诚实全树口径下同样不达标。报告：`e2e/perf/results/canvas-io.ref.json`（SHA-256 `b8e9bcce1693e9fa4169f85424d08fb82fdb693917ec40507f4c6920f3215623`）。
  3. T108 15 分钟 soak 完整执行，verdict `fail`：预热全树 RSS P95 738967552 bytes（739.0 MB），soak 后 905969664 bytes（906.0 MB）；RSS 增长 **167002112 bytes**（167.0 MB，> 50 MB）且 **22.60%**（> 15%）；静置 60 秒 CPU P95 **28.9%** 单逻辑核（> 1%）；静置观察 8 个文件系统事件、8 个持久路径变化（> 0）。`processCount=4`，soak 完成 3600 次脚本编辑、53956 帧。15 分钟 `rssGrowthBytes` 不得与 2026-08-13 的 30 分钟序列直接比较；静置 8 次写盘与旧报告同数量级。报告：`e2e/perf/results/edit-soak.ref.json`（SHA-256 `efb1cc94d8bd144622b7dfe6dd2b7cb13685d117c58a0163af4b5ff20ea66580`）。
- 2026-08-16 ADR-007 后新序列（物理机 + 参考 VM，二进制 `e8bef9b7…`）：最终 `pass`/`fail` 与 JSON SHA 见 §5.2，结论见 §5.1。不要与上条 8/14–8/15 振荡-zoom / 立刻观察写盘的绝对值混比。来宾报告 `commit` 仍可能是旧副本 `8c75caa`，取证以二进制 SHA-256 为准。

## 6. SC-010 开源分发记录

2026-08-12 决策取代 2026-08-05 的“延后签名/公证”设想：项目不规划 App Store、Developer ID 或 Apple 公证。`.github/workflows/release.yml` 在 `v*` tag 构建并创建 GitHub Release，上传未签名/未公证 macOS 与 Linux 产物；README 和发布说明披露 Gatekeeper 风险与用户主动手动放行步骤。

2026-08-18 已打 `v0.1.1`（commit `5e6f2b9`）并发布：[ignacioli/excalidraw-desktop `v0.1.1`](https://github.com/ignacioli/excalidraw-desktop/releases/tag/v0.1.1)。`v0.1.0` tag 的 workflow 因 pnpm 11 需要 Node 22 而失败，未形成 Release。Linux 包为 ubuntu-22.04 **amd64**，不是当前 Ubuntu ARM64 验证机可直接安装的架构。

## 7. 残余风险

- §1.1 两个 pre-existing 浏览器测试失败。
- T078/T080 已于 2026-08-18 在物理 macOS 26.5.2 对真实 `v0.1.1` GitHub Release 执行（Chrome 下载隔离、Gatekeeper 手动放行、文件关联、单实例、FR-030 画布/拖放/剪贴板/IME）；记录见 [native-verification.md](./native-verification.md)。T094 已在 Ubuntu 24.04.4 ARM64 VM（GNOME Wayland + ibus libpinyin）完成可选 IME smoke。未覆盖：`macos-vm-01`、Fedora/其他 Linux、GitHub amd64 Linux 包在 ARM 客机上的安装。
- T090/T108 当前 `pass`/`fail`、产品热路径结论与同级别空载对照见 §5.1–§5.2。两条仍 fail 的项（soak RSS 增长、参考 VM 冷启动 2 s）预算未改，不阻断合并或开源发布（[ADR-008](../adr/ADR-008.md)）。2026-08-14/15 振荡-zoom 序列只作历史对照（§5.3）。
- 2026-08-15 物理机归因（未重跑 T090/T108；报告 gitignored；此「归因」不是 `tasks.md` 的 SDD Phase 2 Foundational）：
  1. 分角色 RSS（`e2e/perf/results/phase2-attribution.host.json`，SHA-256 `6681a9b6dc469049e20d68ba2230c1262019832d790723471e2b3309d4de6d4a`，二进制 `837c5cd8…`）：空闲全树 P95 **400.7 MB** = WebContent 195.4 + Tauri 147.9 + GPU 40.4 + Network 17.0。10k 加载后（编辑前）**761.7 MB** = WebContent 427.8 + Tauri 239.8 + GPU 76.8 + Network 17.2。当时 150 / 350 MB 全树预算低于 WebContent 单项，属预算对照基线而非产品泄漏；ADR-007 已重校准为 500 / 950 MB。空闲 CPU P95 **9.4%**（Tauri 4.2 + WebContent 5.2）。
  2. 静置 8 次写：15 秒高频编辑后立即观察 60 秒，仍是 **8 事件 / 8 路径**。路径为一次 `save_draft` 的 recovery 原子写 + 一次 idle checkpoint 的 `performance.excalidraw` 原子写 + sqlite/WAL。编辑结束后再等 5 秒再观察 20 秒：**0 写入**（`phase2-panzoom.host.json`）。不是持续后台写盘；ADR-007 后官方 T108 静置窗已过。
  3. pan/zoom A/B（`phase2-panzoom.host.json`，SHA-256 `882da7d55d54b844078516d9c52b24e1a5da18aea0d200f2dce7262b47b5ebc8`，探测二进制 `3d747904…`）：官方每帧 `updateScene` 振荡 zoom **24.38 fps** / 91 ms；同场景锁定 zoom=1 只平移 **59.69 fps** / 63 ms。物理机当时 21.82 fps 主要是测试视口在每帧改 zoom，不是 10k 平移本身。探测用的 adapter 种子约定已从工作区撤回。
- 空窗口 / Safari 对照在未禁用 App Nap 时 idle CPU P95 约为 0%，不能用来否定 harness（可见窗口 + 禁用 App Nap）下的 9–29% idle CPU 测量条件。
- 宿主机 diagnostic 性能跑要求测量窗口全程可见（rAF 遮挡暂停约束，§5.3）；`visibilityState=hidden` 时 driver 10 秒失败，可见慢帧最多等 60 秒。
- 上游 `@excalidraw/excalidraw` 内部 DOM 不在壳层 a11y 扫描范围（T093 残余说明）。
- Feature 002 Polish：T063–T075 已执行（T067 见 §0.2，T068 见 §0.3，T069 见 §0.4，T070 见 §0.5，T071 见 §0.6，T072 见 §0.7，T073 见 §0.8，T074 见 §0.9，T075 见 §0.10）。T073 参考 VM startup/idle **fail**（冷启动 P95 2175 ms），canvas/I/O **pass**；T074 15 min soak **fail**（RSS +672.7 MB / +120.9%，idle CPU 与静置 0 写入通过）。不得把 §5.2 的 001 数字写成 002。002 无障碍数字以 [a11y-audit.md](./a11y-audit.md) 为准。前序会话 focused 18 pass / 1 skip 不是 T068。T068 的 27 skip 不是失败。
