# Cross-platform Excalidraw-desktop deep research

# 高性能跨平台 Excalidraw 桌面应用架构设计与实现指南

## 跨平台桌面框架与已有开源仓库架构评估

在构建本地优先（Local-First）的高性能白板桌面应用时，选择合适的桌面容器技术与系统架构是决定系统资源占用、渲染流畅度与稳定性的核心。针对 macOS 与 Linux 平台，主流方案集中于 Tauri v2 与 Electron 之间的权衡，同时业界已有若干基于 Excalidraw 的桌面开源探索。

### 桌面运行框架：Tauri v2 与 Electron 的深度对比

桌面应用框架的选型直接影响应用的安装包体积、常驻内存消耗、启动速度以及跨平台渲染的一致性。Electron 通过在每个应用中打包完整的 Chromium 运行时与 Node.js 环境，提供了高度一致的渲染能力与丰富的原生 API，但其空闲内存占用通常在 120MB 至 400MB 之间，安装包体积普遍在 80MB 至 200MB 以上。这种资源开销在多窗口或轻量级工具场景下显得较为沉重。

Tauri v2 采取了不同的架构路径，其前端基于系统自带的原生 WebView（macOS 下为 WKWebView，Linux 下为 WebKitGTK），后端则采用 Rust 语言。这种设计摒弃了重型 Chromium 的打包，使构建产物体积缩减至 10MB 至 20MB，空闲内存占用大幅降低至 30MB 至 80MB，启动速度也提升了数倍。Rust 作为后端运行时，不仅提供了内存安全与高性能的系统 API 交互，还能通过强类型 IPC 通信隔离前端 Web 环境的安全风险。

| **评估维度** | **Tauri v2 (推荐)** | **Electron** |
| --- | --- | --- |
| **系统架构** | Rust Core + 系统原生 WebView (WKWebView / WebKitGTK) | Node.js Core + 打包 Chromium 运行时 |
| **安装包体积** | 约 10MB - 25MB | 约 80MB - 200MB |
| **空闲内存占用** | 约 30MB - 80MB | 约 120MB - 400MB |
| **冷启动速度** | 极其迅速 (< 1 秒) | 较慢 (1 - 3 秒) |
| **渲染引擎一致性** | 存在差异（WKWebView vs WebKitGTK） | 跨平台完全一致（统一 Chromium 版本） |
| **安全性** | 默认无 Node 暴露，细粒度 Capabilities 权限管控 | 需严格配置 Context Isolation 与 Node Integration |
| **系统级集成能力** | 高性能 Rust 原生扩展，底层文件与数据库操作极其高效 | 依托 Node.js 生态与 Native C++ 模块 |

在 macOS 和 Linux 优先的约束下，Tauri v2 表现出明显的性能优势。然而，Tauri 架构在 Linux 平台面临的主要挑战在于 WebKitGTK 的渲染引擎兼容性。由于 Linux 不同发行版的 WebKitGTK 版本、Wayland 与 X11 显示协议、GPU 驱动（NVIDIA/AMD/Intel）以及系统中文输入法（如 Fcitx5/IBus）存在差异，系统在 Canvas 绘制、CSS 滤镜以及拖拽行为上的表现可能与 macOS 端的 WKWebView 不完全一致。因此，采用 Tauri v2 必须在项目早期建立跨发行版的 WebKitGTK 验证测试。

### 现存 GitHub 开源仓库架构设计对比

分析社区中已有的 Excalidraw 桌面客户端开源实现，有助于明确可行路径并避开常见的架构陷阱。

| **仓库名称** | **技术栈选型** | **核心架构优点** | **结构性不足与改进点** |
| --- | --- | --- | --- |
| **tyrchen/excaliapp** | Tauri v2 + React 19 + TypeScript + `@excalidraw/excalidraw`
[cite: 3, 4] | 前后端分层极其清晰；安全校验扎实（路径规范化、JSON 结构校验）；支持多 Tab、演示模式及 Chromeless 无边框模式。 | 采用 30 秒全量覆盖写入（非原子落盘）；缺少外部文件变动监听；仅支持单一活动目录（无多工作区）；保存逻辑未进行高频防抖削峰。 |
| **ImGajeed76/excalidraw_desktop** | Fork 上游 `excalidraw-app` + Tauri 工具链 | 采取“最小化 Diff”策略，仅修改 Vite 构建配置，极大降低与官方上游功能的同步成本。 | 属于概念验证（PoC）性质，缺少完善的桌面文件管理系统、持久化缓存与多文档调度架构。 |
| **NineRec/excalidraw-client** | Wails (Go) / Tauri + Custom Web Bundle | 针对 CJK 中文手写字体缺失问题，利用 `fonttools` 将小赖字体与 Virgil.woff2 进行了合并打包。 | 应用功能覆盖面较窄，缺少持久化状态机、多工作区管理及完善的崩溃恢复机制。 |
| **burnt0rice/excalidraw-desktop** | Electron / Minimal Shell + Webview | 提供了离线运行 Excalidraw 的极简容器包裹。 | 缺乏文件系统管理，保存路径写死在Downloads系统目录，不具备生产级桌面应用的架构参考价值。 |

