# Quickstart & Validation Guide: 跨平台 Excalidraw Desktop

**Date**: 2026-08-04 | **Last updated**: 2026-08-10 | **Plan**: [plan.md](./plan.md) | **设计契约**: [../../DESIGN.md](../../DESIGN.md) | **IPC 契约**: [contracts/ipc-contracts.md](./contracts/ipc-contracts.md)

本文件是端到端验证指南：环境前提、构建运行命令、按用户故事组织的验证场景与预期结果。实现细节见 tasks.md 与源码，此处不重复。

验证证据分为三类并分别报告：Playwright 浏览器 UI（交互/a11y/视觉）、`APP_E2E=1` Tauri 进程级可靠性（进程/文件系统/恢复）和 macOS/Linux 原生平台矩阵（窗口/IME/文件关联/签名/安装）。浏览器测试不得替代后两类。

## 1. 环境前提

| 平台 | 要求 |
|------|------|
| 通用 | Node.js 20+、pnpm（锁定为唯一包管理器）、Rust stable 1.80+（rustup）、Python 3.10+（仅构建期字体合并，需 `pip install fonttools brotli`） |
| macOS | Xcode Command Line Tools；签名/公证验证需 Developer ID 证书（无证书时跳过该项并报告缺口） |
| Linux | `libwebkit2gtk-4.1-dev`、`libgtk-3-dev` 等 Tauri 2 系统依赖；验证矩阵：Ubuntu GNOME + Fedora KDE × X11/Wayland × Fcitx5/IBus |

## 2. 构建与运行

```bash
pnpm install                 # 前端依赖
pnpm fonts:build             # 构建期合并 Virgil-CJK 字体（scripts/，产出 public/fonts/）
pnpm tauri dev               # 开发运行
pnpm tauri build             # 生产打包（dmg / AppImage / deb / rpm）

# 质量门禁（CI 同款）
pnpm lint && pnpm typecheck && pnpm test          # 前端
cargo fmt --check && cargo clippy -- -D warnings && cargo test   # 后端（src-tauri/）
APP_E2E=1 pnpm e2e           # Playwright 桌面 E2E（测试专用构建，暴露故障注入 Harness）
```

> 命令名为目标约定；Phase 0 任务落地脚本后，以 `package.json` 实际值为准并同步更新本文件与 `AGENTS.md`。

## 3. 验证场景（按用户故事）

### US1 离线创建/编辑/保存（P1）

1. 断开网络 → 启动应用 → 新建图纸，绘制图形 + 中文文本 + 拖入图片。
   - 预期：全功能可用；中文呈手绘字体（无系统字体回退）；DevTools Network 零外部请求。
2. `Cmd/Ctrl+S` 保存 → 关闭应用 → 重新打开该文件。
   - 预期：内容一致；文件可被官方 excalidraw.com 正常导入（SC-001/FR-002）。
3. 检查主窗口内容区。
   - 预期：使用系统原生装饰窗口；顶部为文档标签、左侧为文件管理（未挂载工作区时显示可操作空状态）、右侧为画布；没有浏览器/PWA 顶栏或账号、Excalidraw+、协作与云服务入口（FR-034）。
4. 依次选择浅色、深色、跟随系统；在跟随系统时切换操作系统外观，再分别以三种偏好重启应用。
   - 预期：壳层与画布始终同步；仅跟随系统响应运行中系统变化；重启首个可交互画面无相反主题闪现；浅色/深色截图基线 `maxDiffPixelRatio <= 0.001`（FR-035/036、SC-014）。
5. 注入未知 `themeId`、未知模式和损坏的版本化外观偏好后启动。
   - 预期：安全回退为跟随系统，应用正常进入可交互状态，已打开或保存的 `.excalidraw` 内容没有变化（FR-036/037）。
