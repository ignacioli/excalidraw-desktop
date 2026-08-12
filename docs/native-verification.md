# 原生壳验证记录（Native Shell Verification）

**范围**：项目通过 GitHub Releases 长期分发未签名、未公证的 macOS 产物与 Linux AppImage、deb、rpm。macOS/Linux 原生功能、安装与 IME 验收允许在记录完整配置的虚拟机或物理机中完成（FR-029/030，SC-010）。

验证证据分为三类并分开报告（quickstart §1）：Playwright 浏览器 UI、`APP_E2E=1` Tauri 进程级可靠性、本文件记录的目标 OS 原生环境矩阵。浏览器测试不得替代本文件条目；虚拟机结果不得表述为未执行的真机覆盖。

## 1. 受支持平台清单（FR-030）

| 平台 | 目标 |
|------|------|
| macOS | macOS 12+（Apple Silicon + Intel），本地未签名构建 |
| Linux | Ubuntu/Debian 系 + Fedora（X11 + Wayland），AppImage / deb / rpm |

## 2. 验收环境记录

| 环境 ID | 类型 | 宿主硬件 | 虚拟化软件/版本 | 客体 OS | vCPU/RAM | 桌面/显示协议 | 状态 |
|-----------|------|----------|---------------------|-----------|----------|-------------------|------|
| macos-vm-01 | VM | Apple M5 Pro / 48GB | Parallels Desktop Pro 26.4.1 | macOS 26.5.2 | 4 vCPU / 8GB | macOS WindowServer | 待执行 |
| ubuntu-vm-01 | VM | Apple M5 Pro / 48GB | Parallels Desktop Pro 26.4.1 | Ubuntu 24.04 Desktop | 待记录 | GNOME / X11 或 Wayland（待记录） | 待执行 |
| fedora-vm-01 | VM | 待记录 | 待记录 | Fedora KDE（版本待建立） | 待记录 | KDE / X11 或 Wayland | 待建立 |

环境记录完整后才能填写通过结果。更换宿主机、虚拟化软件版本、客体 OS/WebView、虚拟资源或显示协议时，必须新增环境 ID 或明确记录变更。

## 3. FR-030 原生环境验证矩阵

| 条目 | macOS 环境 | Linux（各发行版） | 验证方法 | 状态 |
|------|----------------|-------------------|----------|------|
| 画布渲染（中英混排、图片、缩放平移） | 需要 | 需要 | 启动应用绘制并检查 | 待原生环境执行 |
| 拖放（拖入图片/拖入 .excalidraw 文件） | 需要 | 需要 | 拖放后检查画布/标签行为 | 待原生环境执行 |
| 剪贴板（复制粘贴元素与图片） | 需要 | 需要 | 应用内与系统剪贴板往返 | 待原生环境执行 |
| 中文输入法（FR-005） | 需要 | Ubuntu GNOME + Fedora KDE × X11/Wayland × Fcitx5/IBus | 拼音组合输入候选框跟随 | 待原生环境执行 |
| 双击 .excalidraw 文件关联打开（FR-028） | 需要 | 需要 | Finder / 文件管理器双击 | 待原生环境执行 |
| 应用已运行时二次打开复用实例并新开标签（FR-028） | 需要 | 需要 | 运行中再打开文件 | 待原生环境执行 |
| 多文件连续打开各自成为标签页 | 需要 | 需要 | 依次打开多个文件 | 待原生环境执行 |
| 应用菜单入口与文件图标关联（FR-029） | 需要（Finder 图标） | 需要（.desktop + MIME） | 安装后检查 | 待原生环境执行 |
| Gatekeeper 警告、手动放行说明与放行后启动 | 需要 | N/A | 从 GitHub Release 同类产物安装并按 README 放行 | 待 macOS 环境执行 |

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

1. 构建：`pnpm tauri build --bundles deb,rpm,appimage`（系统依赖见 `.github/workflows/release.yml`）。
2. AppImage：`chmod +x *.AppImage && ./*.AppImage`。
   - 预期：应用菜单入口出现；桌面文件含 `MimeType=application/x-excalidraw`。