通过对比可以发现，`tyrchen/excaliapp` 提供了良好的桌面应用分层范式，但在数据持久化安全性、文件系统协同与性能削峰方面仍有提升空间；`NineRec/excalidraw-client` 则为中文手绘字体的本土化整合提供了技术解法。结合各仓库的优缺点，目标架构应在 `excaliapp` 的分层基础上，重构数据持久化层与文件管理引擎。

## 前端集成最佳实践与中文字体打包方案

为了实现与 Excalidraw 生态的无缝衔接并保障长期可维护性，前端框架应选择 React 18/19、TypeScript 与 Vite 的组合。在此基础之上，需要对官方 SDK 的集成方式及静态资源托管进行规范化设计。

### 官方 SDK 依赖与适配层设计

在集成策略上，应当坚决避免完整 Fork 上游 PWA 仓库。直接 Fork 官方前端代码虽然能获得完全的控制权，但随之带来的是难以维护的上游 Git 冲突、复杂的构建链依赖以及难以同步的安全补丁。最佳实践是将官方 `@excalidraw/excalidraw` 作为标准 npm 依赖引入。

```
src/editor/
├── ExcalidrawAdapter.ts      # 隔离官方 API 的适配器
├── ExcalidrawEditor.tsx     # 封装后的 React 画布组件
├── sceneSerializer.ts       # 画布 JSON 序列化与校验
├── exportService.ts         # PNG/SVG 导出服务
└── fontLoader.ts            # 本地字体加载与注册
```

业务代码不应直接与官方组件的 `excalidrawAPI` 强绑定，而应通过 `ExcalidrawAdapter` 统一暴露解耦后的接口。此举屏蔽了上游 SDK 版本更新引起的 breaking changes（如 API 迁移、属性更名等），确保编辑器逻辑与桌面业务逻辑（Tab 切换、文件读写、快照生成）彻底解耦。

### 静态资源本地化与托管配置

官方 `@excalidraw/excalidraw` 默认会在运行时从远程 CDN（如 `esm.run`）动态拉取字体（Virgil、Cascadia、Nunito）及 Web Worker 脚本。在离线或无网桌面环境下，这会导致字体加载失败退化为系统默认字体，影响画布呈现。

为了确保完全离线可用，构建流程中需将 `node_modules/@excalidraw/excalidraw/dist/prod/fonts` 目录下的所有资源拷贝至前端项目的 `public/fonts` 目录下。在应用入口初始化阶段，必须显式配置资产基准路径：



```TypeScript
// 必须在渲染任何 Excalidraw 组件前注入全局配置
window.EXCALIDRAW_ASSET_PATH = "/fonts/";
```

此外，在 Vite 构建配置中，需确保构建目标设置（如 `es2022`）支持 Excalidraw 内部动态导入的语法，并在 `optimizeDeps` 中妥善处理 Web Worker 与 WebAssembly 模块的依赖预构建。

### 中文手绘字体整合打包方案

Excalidraw 默认的手绘字体 `Virgil`（或升级后的 `Excalifont`）仅包含 ASCII 及西文字符集。当用户在画布中输入中文时，浏览器会退化渲染为标准的系统无衬线字体（如 PingFang SC 或 Notation），破坏了整体的手绘视觉风格。

借鉴 `NineRec/excalidraw-client` 的解决思路，最佳实施方案是利用 Python 的 `fonttools` 工具链，将开源中文手绘字体（如“小赖字体” `XiaolaiSC-Regular.ttf` 或“黄油体”）与官方 `Virgil.woff2` 进行 Unicode 字符集合并。合并的具体技术路线如下：

1. **字体解压与格式转换**：利用 `fonttools` 将 `Virgil.woff2` 解压并转换为 TTF 格式，提取其 Glyph 映射表及手绘风格度量（Metrics）参数。
2. **字符集求差与合并**：以 Virgil 作为优先字体（处理 Basic Latin 字符区），小赖字体作为补充字体（处理 CJK Unified Ideographs 字符区）。运行合并指令：
`fonttools merge Virgil.ttf XiaolaiSC-Regular.ttf --output-file=Virgil-CJK.ttf`。
3. **字形基线与度量对齐**：通过 FontForge 或 Python 脚本微调 CJK 字符的 Ascent、Descent 及 Advance Width，确保中西文混排时字形基线对齐，避免纵向错位。
4. **子集化与 WOFF2 压缩**：将合并后的 TTF 字体重新打包为高压缩率的 `Virgil-CJK.woff2`，替换 `public/fonts/Virgil.woff2`。

