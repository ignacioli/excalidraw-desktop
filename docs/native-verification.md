# 原生壳验证记录（Native Shell Verification）

**范围**：当前版本仅要求本地构建（未签名/未公证）完成 macOS 启动、文件关联、单实例与原生行为验证；正式 macOS 签名、公证与零安全拦截分发属于后续版本（FR-029 / SC-010 out of scope）。Linux 以 AppImage、deb、rpm 安装包验证应用菜单入口与文件图标关联（FR-029）。

验证证据分为三类并分开报告（quickstart §1）：Playwright 浏览器 UI、`APP_E2E=1` Tauri 进程级可靠性、本文件记录的真机原生矩阵。浏览器测试不得替代本文件条目。

## 1. 受支持平台清单（FR-030）

| 平台 | 目标 |
|------|------|
| macOS | macOS 12+（Apple Silicon + Intel），本地未签名构建 |
| Linux | Ubuntu/Debian 系 + Fedora（X11 + Wayland），AppImage / deb / rpm |

## 2. FR-030 真机验证矩阵

| 条目 | macOS 本地构建 | Linux（各发行版） | 验证方法 | 状态 |
|------|----------------|-------------------|----------|------|
| 画布渲染（中英混排、图片、缩放平移） | 需要 | 需要 | 启动应用绘制并检查 | 待真机执行 |
| 拖放（拖入图片/拖入 .excalidraw 文件） | 需要 | 需要 | 拖放后检查画布/标签行为 | 待真机执行 |
| 剪贴板（复制粘贴元素与图片） | 需要 | 需要 | 应用内与系统剪贴板往返 | 待真机执行 |
| 中文输入法（FR-005） | 需要 | Ubuntu GNOME + Fedora KDE × X11/Wayland × Fcitx5/IBus | 拼音组合输入候选框跟随 | 待真机执行 |
| 双击 .excalidraw 文件关联打开（FR-028） | 需要 | 需要 | Finder / 文件管理器双击 | 待真机执行 |
| 应用已运行时二次打开复用实例并新开标签（FR-028） | 需要 | 需要 | 运行中再打开文件 | 待真机执行 |
| 多文件连续打开各自成为标签页 | 需要 | 需要 | 依次打开多个文件 | 待真机执行 |
| 应用菜单入口与文件图标关联（FR-029） | 需要（Finder 图标） | 需要（.desktop + MIME） | 安装后检查 | 待真机执行 |
| 全新系统安装启动无 Gatekeeper 拦截 | 后续版本（需签名+公证） | N/A | — | out of scope |

## 3. macOS 本地验证步骤（当前版本，未签名）

1. 构建：`pnpm tauri build`，产物位于 `src-tauri/target/release/bundle/macos/excalidraw-desktop.app`（Universal 流水线见 `.github/workflows/release.yml`）。
2. 启动：直接运行 `open src-tauri/target/release/bundle/macos/excalidraw-desktop.app`。
   - 预期：窗口出现，画布可交互；`session.lock` 正常创建，正常退出后清理。
3. 文件关联：Finder 双击 `.excalidraw` 文件。
   - 预期：应用启动并打开该文件为新标签（首开路径经 `app_handshake.pendingOpenPaths` 传递）。
   - 复检项：确认未抢占普通 `.json` 文件关联；若被抢占，将 `src-tauri/Info.plist` 的 `CFBundleTypeExtensions` 收敛为仅 `excalidraw`。
4. 单实例：应用运行中再次打开文件。
   - 预期：不启动新进程，现有窗口聚焦，文件经 `open-file-request` 事件新开标签。
5. Gatekeeper：首次运行未签名构建时允许手动放行（右键 → 打开）；该手动放行仅为本地验证，正式分发走签名+公证（后续版本）。
6. 记录本机环境：macOS 版本、WebView（WKWebView/Safari）版本、Apple Silicon 或 Intel。

## 4. Linux 安装验证步骤（AppImage / deb / rpm）

1. 构建：`pnpm tauri build --bundles deb,rpm,appimage`（系统依赖见 `.github/workflows/release.yml`）。
2. AppImage：`chmod +x *.AppImage && ./*.AppImage`。
   - 预期：应用菜单入口出现；桌面文件含 `MimeType=application/x-excalidraw`。
3. deb / rpm：`sudo apt install ./excalidraw-desktop*.deb`（Fedora 对应 `dnf install`）。
   - 预期：安装后 `/usr/share/mime/packages/excalidraw-desktop.xml` 存在且 `update-mime-database` 已执行（`postinst.sh`），文件管理器对 `.excalidraw` 显示应用图标并可双击打开。
4. 各发行版执行第 2 节 FR-030 矩阵并记录结果。

## 5. 已知边界

- macOS 文件关联基于 `CFBundleDocumentTypes` + `UTExportedTypeDeclarations`（`src-tauri/Info.plist` 模板）；`.excalidraw.json` 属于双扩展名文件，关联行为依赖系统对 `json` 扩展的处理，须按第 3.3 步复检。
- 当前版本不进行 Developer ID 签名、公证、stapler 与零拦截验收（SC-010）；后续版本接入 `.github/workflows/release.yml` 的签名步骤后更新本文件。
