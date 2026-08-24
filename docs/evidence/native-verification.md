# 原生壳验证记录（Native Shell Verification）

**范围**：项目通过 GitHub Releases 长期分发未签名、未公证的 macOS 产物与 Linux AppImage、deb、rpm。macOS 原生功能、安装与 IME 验收是当前版本必选门禁；Ubuntu 24.04 Desktop 可选补充社区 smoke test，Fedora/其他 Linux 不形成当前版本验收要求（FR-029/030，SC-010）。

验证证据分为三类并分开报告（quickstart §1）：Playwright 浏览器 UI、`APP_E2E=1` Tauri 进程级可靠性、本文件记录的目标 OS 原生环境矩阵。浏览器测试不得替代本文件条目；虚拟机结果不得表述为未执行的真机覆盖。

**证据分层（001 历史 vs 002 部分执行）**：§1–§8 与 2026-08-18 GitHub Release `v0.1.1` 矩阵是 feature 001 的 T078（Gatekeeper / 安装 / 文件关联 / 单实例）与 T080（FR-030 画布 / 拖放 / 剪贴板 / IME）物理机历史证据，不得改写或重分类为 002 结果。Feature 002 US1–US4 原生矩阵见 §9：环境 `macos-physical-02` 于 2026-08-23 部分执行；Trash/Finder/VoiceOver/Cmd+W/中键/滚轮仍为 `not_executed`，T070 未完成。浏览器 Playwright 与测试专用 `e2e-harness` 合成场景不能关闭 §9 各行，见 §10。002 原生矩阵未在 Ubuntu / Fedora / Windows 上执行，也不形成那些平台的 002 验收声明。

## 1. 受支持平台清单（FR-030）

| 平台 | 目标 |
|------|------|
| macOS | macOS 12+（Apple Silicon + Intel），本地未签名构建 |
| Ubuntu 24.04 Desktop（可选） | AppImage / deb / rpm 社区 smoke test；Fedora/其他 Linux 不在当前版本支持承诺内 |

## 2. 验收环境记录