在应用导出 SVG 时，根据 Excalidraw 的导出规范，系统会自动将该字体以 Base64 格式嵌入 SVG 标头或通过 CSS 内联，从而保证生成的导出文件在任何设备打开均能完美保持手绘中文外观。

## 双层持久化存储架构与高频写入控制

### 全量覆盖写入模式的结构性缺陷

以 `tyrchen/excaliapp` 为代表的传统实现，普遍采用了“固定时间间隔（如 30s）触发全量文件覆盖写入”的持久化策略。分析表明，该模式存在严重的工程隐患：

- **数据丢失窗口极大**：若应用发生崩溃、段错误（Segmentation Fault）或意外断电，两次 30 秒保存节点之间的所有编辑操作将彻底丢失。
- **主线程卡顿与磁盘 IO 暴增**：在密集绘制或拖拽图元时，Excalidraw 的 `onChange` 回调会以 60fps 的频率高频触发。若直接序列化整个 Scene（包含大量 Canvas 图元及 Base64 内嵌图片）并调用系统磁盘写入，将引发严重的主线程 Jank 与 SSD 写入放大。
- **多 Tab 并发写入风暴**：当用户同时打开 10 个文档页签时，10 个独立的定时器会并发触发磁盘写入任务，导致 IPC 通信阻塞与文件系统锁竞争。
- **文件毁损风险（Corrupted File）**：若系统直接向目标 `.excalidraw` 文件执行覆盖写操作，写入过程中的意外中断将留下不完整的 JSON 结构，导致源文件不可读取。

### 热层（SQLite/redb）与冷层（原生文件）协同架构

为兼顾高频编辑的性能与数据的绝对安全，系统必须建立“热层”与“冷层”解耦的双层持久化机制。该模式是 VS Code 与 Obsidian 等现代本地优先应用的通用解法。

```
┌────────────────────────────────────────────────────────┐
│ Editor Canvas (Memory State: React / Zustand)          │
└───────────────────────────┬────────────────────────────┘
                            │ Debounced IPC (300ms)
┌───────────────────────────▼────────────────────────────┐
│ HOT STORAGE TIER (SQLite WAL / redb)                   │
│ - Durable Draft Snapshot (Order-Append Transaction)    │
│ - Instant Write / Recovery Lock                        │
└───────────────────────────┬────────────────────────────┘
                            │ Checkpoint Trigger (Idle / Exit)
┌───────────────────────────▼────────────────────────────┐
│ COLD STORAGE TIER (Canonical File System)              │
│ - Standard `.excalidraw` Document File                 │
│ - Atomic Replacement (Temp File + POSIX Rename)        │
└────────────────────────────────────────────────────────┘
```

#### 热层（Hot Tier：Durable Draft Buffer）

热层由 Rust 后端管理的嵌入式数据库实现，优先推荐采用 SQLite 开启 **WAL（Write-Ahead Logging）模式**（通过 `sqlx` 或 `rusqlite` 连接），亦可选用纯 Rust 实现的 KV 数据库 `redb`。热层不承担“可移植文档”的功能，其唯一职责是以极高的写入吞吐量承接编辑态的脏数据（Dirty State）。

在 SQLite 中建立热层草稿表：

SQL

# 

```
CREATE TABLE IF NOT EXISTS drafts (
    file_path TEXT PRIMARY KEY,
    scene_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    is_dirty INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_drafts_dirty ON drafts(is_dirty);
```

SQLite WAL 模式的写入本质上是追加顺序日志（Sequential Append），开销远低于操作系统的文件系统元数据更新，且单个事务提交具备 ACID 保证，彻底杜绝了写入中断导致数据毁损的问题。

#### 冷层（Cold Tier：Canonical OS File）

冷层即用户在文件系统（Finder/Nautilus）中可见的 `.excalidraw` 标准 JSON 文件。冷层文件是数据的终极事实来源（Single Source of Truth），具有完全的可移植性，可直接被 Git 管理、云盘同步或在第三方编辑器中打开。冷层文件的落盘遵循严格的检查点（Checkpoint）策略，不直接参与高频编辑过程。

### 高频写入的防抖节流与 Checkpoint 刷新策略

数据在内存、热层数据库与冷层文件之间的流转，由一个精确的三级计时状态机控制：