6. 在浅色与深色模式分别只使用键盘操作标签、文件管理空状态、外观选择和文件对话框，并启用系统减少动态效果。
   - 预期：键盘闭环与焦点顺序正确，焦点始终可见，状态不只依赖颜色，非必要动画被移除或减弱；WCAG 2.2 AA 适用对比度通过，自动化扫描严重/致命问题均为 0（FR-038/SC-015）。

### US2 崩溃恢复与原子写（P1，故障注入）

1. **保存中强杀**：`APP_E2E=1` 构建下对 `temp_created`、`mid_write`、`temp_synced`、`json_validated`、`before_rename`、`after_rename`、`before_parent_sync`、`parent_synced` 八个原子写故障点逐点注入 `SIGKILL` → 重启。PR 全点确定性执行；固定机夜间任务额外运行并记录 100 个随机 seed。
   - 预期：每个故障点的目标文件均为可解析的完整旧版本或完整新版本；无静默覆盖；恢复对话框出现且草稿恢复后内容符合最后持久化窗口（SC-003/004/012）。生产构建中 Harness 接口不存在。
2. **快照自损**：Harness 破坏最新 `recovery-00N.json` → 触发恢复。
   - 预期：自动回退次新快照并提示实际恢复时间点。
3. **正常退出**：编辑后正常退出 → 重启。
   - 预期：无恢复弹窗；内容已落盘。

### US3 工作区侧边栏（P2）

1. 挂载含多级子目录的目录 → 浏览/新建/重命名/删除/多标签打开。
   - 预期：文件系统真实同步；标签页跟随更名；删除进回收站；各标签撤销历史独立（FR-016/017）。
2. 万级文件工作区（fixture 生成）滚动与展开。
   - 预期：滚动 ≥50fps（性能夹具采样）；内存不随文件总量线性增长（SC-007）。
3. 构造 `../` 越界路径调用 `dir_list`。
   - 预期：返回 `PATH_ACCESS_DENIED`（FR-031）。

### US4 外部变更与冲突（P2，故障注入）

1. 应用内文档无修改 → 外部编辑器改写该文件。
   - 预期：3s 内自动重载 + 轻提示（SC-008）。
2. 应用内有未保存修改 → 外部改写。
   - 预期：冲突弹窗（三选项），决策前目标文件零写入；三个选项行为符合 FR-019。
3. 外部删除打开中的文件。
   - 预期：标签页失联标示 + 引导另存（FR-020）。
4. 脚本 1s 内写文件 20 次（模拟云盘风暴）。
   - 预期：事件合并，无弹窗轰炸（FR-018）。

### US5 导出（P3）

1. 中英混排画布导出 PNG（2x/透明底）与 SVG → 在固定无字体干净环境打开 SVG。
   - 预期：SVG 内嵌 WOFF2 且无字体回退；Playwright 固定截图基线 `maxDiffPixelRatio <= 0.001`（SC-009）；PNG 尺寸=画布×倍率。
2. 导出到只读目录。
   - 预期：明确错误提示，无残留半成品文件（FR-027）。

### US6 系统集成（P3，原生壳验证——浏览器不可证明，需真机）

1. 安装正式包 → Finder/文件管理器双击 `.excalidraw`。
   - 预期：应用启动并打开该文件；应用已运行时复用实例新开标签（FR-028）。
2. macOS 全新系统安装启动。
   - 预期：无 Gatekeeper 拦截（需签名+公证，SC-010）。
3. Linux 各发行版安装 AppImage/deb/rpm。
   - 预期：应用菜单入口 + 文件图标关联生效。

### US7 多工作区与缩略图（P3）

1. 挂载两个工作区 → 并列展示、独立移除（不删磁盘文件）。
2. 滚动文件列表 → 缩略图仅对可视节点生成；重启后二次进入直接缓存命中（`thumb_lookup.hit=true`，零重复生成）。
3. 同一 10MB 图片粘贴 10 次 → 保存。
   - 预期：文档体积增幅 ≤5%（SC-011，资产去重）。

## 4. 性能夹具（SC 回归基线）

