# 原生壳验证记录（Native Shell Verification）

**范围**：项目通过 GitHub Releases 长期分发未签名、未公证的 macOS 产物与 Linux AppImage、deb、rpm。macOS 原生功能、安装与 IME 验收是当前版本必选门禁；Ubuntu 24.04 Desktop 可选补充社区 smoke test，Fedora/其他 Linux 不形成当前版本验收要求（FR-029/030，SC-010）。

验证证据分为三类并分开报告（quickstart §1）：Playwright 浏览器 UI、`APP_E2E=1` Tauri 进程级可靠性、本文件记录的目标 OS 原生环境矩阵。浏览器测试不得替代本文件条目；虚拟机结果不得表述为未执行的真机覆盖。

**证据分层（001 历史 vs 002 待执行）**：§1–§8 与 2026-08-18 GitHub Release `v0.1.1` 矩阵是 feature 001 的 T078（Gatekeeper / 安装 / 文件关联 / 单实例）与 T080（FR-030 画布 / 拖放 / 剪贴板 / IME）物理机历史证据，不得改写或重分类为 002 结果。Feature 002 US1–US4 原生矩阵见 §9，当前全部为「尚未执行」（T070）。浏览器 Playwright 与测试专用 `e2e-harness` 合成场景不能关闭 §9 各行，见 §10。002 原生矩阵未在 Ubuntu / Fedora / Windows 上执行，也不形成那些平台的 002 验收声明。

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

## 9. Feature 002 US1–US4 原生矩阵（T070，尚未执行）

本节是 002 必选 macOS 功能/原生矩阵的**指令与待填空表**。T070 尚未执行，因此每一行都是「尚未执行」，没有通过/失败。001 的 T078/T080（§2–§8，2026-08-18 `v0.1.1`）不覆盖这些 002 行为，也不得被重分类为本表结果。Ubuntu / Fedora / Windows 未跑本矩阵。

隔离工作区与操作员步骤见本表「验证方法」列；本表只记录目标 OS 上可观察的结果。环境 ID 在实际执行 T070 时填写；未执行前不得借用 macos-physical-01 的 001 行冒充 002 覆盖。

| 条目 | 故事 / 准则 | macOS 状态 | 验证方法（T070 执行时） |
|------|-------------|------------|-------------------------|
| 空 Directory / 干净 Drawing 进入废纸篓，并可 **Put Back** 恢复 | US1 / SC-002 | **尚未执行** | 真实 Tauri 窗口删除后，在 Finder 废纸篓确认来源消失与 Put Back |
| **Open in Finder**（非空目录拒绝删除后的显式选择） | US1 / FR-012 | **尚未执行** | 操作员选择后 Finder 显示该目录；取消不得打开 |
| VoiceOver：菜单、对话框、树行、标签关闭控件、校验错误、焦点恢复 | US1–US4 / SC-006 原生面 | **尚未执行** | 系统 VoiceOver，不是 axe 或浏览器可访问名断言 |
| 真实 **Cmd+W** 只关闭活动图纸标签；关完最后一标签后窗口与侧边栏仍在 | US3 / FR-031 | **尚未执行** | 操作员按系统快捷键；见 §10 |
| 真实鼠标**中键**关闭所指标签且不必先激活 | US3 / FR-031 | **尚未执行** | 真实指针设备中键；见 §10 |
| 真实鼠标滚轮与触控板手势（垂直刻度切换、水平不激活、无重叠激活） | US3 / SC-008 / FR-037 | **尚未执行** | 真实鼠标离散滚轮 + 触控板；见 §10 |
| 侧边栏 overlay / pin / 拖拽改宽；固定态画布 ≥70% 宽；overlay 不改画布盒 | US4 / SC-009 / SC-010 | **尚未执行** | 真实窗口内指针与键盘；含支持的窗口尺寸 |
| 标题栏选择 A：标题 **Excalidraw Whiteboard**、系统着色、正常堆叠、生产非 always-on-top、无透明/覆盖式标题栏 | US4 / SC-011 / FR-045 / FR-046 | **尚未执行** | Light/Dark 系统外观 × 内容 `light`/`dark`/`system`；见 §10 |
| 普通窗口被其他应用遮挡、最小化、再恢复 | US4 / SC-011 | **尚未执行** | 操作员用真实窗口管理；测量用 always-on-top 不是生产行为 |

## 10. 浏览器 Playwright 与合成 harness 不能关闭 §9

下列路径**不能**把 §9 标为已执行或通过：

- **浏览器 Playwright**（含 `browser-ui`、Vite harness、`ui-*.spec.ts`、axe、键盘旅程）证明布局、对话框/菜单、焦点与主题独立性，不证明 Trash/Put Back、Finder 显示、VoiceOver、原生标题栏颜色/堆叠、系统 Cmd+W 路由、真实鼠标/触控板。
- **测试专用 `e2e-harness`**（`APP_E2E=1` + `EXCALIDRAW_E2E_BINARY`）用于进程级故障注入与契约探针。`native-tab-close` 的 `cmd-w-active` / `middle-click-inactive` / 滚轮 notch 在 harness 内合成 checkpoint/close 或刻度，**不是**用户按下的 Cmd+W、中键或触控板手势。`native-window-contract` 的配置静态检查与 harness 读 `tauri.conf.json` **不是**操作员看到的系统着色标题栏，也不是遮挡/最小化/恢复。该文件的 live native 用例在未配置测试二进制时 skip；即使将来跑过，仍不能替代 §9 的真机窗口管理行。
- **生产 vs harness 二进制证明**属于 T069（[validation-summary.md](./validation-summary.md) §0.1），尚未执行；不能用源码审查或合成 window-contract 代替「生产包无 always-on-top / 无 harness」的构建证据。
- 虚拟机跑过的 001 T078/T080 或性能参考 VM **不得**写成未执行的 002 物理机覆盖。§9 执行后须新记环境 ID；物理机结果也不得反过来冒充未跑的 VM。