```
[编辑事件 onChange]
        │
        ├─► (Level 1) 内存更新：即时设置 is_dirty = true，UI 毫秒级响应
        │
        ├─► (Level 2) 热层落盘：300ms - 500ms Debounce 写入 SQLite Drafts 表
        │
        └─► (Level 3) 冷层落盘 Checkpoint
                 ├─ 用户主动 Cmd+S / Ctrl+S (立即执行)
                 ├─ 切换/关闭当前文档 Tab (立即执行)
                 ├─ 静置空闲 trailing debounce (最后一次编辑 3 秒后执行)
                 ├─ 应用即将退出 app_exit / window_close (阻塞式 Flush)
                 └─ 兜底机制：强制刷新上限 (Max Wait 60 秒)
```

这种策略保证了高频编辑时，系统每秒仅向 SQLite WAL 追加一次轻量级记录，系统磁盘 IO 降低 95% 以上。在关闭应用或用户主动保存时，数据才会被同步写入冷层 `.excalidraw` 文件。

## 断电防写毁与多版本崩溃恢复机制

### 原子化文件写入流水线 (Atomic File Save)

为了彻底解决覆盖写入过程中因进程强杀、断电导致的“半写文件毁损”风险，冷层文件的保存必须强制执行 POSIX 规范下的**原子化替换流水线**。Rust 后端在执行冷层写入时，绝不直接打开源文件，而是遵循以下六步操作：

```
写临时文件 (.tmp) ──► 刷入物理介质 (fsync) ──► JSON 完整性校验
                                                      │
源文件安全保留  ◄── POSIX rename() 覆盖 ◄── 父目录同步 (fsync)
```

1. **创建同卷临时文件**：在目标文件同级目录下创建临时文件（如 `document.excalidraw.tmp.10824`）。同级目录可确保临时文件与目标文件位于同一物理文件系统卷（File System Volume）内。
2. **写入数据并强制刷盘**：将热层中的 JSON 内容写入临时文件，随后调用操作系统的 `fsync()`（Rust 侧调用 `file.sync_all()`），强制要求操作系统将文件系统的页缓存（Page Cache）物理刷入 SSD 硬件介质。
3. **JSON 结构校验**：在内存中对写入的临时文件重新执行反序列化或 Base64 长度校验，确认文件无截断、JSON 语法闭合。
4. **POSIX 原子重命名**：调用系统 `rename()` 系统调用（Rust 侧调用 `std::fs::rename`），将临时文件原子性地替换为目标 `.excalidraw` 文件。在 APFS（macOS）与 ext4/btrfs（Linux）文件系统下，`rename` 为原子级指令，即便在 `rename` 发生的瞬间系统断电，文件系统也能保证要么保留完好的旧文件，要么完全替换为完好的新文件，绝不会产生“中间态”损坏文件。
5. **父目录刷盘**：调用父级目录的 `fsync()`，确保重命名元数据更新完全落盘。
6. **清理临时文件**：若过程发生异常，捕获错误并安全清理残留的 `.tmp` 文件。

### SQLite WAL Durability 配置

若将 SQLite 用于保存热层草稿与侧边栏元数据，需根据持久化优先级调整 SQLite 的 `PRAGMA` 属性：

SQL

```sql
-- 提升高频写入性能的通用配置
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

-- 根据数据安全级别设置 Synchronous 模式
-- 针对一般索引与元数据：NORMAL 模式（兼顾速度，断电可能丢失极短暂提交）
PRAGMA synchronous = NORMAL;

-- 针对关键断电恢复数据：使用独立连接并在提交时执行 FULL
PRAGMA synchronous = FULL;
```

采用“数据库存热层草稿，文件系统存冷层文档”的设计策略，即便 SQLite 在极端断电下丢失了最后 0.1 秒的日志，磁盘上的冷层文档依然完好无损。

### 多版本轮换崩溃恢复系统

除了单文件级别的写保护，系统还需要具备应用级别的**异常退出检测与多版本恢复机制**。

```
~/Library/Application Support/AppName/recovery/ (macOS)
~/.local/share/AppName/recovery/ (Linux)
└── doc-hash-id/
    ├── recovery-001.json
    ├── recovery-002.json
    └── recovery-003.json
```

#### 会话锁（Session Lock）监控

应用启动时，Rust 后端在 App 专属数据目录下创建 `session.lock` 锁文件，并写入当前进程 PID 与启动时间戳。当应用正常退出时，清理该锁文件。若启动时检测到 `session.lock` 依然存在，说明上一次运行发生了崩溃、Segmentation Fault 或强行关机。

#### 恢复快照轮换机制（Recovery Snapshot Rotation）

在热层写入的同时，系统按照固定周期（或特定操作节点）在系统 Temp/Recovery 目录写入快照。为防止快照本身损坏，为每个文档维护 3 至 5 个轮换快照文件（如 `recovery-001.json` 至 `recovery-005.json`），采用 Ring Buffer 模式循环覆盖。每个快照包含完整 Schema 元数据：