| 指标 | 夹具 | 阈值 |
|------|------|------|
| 冷启动 | 清空应用测试数据，执行 10 次冷进程启动；单调时钟记录进程启动 → 画布可编辑并计算 P95 | ≤2s（SC-002） |
| 空载内存 | 启动稳定 30s 后采样 60s，聚合 Tauri 主进程及关联 WebView/GPU 进程树 RSS P95 | ≤150MB（SC-002） |
| 空闲 CPU | 同一稳定窗口采样应用进程树 CPU P95，按单逻辑核归一化 | ≤1% 单逻辑核（SC-013） |
| 大场景帧率/内存 | 10k 图元固定 fixture + 平移/缩放脚本，采集帧时间与场景稳定后的进程树 RSS | ≥30fps、目标 60fps、无 >100ms 冻结、RSS ≤350MB（SC-005/013） |
| 写盘削峰 | 60s 连续绘制脚本 + 应用管理路径写入计数 | 写次数 ≤事件数 1%，且无持久化掉帧尖峰（SC-006） |
| 长时稳定性 | 热身后脚本编辑 30min，对比进程树 RSS；再静置 60s 观察 CPU 与应用管理路径/工作区写入 | RSS 增长同时 ≤50MB 且 ≤15%；空闲 CPU ≤1%；零持续写入（SC-013） |

绝对预算只在固定 Apple M1 / 8GB runner 上作为合并硬门禁执行，runner 标签为 `self-hosted`、`macOS`、`ARM64`、`excalidraw-perf`；Intel Mac 与 Linux 仅记录非阻断趋势。首次报告锁定准确的 macOS 与 WebView 版本。硬件、OS 或 WebView 变化使原基线失效，必须以测量证据与 ADR 重建，禁止静默放宽预算。

夹具输出 JSON 报告，包含 schema 版本、commit、硬件型号、内存、准确 OS/WebView 版本、样本、统计量、预算与 verdict，不得包含机器唯一标识或秘密。聚合口径必须覆盖 Tauri 主进程和关联 WebView/GPU 进程，并在报告中写明任何无法归属的排除项；性能回归 = 缺陷（宪法原则 IV）。

## 5. 中文 IME 验证（Linux 矩阵真机项）

拼音输入组合中：候选框紧随画布文本光标（含缩放/平移后）；组合事件不丢字、不重复（FR-005）。在 Fcitx5 与 IBus 各验证一次并记录矩阵结果。

## 6. 验证证据汇总与统一门禁

Phase 10 起，全量回归结果、三类验证证据（浏览器 UI、`APP_E2E=1` 进程级可靠性、真机矩阵）与各 SC 门禁状态统一记录于 `docs/validation-summary.md`，本文件不再重复明细。

**SC-012 统一可靠性阻断门禁**：以下三套故障测试合并为合并阻断门禁，任一失败即阻止合并，且不允许以本文件外的单套件结果替代：

1. `e2e/tests/us2-kill-during-save.spec.ts`（T037）：原子写八个故障点逐点 SIGKILL，目标文件必须为完整旧/新版本且恢复 UI 正确；
2. `e2e/tests/us2-snapshot-corruption.spec.ts`（T045）：快照自损回退次新并提示实际恢复时间点；
3. `e2e/tests/us4-external-changes.spec.ts`（T066）：外部变更自动重载/冲突/失联另存，决策前零写入。

执行方式：`APP_E2E=1 pnpm e2e` 且 `EXCALIDRAW_E2E_BINARY` 指向故障注入测试构建（生产构建无 Harness 接口）。

**固定机性能门禁**：T090/T108 的绝对预算仅在 `self-hosted`/`macOS`/`ARM64`/`excalidraw-perf` runner 上作为合并硬门禁（T091）；其他硬件产出仅归档非阻断趋势，不得替代硬验收。

**范围记录**：正式 macOS 签名、公证与零安全拦截分发为后续版本（SC-010）；当前版本 macOS 验证止于本地未签名构建。
