# Quickstart & Validation Guide: 跨平台 Excalidraw Desktop

**Date**: 2026-08-04 | **Plan**: [plan.md](./plan.md) | **契约**: [contracts/ipc-contracts.md](./contracts/ipc-contracts.md)

本文件是端到端验证指南：环境前提、构建运行命令、按用户故事组织的验证场景与预期结果。实现细节见 tasks.md 与源码，此处不重复。

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

### US2 崩溃恢复与原子写（P1，故障注入）

1. **保存中强杀**：`APP_E2E=1` 构建下 Harness 在原子写 fsync 与 rename 之间注入 `SIGKILL` → 重启。
   - 预期：目标文件为完整旧版本（JSON 可解析）；恢复对话框出现，草稿恢复后内容等于强杀前最后编辑（SC-003/004）。
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

1. 中英混排画布导出 PNG（2x/透明底）与 SVG → 在未装字体的环境（容器/干净虚机）打开 SVG。
   - 预期：手绘字体自包含、视觉一致（SC-009）；PNG 尺寸=画布×倍率。
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
| 冷启动 | E2E 计时：进程启动 → 画布可编辑 | ≤2s（SC-002） |
| 空载内存 | 启动稳定后 RSS 采样 | ≤150MB（SC-002） |
| 大场景帧率 | 10k 图元 fixture + 平移/缩放脚本，帧时间采样 | ≥30fps，目标 60（SC-005） |
| 写盘削峰 | 60s 连续绘制脚本 + 写系统调用计数 | 写次数 ≤ 事件数 1%（SC-006） |

夹具结果输出 JSON 报告，CI 存档对比历史基线；性能回归 = 缺陷（宪法原则 IV）。

## 5. 中文 IME 验证（Linux 矩阵真机项）

拼音输入组合中：候选框紧随画布文本光标（含缩放/平移后）；组合事件不丢字、不重复（FR-005）。在 Fcitx5 与 IBus 各验证一次并记录矩阵结果。