```json
{
  "documentId": "uuid-v4-string",
  "originalPath": "/Users/user/Projects/architecture.excalidraw",
  "baseFileHash": "sha256-hash-of-cold-file",
  "savedAt": 1720000000,
  "appVersion": "1.2.0",
  "scene": { "elements": [...], "appState": {...} }
}
```

#### 恢复对话框与冲突消解

启动阶段若触发崩溃恢复逻辑，系统比较快照中的 `savedAt` 时间戳、`baseFileHash` 与冷层磁盘文件当前的 `mtime`/`hash`。若快照内容更新，弹框提示用户：“检测到未保存的历史草稿（保存于 2 分钟前），是否恢复？”，并提供“恢复为新文件”、“覆盖旧文件”或“丢弃草稿”的操作选项。

## 左侧文件管理与多工作区系统

文件系统管理器是本地优先应用的核心组成部分。简陋的侧边栏往往只能浏览单一固定目录，无法应对复杂工程中的多工作区与外部文件同步问题。

### 多工作区（Multi-Workspace）索引架构

系统应支持同时挂载多个“工作区目录”（Workspace Directories）。SQLite 建立 `workspaces` 与 `file_index` 表，由 Rust 后端在后台线程进行异步扫描与增量索引更新：

 

```sql
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS file_index (
    canonical_path TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    mtime INTEGER NOT NULL,
    file_size INTEGER NOT NULL,
    content_hash TEXT,
    thumbnail_blob BLOB,
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
```

扫描过程严格在 Rust 后端异步线程（Tokio ThreadPool）中运行，避免阻塞 WebView 主线程。目录扫描时执行路径规范化（Canonicalization），杜绝符号链接（Symbolic Link）死循环与 `../` 路径穿越注入。

### 外部文件变更监听与乐观并发冲突处理

当用户使用 Git 切换分支、通过 iCloud/Dropbox 同步、或同时用第三方编辑器修改 `.excalidraw` 文件时，应用必须具备实时感知能力。

#### 增量文件监听（Rust `notify` Crate）

利用 Rust 的 `notify` 库（基于 macOS `FSEvents` 与 Linux `inotify`）对所有已打开的工作区根目录建立递归事件监听。为了防止文件系统高频刷屏导致的事件风暴（Event Storm），Rust 侧需对 `notify` 事件进行 **Debounce 节流**（例如 200ms 内的多条 Write 事件合并为一条），随后通过 Tauri 事件总线（`app_handle.emit()`）推送到前端。

#### 乐观并发控制与冲突消解机制

当监听到某个当前正在打开的文件在外部被修改时，系统使用三元组 `(mtime, file_size, content_hash)` 进行并发校验：

```
                              ┌───────────────────────────┐
                              │ 外部文件变更 (notify)     │
                              └─────────────┬─────────────┘
                                            │
                                  ┌─────────┴─────────┐
                                  ▼                   ▼
                           [当前 Tab 无内存修改]  [当前 Tab 存在未保存修改]
                                  │                   │
                                  ▼                   ▼
                           自动重新加载最新文件  触发冲突警告状态弹窗
                                                      │
                                    ┌─────────────────┼─────────────────┐
                                    ▼                 ▼                 ▼
                               [覆盖本地草稿]    [保留本地草稿]      [另存为新文件]
```

这种机制参考了 VS Code 处理外部变更的工程范式，确保任何情况下都不会静默覆盖用户的本地编辑成果。

### 侧边栏 UI 渲染优化

当工作区包含数万个文件时，直接在 DOM 树中渲染完整的树形节点会导致 DOM 数量过载，造成内存暴涨与滚动卡顿。

1. **按需懒加载（Lazy Directory Loading）**：前端默认仅渲染第一层目录结构，仅当用户展开文件夹节点时，才向 Rust 后端发出 `list_directory` IPC 请求。
2. DOM 虚拟滚动（DOM Virtualization）：在展开节点较多的树形结构中，集成 `react-window` 或 `tanstack-virtual`，仅渲染可视区域内的 30-50 个文件节点，使得千级文件树的滚动帧率恒定在 60fps。

## 大画布渲染与系统资源削峰优化

Excalidraw 绘图引擎核心基于 Canvas 与 `rough.js` 绘制，其性能瓶颈主要集中于大型图元场景下的 JSON 序列化开销、内存占用以及 IPC 跨进程传输。

### 画布编辑态的 IPC 传输削峰

在传统的错误设计中，Excalidraw 的 `onChange` 回调被触发时，前端会将包含数万个 Element 的完整 Scene 结构序列化为 JSON 字符串，并通过 Tauri IPC 传递给 Rust 后端。当场景中包含大量手绘线条或 Base64 图片时，这种操作会导致主线程严重掉帧。

优化路线如下：