执行日期：**2026-08-18**。产物：[GitHub Release `v0.1.1`](https://github.com/ignacioli/excalidraw-desktop/releases/tag/v0.1.1)（annotated tag → commit `5e6f2b9`）。macOS 必选验收在宿主机物理机完成，不用 `macos-vm-01`。

| 环境 ID | 类型 | 宿主硬件 | 虚拟化软件/版本 | 客体 OS | vCPU/RAM | 桌面/显示协议 | 状态 |
|-----------|------|----------|---------------------|-----------|----------|-------------------|------|
| macos-physical-01 | 物理机 | Apple M5 Pro / 48GB | N/A | macOS 26.5.2 (25F84)，WKWebView 随系统 | 15 逻辑核 / 48GB | macOS WindowServer | 2026-08-18 已执行 |
| macos-vm-01 | VM | Apple M5 Pro / 48GB | Parallels Desktop Pro 26.4.1 | macOS 26.5.2 | 4 vCPU / 8GB | macOS WindowServer | 本轮未使用（物理机已覆盖 T078/T080） |
| ubuntu-vm-01 | VM | Apple M5 Pro / 48GB | Parallels Desktop Pro 26.4.1 | Ubuntu 24.04.4 LTS aarch64，WebKitGTK 2.52.3 | 4 vCPU / 8GB | GNOME / Wayland | 2026-08-18 已执行（可选 T094） |

环境记录完整后才能填写通过结果。更换宿主机、虚拟化软件版本、客体 OS/WebView、虚拟资源或显示协议时，必须新增环境 ID 或明确记录变更。

## 3. FR-030 原生环境验证矩阵

| 条目 | macOS 环境（必选） | Ubuntu 24.04 Desktop（可选） | 验证方法 | 状态 |
|------|----------------|-------------------|----------|------|
| 画布渲染（中英混排、图片、缩放平移） | macos-physical-01：操作员确认；截图含 `nihao 你好 hello world!`、图片与手绘字体正文 | 未作为 Ubuntu 安装矩阵项执行（T094 只覆盖 IME） | 启动应用绘制并检查 | macOS **通过**；Ubuntu 未覆盖 |
| 拖放（拖入图片/拖入 .excalidraw 文件） | macos-physical-01：操作员确认画布出现插入图片 | 未覆盖 | 拖放后检查画布/标签行为 | macOS **通过**；Ubuntu 未覆盖 |
| 剪贴板（复制粘贴元素与图片） | macos-physical-01：操作员确认 | 未覆盖 | 应用内与系统剪贴板往返 | macOS **通过**；Ubuntu 未覆盖 |
| 中文输入法（FR-005） | macos-physical-01：拼音 `nihao` → `你好`，中英混输不丢字 | ubuntu-vm-01：见 §6 | 拼音组合输入候选框跟随 | macOS **通过**；Ubuntu **通过**（T094） |
| 双击 .excalidraw 文件关联打开（FR-028） | `.excalidraw` UTI = `com.excalidraw.desktop.drawing` / Kind `Excalidraw Drawing`；`open` 两个测试文件均进入已运行实例。普通 `.json` 仍为 `public.json` / JSON Document，未抢占 | 未覆盖（本轮未装 GitHub amd64 deb；客机为 aarch64） | Finder / 文件管理器双击 | macOS **通过**；Ubuntu 未覆盖 |
| 应用已运行时二次打开复用实例并新开标签（FR-028） | 运行中 `open` 第二份 `.excalidraw`，进程仍为单一 pid（session.lock 与该 pid 一致） | 未覆盖 | 运行中再打开文件 | macOS **通过**；Ubuntu 未覆盖 |
| 多文件连续打开各自成为标签页 | 操作员窗口可见 `week-4` / `week-1` / `intro` / `tmp` 多个标签 | 未覆盖 | 依次打开多个文件 | macOS **通过**；Ubuntu 未覆盖 |
| 应用菜单入口与文件图标关联（FR-029） | `/Applications/excalidraw-desktop.app` 已安装；Launch Services Owner 声明 `.excalidraw` 与 `.excalidraw.json` | 本地 aarch64 二进制/AppImage 可启动；未验证 `.desktop` + MIME 安装路径 | 安装后检查 | macOS **通过**；Ubuntu 部分（仅本地二进制启动） |
| Gatekeeper 警告、手动放行说明与放行后启动 | 见下方 T078 记录 | N/A | 从 GitHub Release 同类产物安装并按 README 放行 | macOS **通过** |

## 4. macOS 验收步骤（未签名/未公证）

1. 获取产物：优先从本仓库 GitHub Releases 下载 `v*` tag 生成的 `.dmg`；若正式 tag 尚未创建，可下载同一 `release.yml` run 的 macOS artifact 做预检，但必须记录 tag/commit、来源和是否具有下载隔离属性，且不得把预检表述为真实 Release 验收。
2. 安装与启动：挂载 `.dmg`，将应用拖入“应用程序”，从 Finder 首次打开。
   - 预期：窗口出现，画布可交互；`session.lock` 正常创建，正常退出后清理。
3. 文件关联：Finder 双击 `.excalidraw` 文件。
   - 预期：应用启动并打开该文件为新标签（首开路径经 `app_handshake.pendingOpenPaths` 传递）。
   - 复检项：确认未抢占普通 `.json` 文件关联；若被抢占，将 `src-tauri/Info.plist` 的 `CFBundleTypeExtensions` 收敛为仅 `excalidraw`。
4. 单实例：应用运行中再次打开文件。
   - 预期：不启动新进程，现有窗口聚焦，文件经 `open-file-request` 事件新开标签。
5. Gatekeeper：先正常打开一次以触发系统警告；随后进入“系统设置 → 隐私与安全性”，为该应用选择“仍要打开”并确认。记录警告与放行后结果。项目不要求禁用 Gatekeeper；没有下载隔离属性而未触发警告，只能记为预检，不能证明真实下载流程。
6. 在第 2 节记录环境，包括宿主硬件、Parallels 版本、macOS/WebView、vCPU/RAM 和环境类型。

## 5. Linux 安装验证步骤（AppImage / deb / rpm）

1. 构建：`pnpm tauri build --bundles deb,rpm,appimage`（系统依赖见 `.github/workflows/release.yml`；Ubuntu 验证为可选）。
2. AppImage：`chmod +x *.AppImage && ./*.AppImage`。
   - 预期：应用菜单入口出现；桌面文件含 `MimeType=application/x-excalidraw`。
3. deb / rpm：在 Ubuntu 上执行 `sudo apt install ./excalidraw-desktop*.deb`；rpm 仅作为 best-effort 产物提供，不要求 Fedora 验收。
   - 预期：安装后 `/usr/share/mime/packages/excalidraw-desktop.xml` 存在且 `update-mime-database` 已执行（`postinst.sh`），文件管理器对 `.excalidraw` 显示应用图标并可双击打开。
4. 若执行 Ubuntu 可选验证，记录第 3 节 FR-030 smoke 结果；未执行项保持未覆盖。

## 6. Linux IME 验证矩阵（FR-005，中文输入法）

**实现状态（T103/T104 已落地，可验证）**：

- 前端 `src/editor/imeBridge.ts`：Excalidraw 隐形 textarea 的绝对坐标随画布缩放/平移实时映射，保证组合输入候选框跟随画布文本光标。
- 后端 `src-tauri/src/lib.rs` 的 `configure_linux_ime_environment()`：仅当 `GTK_IM_MODULE` 未设置时，按 `XMODIFIERS` / `QT_IM_MODULE` / `IBUS_ADDRESS` / `WAYLAND_DISPLAY` 推断并设置 `GTK_IM_MODULE`（fcitx/ibus），规避 WebKitGTK 兼容问题。

**范围**：Ubuntu 24.04 Desktop 单环境可选 smoke test；不再要求 Fedora/其他 Linux 或完整显示协议 × 输入法矩阵。

| 环境 | 会话/输入法 | 候选框跟随（缩放/平移后） | 组合事件不丢字/不重复 | 状态 |
|------|------------|--------------------------|------------------------|------|
| ubuntu-vm-01 | GNOME Wayland；ibus `libpinyin`（输入源 `xkb:us` + `ibus:libpinyin`） | 操作员确认缩放/平移后候选框仍跟随画布文本光标 | 操作员确认；截图文本 `hihao 你好 hello world!` | **通过**（2026-08-18，可选 T094） |

**验证步骤**：

1. 在 Ubuntu 24.04 Desktop 中确认当前会话与中文输入法，必要时执行 `sudo apt install fcitx5` 或 `ibus`；启用中文拼音输入法并设为系统默认输入法。
2. 构建/运行：`pnpm tauri dev` 或本地未签名构建（当前版本不需要签名即可完成本矩阵）。
3. 在画布插入文本元素并切换到中文输入法，输入拼音组合（如 "nihao"）。
   - 预期：候选框紧跟画布文本光标；缩放/平移画布后候选框仍跟随正确位置（imeBridge 坐标同步）。
4. 连续组合输入多个字符（含中文、英文混输）。
   - 预期：组合事件不丢字、不重复（FR-005）。
5. 执行一轮第 3–4 步并记录会话、输入法与结果；该步骤为可选社区证据，不阻断阶段、合并或发布。

**记录要求**：每项执行完成后把环境 ID、结果、失败复现信息（截图/日志）填回矩阵对应单元格；未执行的组合保持"待原生环境执行"，不得标记为通过。

## 7. 已知边界

- macOS 文件关联基于 `CFBundleDocumentTypes` + `UTExportedTypeDeclarations`（`src-tauri/Info.plist` 模板）；`.excalidraw.json` 属于双扩展名文件，关联行为依赖系统对 `json` 扩展的处理。2026-08-18 复检：普通 `.json` 仍为 `public.json`，未被声明为 Excalidraw Drawing。
- 项目不进行 App Store、Developer ID 签名、Apple 公证或 stapler（SC-010）；Gatekeeper 手动放行是未签名 macOS 开源分发的已知用户步骤。`spctl --assess` 对已放行应用仍报告 `rejected` / `no usable signature`，这是未签名包的预期，不能当成放行失败。
- 本轮未在 `macos-vm-01` 上重复 T078。物理机结果不得表述为未执行的 VM 覆盖。
- GitHub Release 的 Linux 包是 `amd64`（ubuntu-22.04 runner）。`ubuntu-vm-01` 是 aarch64，T094 使用客机本地 `pnpm tauri build` 的 aarch64 二进制与 AppImage，没有安装 Release 里的 deb/rpm/AppImage。Fedora/其他 Linux 未覆盖。
- VM 验收不覆盖所有物理 GPU、外设、主机厂商或驱动组合；未测试的硬件不得声称已覆盖。

## 8. T078 执行记录（macos-physical-01，2026-08-18）

1. **产物**：Chrome 从 Releases 页下载 `excalidraw-desktop_0.1.0_universal.dmg`（62 215 155 bytes）。SHA-256 `31b03b7d88ecb32580d549da3b6b3668396606a1cc803a1e5a7a0ee96dcf1081` 与 Release asset digest 一致。`com.apple.quarantine`：`0081;…;Chrome;…`。`kMDItemWhereFroms` 含 `https://github.com/ignacioli/excalidraw-desktop/releases/tag/v0.1.1`。不是 `curl`/`gh` 预检。
2. **安装与启动**：拖入 `/Applications/excalidraw-desktop.app`（universal `x86_64 arm64`，adhoc / linker-signed，无 Team ID）。应用 quarantine `01c1;…;Chrome;…`。启动后 `~/Library/Application Support/excalidraw-desktop/session.lock` 写入 `{"pid":93499,…}`；正常运行期间 lock 存在。
3. **Gatekeeper**：`spctl --assess --type execute` → `rejected` / `source=no usable signature`。操作员确认首次打开后在 **系统设置 → 隐私与安全性** 选择 **仍要打开**，之后应用可交互。未关闭 Gatekeeper。
4. **文件关联与单实例**：`open` `/tmp/t078-native/alpha.excalidraw` 与 `beta.excalidraw` 时始终只有一个 `/Applications/excalidraw-desktop.app/Contents/MacOS/excalidraw-desktop` 进程。操作员窗口可见多个已打开标签。

## 9. Feature 002 US1–US4 原生矩阵（T070，2026-08-23 部分执行）

本节是 002 必选 macOS 功能/原生矩阵。001 的 T078/T080（§2–§8，2026-08-18 `v0.1.1`）不覆盖这些 002 行为，也不得被重分类为本表结果。Ubuntu / Fedora / Windows 未跑本矩阵。浏览器 Playwright、AppleScript 合成 Cmd+W、以及 e2e-harness 的 `cmd-w-active` / 中键 / 滚轮 notch **不能**把对应行标为通过。

**环境 `macos-physical-02`（不得与 §2 的 macos-physical-01 / 001 T078 混用）**

| 字段 | 值 |
|------|-----|
| 日期 | 2026-08-23 |
| 机器 | Apple M5 Pro，48 GB，arm64 |
| OS | macOS 26.5.2 (25F84) |
| 产品 git | 工作区 `939d533`（`codex/wip-desktop-ui-interactions`）；本矩阵使用的是 T069 生产 `.app`，构建提交为 `6ea1b2e` |
| 生产应用 | `/tmp/excalidraw-t069/excalidraw-desktop.production.app` |
| 可执行文件 SHA-256 | `83d3140bff81eefa6c9a0ce7bcd485d12aae45404b8d15ae49865f92e6c4ddc6` |
| 隔离根 | `mktemp -d /tmp/excalidraw-t070.XXXXXX` → `/tmp/excalidraw-t070.gQXNq1` |
| 隔离 HOME | `/tmp/excalidraw-t070.gQXNq1/home`（仅该进程的 `HOME`/`TMPDIR`） |
| 用户生产数据 | `~/Library/Application Support/excalidraw-desktop/excalidraw-desktop.sqlite3` mtime **1787132950** / wal **1787132579** 在启动前与退出后一致；未写入该目录 |

T070 **未完成**：VoiceOver、真实 Cmd+W、中键、滚轮/触控板、Trash/Put Back、Finder 显式揭示仍为 `not_executed`。因此 **不得**把 `tasks.md` 中 T070 标为完成。

| 条目 | 故事 / 准则 | macOS 状态 | 验证方法与观察 |
|------|-------------|------------|----------------|
| 空 Directory / 干净 Drawing 进入废纸篓，并可 **Put Back** 恢复 | US1 / SC-002 | **not_executed** | 生产窗口已启动。SQLite 预置工作区后树显示「T070 Isolated」，但列出/新建失败（UI：「This location is outside the Workspace.」；`New Folder` → Create 后磁盘无新目录）。`Mount folder…` 打开了真实 NSOpenPanel（CG：880×448 面板 + 460×183 Go to Folder 层，pid 8942）。该 sheet 的 AX `buttons=0`（面板在 `com.apple.appkit.xpc.openAndSavePanelService`）；本代理无 Screen Recording，无法点选目录。未把任何条目送入废纸篓，也未执行 Put Back。 |
| **Open in Finder**（非空目录拒绝删除后的显式选择） | US1 / FR-012 | **not_executed** | 未到达非空删除阻断对话框；同上，未能在授权工作区上完成删除预检。取消/揭示均未测。 |
| VoiceOver：菜单、对话框、树行、标签关闭控件、校验错误、焦点恢复 | US1–US4 / SC-006 原生面 | **not_executed** | 系统 VoiceOver 当前为关（`voiceOverOnOffKey=0`）。本代理不能作为听语音的操作员启用 VoiceOver。 |
| 真实 **Cmd+W** 只关闭活动图纸标签；关完最后一标签后窗口与侧边栏仍在 | US3 / FR-031 | **not_executed** | 未按物理 Cmd+W，也未用 AppleScript `keystroke "w"`。附加观察（**不是**本行通过）：AX `File → Close Window` 的 `AXMenuItemCmdChar=W`、`AXMenuItemCmdModifiers=0`（系统菜单把 Cmd+W 绑在「关闭窗口」上）。退出用的是菜单 **Quit excalidraw-desktop**。 |
| 真实鼠标**中键**关闭所指标签且不必先激活 | US3 / FR-031 | **not_executed** | 无真实指针设备中键事件。 |
| 真实鼠标滚轮与触控板手势（垂直刻度切换、水平不激活、无重叠激活） | US3 / SC-008 / FR-037 | **not_executed** | 无真实滚轮刻度或触控板手势；未使用 harness notch。 |
| 侧边栏 overlay / pin / 拖拽改宽；固定态画布 ≥70% 宽；overlay 不改画布盒 | US4 / SC-009 / SC-010 | **fail** | AX 点击「Workspace sidebar」「Pin workspace sidebar」。隐藏与 overlay 时 `Drawing canvas` 均为 `@276,172 800×520`（overlay 不改画布盒）。钉住后默认 800×600 窗口：Files `280×520`，canvas `520×520` → **520/800=65% &lt; 70%**。将窗口拖到约 1166×799 后 canvas `886×719` → **886/1166≈76% ≥ 70%**。AX 树与当时的 `App.css` 均无拖拽改宽控件（钉住列 `minmax(14rem, 17.5rem)` 固定上限 17.5rem）。默认窗口宽度不满足 SC-010；无拖拽改宽。随后产品把钉住列改为 `min(17.5rem, 30%)` / 画布 `minmax(70%, 1fr)`，**尚未**用新二进制复测本行。 |
| 标题栏选择 A：标题 **Excalidraw Whiteboard**、系统着色、正常堆叠、生产非 always-on-top、无透明/覆盖式标题栏 | US4 / SC-011 / FR-045 / FR-046 | **pass** | AX 窗口名与标题栏 `AXStaticText` 均为 **Excalidraw Whiteboard**；`subrole=AXStandardWindow`；交通灯 close/minimize/fullscreen 在内容区之上（标题栏 y≈92–124，Web 内容 y=124）。`tauri.conf.json` 窗口对象仅有 `title/width/height`（无 `alwaysOnTop` / Overlay / Transparent）。CG `layer=0`。内容 Appearance：Light→Dark→Light→System 单选值切换成功。系统外观 Light→Dark→Light：窗口仍为标准标题 **Excalidraw Whiteboard**；无 Screen Recording，未对标题栏像素取样。 |
| 普通窗口被其他应用遮挡、最小化、再恢复 | US4 / SC-011 | **pass** | `open -a TextEdit` 隔离夹中的文本文件后，CG 前台序 TextEdit 在 excalidraw-desktop（pid 8942，layer 0）之上。AX 点击缩小按钮后 `optionOnScreenOnly` 不再列出 800×600 内容窗；`Window → Excalidraw Whiteboard` 后恢复 on-screen `@276,92 800×600` layer 0。 |

## 10. 浏览器 Playwright 与合成 harness 不能关闭 §9

下列路径**不能**把 §9 标为已执行或通过：

- **浏览器 Playwright**（含 `browser-ui`、Vite harness、`ui-*.spec.ts`、axe、键盘旅程）证明布局、对话框/菜单、焦点与主题独立性，不证明 Trash/Put Back、Finder 显示、VoiceOver、原生标题栏颜色/堆叠、系统 Cmd+W 路由、真实鼠标/触控板。
- **测试专用 `e2e-harness`**（`APP_E2E=1` + `EXCALIDRAW_E2E_BINARY`）用于进程级故障注入与契约探针。2026-08-23 已对 T069 harness 二进制补跑 T068 跳过的套件（30 passed / 1 skipped）。`native-tab-close` 的 `cmd-w-active` / `middle-click-inactive` / 滚轮 notch 在 harness 内合成 checkpoint/close 或刻度，**不是**用户按下的 Cmd+W、中键或触控板手势。`native-window-contract` 的配置静态检查与 harness 读 `tauri.conf.json` **不是**操作员看到的系统着色标题栏，也不是遮挡/最小化/恢复。即使跑过，仍不能替代 §9 的真机窗口管理行。
- **生产 vs harness 二进制证明**属于 T069（[validation-summary.md](./validation-summary.md) §0.4），已执行；不能用源码审查或合成 window-contract 代替该构建扫描。这仍不能关闭 T070 的真实 Cmd+W / 中键 / 触控板 / 窗口堆叠行。
- 虚拟机跑过的 001 T078/T080 或性能参考 VM **不得**写成未执行的 002 物理机覆盖。§9 执行后须新记环境 ID；物理机结果也不得反过来冒充未跑的 VM。