3. deb / rpm：`sudo apt install ./excalidraw-desktop*.deb`（Fedora 对应 `dnf install`）。
   - 预期：安装后 `/usr/share/mime/packages/excalidraw-desktop.xml` 存在且 `update-mime-database` 已执行（`postinst.sh`），文件管理器对 `.excalidraw` 显示应用图标并可双击打开。
4. 各发行版执行第 3 节 FR-030 矩阵并记录结果。

## 6. Linux IME 验证矩阵（FR-005，中文输入法）

**实现状态（T103/T104 已落地，可验证）**：

- 前端 `src/editor/imeBridge.ts`：Excalidraw 隐形 textarea 的绝对坐标随画布缩放/平移实时映射，保证组合输入候选框跟随画布文本光标。
- 后端 `src-tauri/src/lib.rs` 的 `configure_linux_ime_environment()`：仅当 `GTK_IM_MODULE` 未设置时，按 `XMODIFIERS` / `QT_IM_MODULE` / `IBUS_ADDRESS` / `WAYLAND_DISPLAY` 推断并设置 `GTK_IM_MODULE`（fcitx/ibus），规避 WebKitGTK 兼容问题。

**矩阵**：Ubuntu GNOME + Fedora KDE × X11/Wayland × Fcitx5/IBus 共 8 个组合。

| 发行版/桌面 | 会话 | 输入法 | 候选框跟随（缩放/平移后） | 组合事件不丢字/不重复 | 状态 |
|-------------|------|--------|--------------------------|------------------------|------|
| Ubuntu GNOME | X11 | Fcitx5 | — | — | 待原生环境执行 |
| Ubuntu GNOME | X11 | IBus | — | — | 待原生环境执行 |
| Ubuntu GNOME | Wayland | Fcitx5 | — | — | 待原生环境执行 |
| Ubuntu GNOME | Wayland | IBus | — | — | 待原生环境执行 |
| Fedora KDE | X11 | Fcitx5 | — | — | 待原生环境执行 |
| Fedora KDE | X11 | IBus | — | — | 待原生环境执行 |
| Fedora KDE | Wayland | Fcitx5 | — | — | 待原生环境执行 |
| Fedora KDE | Wayland | IBus | — | — | 待原生环境执行 |

**验证步骤**：

1. 安装输入法：Ubuntu 执行 `sudo apt install fcitx5` 或 `ibus`，Fedora 对应 `sudo dnf install fcitx5` 或 `ibus`；启用中文拼音输入法并设为系统默认输入法。
2. 构建/运行：`pnpm tauri dev` 或本地未签名构建（当前版本不需要签名即可完成本矩阵）。
3. 在画布插入文本元素并切换到中文输入法，输入拼音组合（如 "nihao"）。
   - 预期：候选框紧跟画布文本光标；缩放/平移画布后候选框仍跟随正确位置（imeBridge 坐标同步）。
4. 连续组合输入多个字符（含中文、英文混输）。
   - 预期：组合事件不丢字、不重复（FR-005）。
5. 在 Fcitx5 与 IBus 各执行一轮第 3–4 步，并在 X11 与 Wayland 会话各执行一轮，将结果填回上表。

**记录要求**：每项执行完成后把环境 ID、结果、失败复现信息（截图/日志）填回矩阵对应单元格；未执行的组合保持"待原生环境执行"，不得标记为通过。

## 7. 已知边界

- macOS 文件关联基于 `CFBundleDocumentTypes` + `UTExportedTypeDeclarations`（`src-tauri/Info.plist` 模板）；`.excalidraw.json` 属于双扩展名文件，关联行为依赖系统对 `json` 扩展的处理，须按第 3.3 步复检。
- 项目不进行 App Store、Developer ID 签名、Apple 公证或 stapler（SC-010）；Gatekeeper 手动放行是未签名 macOS 开源分发的已知用户步骤。
- VM 验收不覆盖所有物理 GPU、外设、主机厂商或驱动组合；未测试的硬件不得声称已覆盖。