- **高频频次下仅做内存标记**：`onChange` 回调触发时，仅更新前端 Zustand Store 中的内存状态并标记 `isDirty = true`，**绝对不发起 IPC 传输**。
- **低频批量传输 JSON**：只有在 300ms 防抖计时器到期、触发热层数据库保存时，前端才通过 `JSON.stringify()` 生成 JSON，并通过 Tauri 命令传至 Rust 侧。
- **增量 Element 比较（可选高阶优化）**：若场景极大，前端可记录上一次提交的 Element Version 映射表，IPC 仅传输改变或新增的 Element 增量数组，由 Rust 侧合并更新。

### 缩略图异步队列生成与 SQLite 缓存

在文件侧边栏中展示图纸缩略图能极大提升用户体验，但频繁渲染缩略图也是造成 CPU 与 GPU 资源耗尽的主要元凶。

```
[侧边栏可视节点变更]
        │
        ▼
[检查 SQLite file_meta 缓存] ──── (缓存命中) ───► 立即返回 WebP Blob 渲染
        │
    (未命中)
        ▼
[推入低优先级 Worker 渲染队列] (同时仅运行 1-2 个并发任务)
        │
        ▼
[调用 OffscreenCanvas / exportToBlob] ───► 生成 320x200 WebP
        │
        ▼
[写入磁盘缓存 & SQLite file_meta 表]
```

1. **严格的懒生成策略**：仅当文件节点滚动进入侧边栏的当前可视区域（Viewport）时，才触发缩略图生成请求。
2. **后台 Web Worker 异步渲染**：在前端启动独立的 Web Worker，利用 `OffscreenCanvas` 或 Excalidraw 的 `exportToBlob` 工具函数在后台线程将 scene JSON 转化为小尺寸（如 320×200）的 WebP 格式图片。
3. **内容寻址缓存键（Content-Addressable Key）**：
缓存 Key 计算公式：`CacheKey = SHA256(file_content + renderer_version + theme)`。
缩略图以 WebP 文件存储在本地缓存目录（如 `cache/thumbnails/a1/b2/a1b2c3....webp`），元数据记录于 SQLite 的 `file_meta` 表。若文件内容未发生改变，下次打开应用直接读取本地 WebP 缓存，零 CPU 开销。

### 图片资源去重与存储管理

Excalidraw 允许用户将外部图片拖入画布，默认情况下这些图片会被转换为 Base64 编码并直接内嵌在 `.excalidraw` 文件 JSON 的 `files` 字典中。若用户在画布中复制粘贴同一张 10MB 的高清图片 10 次，文档体积会迅速膨胀至 100MB，导致内存卡顿与序列化灾难。

#### 内容寻址解耦（Content-Addressable Storage）

在应用内部存储模型中，提取所有内嵌图片数据，计算其二进制 SHA-256 哈希值。将图片实体剥离并统一存放在工作区的 `.excalidraw_assets/<hash>.png` 资产目录中。文档 JSON 内仅保留哈希引用。

#### 前端 Asset 协议加载

在渲染包含图片的画布时，避免将图片重新 Base64 化注入 JSON，而是利用 Tauri 2 的安全资产协议（`convertFileSrc` / `asset://` 协议）直接让 WebView 异步加载本地磁盘图片。这种做法极大地减轻了内存拷贝压力。冷层导出标准 `.excalidraw` 文件时，再根据需求重新将资产打包为符合官方规范的 JSON，保障文件兼容性。

## 成熟桌面应用核心能力与增强功能

要构建一个成熟、可靠的桌面应用，除了核心编辑器与持久化功能外，还需要在系统集成、安全边界与打包分发等方面进行深度定制。

### 单实例锁与文件关联协议 (Single-Instance & File Associations)

#### 单实例运行（Single-Instance）

集成 `tauri-plugin-single-instance` 插件。当应用已经在后台运行，用户再次通过系统终端运行应用或在 Finder/Nautilus 中双击打开新的 `.excalidraw` 文件时，不会启动新的进程，而是将参数（目标文件路径）发送至已存在的应用主实例，主实例自动创建新的 Tab 页签并聚焦窗口。

#### 系统级文件关联配置

注册 `.excalidraw`、`.excalidraw.json` 及 `.excalidrawlib` 文件后缀。

- **macOS 配置**：在 `tauri.conf.json` 的 `bundle.macOS.frameworks` 及 `Info.plist` 模板中配置 `CFBundleDocumentTypes`，指定应用为 `.excalidraw` 文件的默认打开者，并设置对应的文件图标资产。
- **Linux 配置**：生成标准的 MIME 类型定义文件（`application/x-excalidraw`）及 `.desktop` 快捷方式，确保 Ubuntu (GNOME) / Fedora (KDE) 的文件管理器能够正确关联图标与双击唤起。

### CJK IME 输入法与输入桥接适配

在 Linux（WebKitGTK）与 macOS（WKWebView）环境下，内嵌 Canvas 画布上的富文本输入框常遭遇系统级输入法（IME）定位错位、合成事件（`compositionstart` / `compositionend`）被吞或选词框漂移的问题。

1. **不可见输入框定位同步**：Excalidraw 文本编辑组件在画布上使用了一个隐形的 `<textarea>` 来接收 IME 输入。系统需确保该隐藏 Input 的绝对坐标（Left/Top）严格随画布缩放与平移参数进行实时的 CSS Transform 映射，使系统 IME 选词框准确悬浮于用户当前点击的文字下方。
2. **WebKitGTK IME 模式强制修正**：针对 Linux 环境下 Fcitx5 的兼容性问题，在 Tauri 启动的 C 代码入口强制设置环境变量 `GTK_IM_MODULE=fcitx` 或 `wayland`，规避 WebKitGTK 无法调起原生输入法上下文的漏洞。

### 安全隔离与权限控制 (Tauri Capabilities & CSP)

生产环境的桌面应用必须实施最小权限原则，防止恶意 `.excalidraw` JSON 脚本注入攻击。

#### Tauri 2 Capabilities 细粒度管控

弃用 Tauri v1 时代的全局 `all-permissions`，在 `src-tauri/capabilities/default.json` 中定义严格的 ACL 权限。限制前端仅能访问用户已打开的工作区目录，拒绝访问系统敏感路径（如 `/etc`、`~/.ssh` 或 `/System`）：



```JSON
{
  "$schema": "../gen/schemas/desktop-capability.json",
  "identifier": "main-capability",
  "description": "Restricts filesystem operations to active workspaces",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "fs:allow-app-write-scope",
    "dialog:allow-open",
    "dialog:allow-save"
  ]
}
```

#### 内容安全策略（CSP）与路径规范化

- **严格 CSP 配置**：在 `tauri.conf.json` 中配置 CSP：
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' asset: https: blob: data:;`。
禁止应用从外部 CDN 动态加载任何未经过构建时hash校验的 JS 脚本，防止 XSS 攻击。
- **路径穿越防护**：所有由前端传递至 Rust 后端的文件路径，在执行读写操作前必须通过 Rust 的 `std::fs::canonicalize` 函数进行规范化，校验其根路径是否包含于合法的工作区路径白名单中，坚决拦截 `../` 路径穿越攻击。

### 打包、代码签名与跨平台分发

针对目标平台的打包与分发管道设计如下：

#### macOS 平台

- **Universal Binary 构建**：由于当前 macOS 存在 M 系列 Apple Silicon (arm64) 与 Intel (x86_64) 两种架构，构建流水线应支持 Universal Binary 打包（利用 `lipo` 工具将两个架构的编译产物合并为单一二进制文件），确保在旧款 Intel Mac 与 Apple Silicon 上均能原生高效运行。
- **开发者代码签名与公证（Signing & Notarization）**：集成 Apple Developer ID 证书，在 CI/CD 中调用 `codesign` 对 `.app` 及内部的 Frameworks 执行深度签名。打包后自动调用 Apple 的 `xcrun notarytool` 提交公证，并执行 `stapler` 贴纸注入，避免用户打开应用时触发“应用已损坏，无法打开”的 macOS Gateway 拦截。产物输出格式为 `.dmg` 与 `.app.tar.gz`（用于 Tauri Auto-Updater 自动更新）。

#### Linux 平台

针对不同 Linux 发行版的生态碎片化，同步产出以下包格式：

- **AppImage**：包含独立依赖的自包含单文件，是 Linux 平台分发的首选，适配绝大多数主流发行版。
- **deb / rpm**：分别针对 Ubuntu/Debian 与 Fedora/RHEL 生态的 native 包，自动注册系统包管理器依赖与桌面菜单入口。

## 架构规划、测试体系与演进路线图

### 项目代码目录结构规范

构建高可维护性的代码仓库，需要在前端与 Rust 后端之间建立清晰的模块边界。

```
excalidraw-desktop/
├── src/                        # 前端 React 应用代码
│   ├── app/                    # 界面布局与全局 Context
│   ├── editor/                 # Excalidraw 封装与适配器
│   │   ├── ExcalidrawAdapter.ts
│   │   ├── ExcalidrawEditor.tsx
│   │   ├── exportService.ts
│   │   └── fontLoader.ts
│   ├── documents/              # 双层持久化调度器
│   │   ├── documentStore.ts
│   │   ├── draftScheduler.ts
│   │   ├── conflictDetector.ts
│   │   └── recoveryManager.ts
│   ├── sidebar/                # 虚拟化文件树 UI
│   ├── workspaces/             # 工作区管理
│   └── ipc/                    # 强类型 Tauri IPC 客户端 bindings
│
├── src-tauri/                  # Rust 原生后端代码
│   ├── src/
│   │   ├── commands/           # Tauri IPC 命令入口
│   │   ├── documents/          # 原子文件读写与落盘逻辑
│   │   │   ├── atomic_write.rs
│   │   │   ├── recovery.rs
│   │   │   └── validation.rs
│   │   ├── database/           # SQLite / redb 数据库 ORM 与 Migration
│   │   ├── indexing/           # 工作区异步文件索引引擎
│   │   ├── watcher/            # notify 增量文件监听系统
│   │   ├── thumbnails/         # 缩略图后台生成与缓存处理
│   │   ├── security/           # 路径规范化与 ACL 校验
│   │   └── main.rs             # 应用入口与生命周期 Hook
│   ├── capabilities/           # Tauri 2 权限声明文件
│   └── migrations/             # SQLite 数据库 Schema 迁移脚本
│
├── e2e/                        # Playwright / Appium 桌面端自动化测试套件
└── specs/                      # 技术架构规格文档与 Schema 定义 [cite: 1, 3]
```

### 质量保证与故障注入测试体系 (Fault Injection Testing)

为确保数据安全达到生产级标准，仅有单元测试是不够的，必须引入针对文件系统的**故障注入自动化测试**。

#### 自动化单元与集成测试

- **前端（Vitest + React Testing Library）**：测试 Debounce 调度器状态机、Tab 切换时的脏状态标记、JSON 序列化解析性能。
- **后端（Rust `cargo test`）**：重点测试 `atomic_write` 在并发下的稳定性、路径规范化白名单过滤、SQLite Migration 升级防报错机制。

#### 桌面端 E2E 与故障注入套件

集成 Playwright 测试套件，构建带有 `APP_E2E=1` 环境变量的测试专用 Build。测试 Harness 提供硬件故障模拟接口：

```
                    [E2E 自动化测试 Harness (Playwright)]
                                     │
      ┌──────────────────────────────┼──────────────────────────────┐
      ▼                              ▼                              ▼
[场景 1：保存中强杀]           [场景 2：外部写冲突]           [场景 3：恢复快照校验]
在物理写磁盘中间态            修改正在打开的文件              制造损坏冷层文件，
模拟 SIGKILL 进程强杀 ──►      mtime 与 Hash ────────►        验证应用启动时 ──►
校验原文件完好无损     验证冲突弹窗唤起      唤起 Recovery UI
```

通过自动化故障注入测试，确保系统在磁盘空间不足、写入中断、系统强制关机等极端环境下，均能百分之百保证用户原始绘图数据的安全。

### 阶段性演进路线图 (Development Roadmap)

项目的开发应划分为四个递进阶段，优先攻克技术风险最高的底层持久化与跨平台渲染兼容性：

```
Phase 0：概念验证与风险排查 (PoC - Weeks 1-2)
  ├── 完成 Tauri v2 + React + @excalidraw/excalidraw 在 macOS 及 Linux (WebKitGTK) 上的原型搭建
  ├── 验证 10,000+ 巨型图元场景下的帧率表现与内存开销
  └── 完成中文手绘字体 (Virgil + 小赖字体) 的合并与离线打包加载 [cite: 1, 2, 5]

Phase 1：最小可行产品 (MVP - Weeks 3-6)
  ├── 实现单工作区文件管理侧边栏（新建、重命名、删除、打开）
  ├── 构建 SQLite 热层与冷层 `.excalidraw` 文件的双层持久化机制
  ├── 实现基础原子写（.tmp + rename）与手动/定时保存
  └── 支持基础 PNG/SVG 资产导出

Phase 2：生产级可靠性与稳定性增强 (Reliability - Weeks 7-10)
  ├── 引入 `notify` 监听文件变动，建立乐观并发冲突检测与消解机制
  ├── 实现 Session Lock 与多版本轮换崩溃恢复系统
  ├── 实现单实例运行模式与 `.excalidraw` 系统文件关联
  └── 建立集成故障注入的端到端（E2E）自动化测试套件

Phase 3：体验极致化与成熟度提升 (Productization - Weeks 11-14)
  ├── 实现多工作区（Multi-Workspace）管理与后台增量文件索引
  ├── 引入侧边栏虚拟列表与 Web Worker 低优先级缩略图异步生成队列
  ├── 完成 CJK 输入法（IME）在 WebKitGTK 上的定位微调与优化
  └── 完成 macOS 代码签名/公证及 Linux AppImage/deb/rpm 打包发布流水线
```

通过按照上述规范实施，项目将成功吸取现有开源仓库的分层设计优点，并从根本上解决 30 秒定时覆盖写、缺乏原子落盘、缺乏外部变动感知 及单工作区限制等硬伤，最终构建出一个符合生产级工程标准的高性能、低消耗、极高可靠性的 Excalidraw 跨平台桌面应用。