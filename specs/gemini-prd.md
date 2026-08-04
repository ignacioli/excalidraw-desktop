# Excalidraw Desktop (Local-First) 产品需求与工程规格文档 (PRD)

Excalidraw Desktop (Local-First) 产品需求与工程规格文档 (PRD)

## 0. 项目概述与性能指标 (Overview & NFR Targets)

本产品是一个基于 **Tauri v2 + React 19 + Rust** 的本地优先（Local-First）高性能 Excalidraw 白板与文档管理桌面应用。应用优先适配 **macOS (Apple Silicon / Intel Universal)** 和 **Linux (X11 / Wayland)** 平台。

### 核心非功能性指标 (Non-Functional Requirements)

- **冷启动时间**：< 1.0 秒（主窗口首次渲染到完全可交互）。
- **空闲内存占用**：< 80 MB（单主窗口静置状态）。
- **编辑态磁盘 IO**：高频绘制或拖拽时，物理磁盘写入频率限制在每秒 < 1 次（依托热层防抖缓存）。
- **数据安全性**：零数据丢失。遭遇应用强杀、段错误或物理断电后，可完整恢复最后 300 ms 内的状态，且冷层 `.excalidraw` 文件绝不毁损截断。

## 1. 项目背景与动机 (Background & Motivation)

Excalidraw 是全球最优秀的手绘风格白板工具之一。尽管其 Web/PWA 版本功能强大，但作为“本地优先”的知识生产工具，纯 Web 模式存在以下天然局限：

- **数据受制于浏览器**：Web 存储（`localStorage`/`IndexedDB`）存在被浏览器清理的隐患，且无法方便地与 Finder/Nautilus 本地文件系统、Git 仓库或个人云盘同步。
- **本地文件系统体验缺失**：缺乏原生的目录管理边栏，无法双击 `.excalidraw` 文件直接唤起应用，多文档管理繁琐。
- **离线与本地资源能力受限**：手绘字体默认依赖远程 CDN，无网或内网环境下会出现中西文字体退化，且缺乏断电/崩溃恢复机制。

构建一个**轻量级（低内存/低 CPU）、高可靠（零数据丢失）、完美支持本地文件系统与中文手绘体验**的桌面客户端，具有极高的工程落地价值。

## 2. 核心痛点与解决方案 (Pain Points & Solutions)

| **痛点维度** | **具体表现与危害** | **本项目工程解决方案** |
| --- | --- | --- |
| **高频写入卡顿与 IO 暴增** | 拖拽图元时 `onChange` 以 60fps 触发，直接写磁盘引发主线程 Jank 与 SSD 写放大。 | 实施 **SQLite WAL 热层防抖缓存**，物理磁盘写入 IO 降低 95% 以上。 |
| **文件覆盖写毁损风险** | 覆盖写（非原子写）在保存瞬间遭遇强杀或断电，会导致 JSON 文件截断损坏。 | 实施 **POSIX 原子化 Save 管道**（写同卷 `.tmp` 文件 + `fsync` + `rename` 覆盖）。 |
| **崩溃无感知与数据丢失** | 定时保存间隔（如 30 秒）内发生崩溃，期间绘制彻底丢失，且无自动恢复 UI。 | 建立 **Session Lock + 多版本轮换快照恢复系统**。 |
| **外部变动静默覆盖** | 在 Git 切分支或云盘同步时，应用不知磁盘文件已变，容易静默覆盖外部改动。 | 基于 **`notify` 增量监听与乐观并发冲突对账 UI**。 |
| **中文字体视觉退化** | 输入中文时手绘字体退化为标准系统无衬线体，破坏手绘风格。 | 打包 **Virgil 与小赖字体合并的 CJK 离线手绘字体**。 |

## 3. 开源竞品分析与核心增强 (Competitive Highlights)

对比 GitHub 现有同类开源项目，本项目的架构选型与优化策略如下：

- **相比 `tyrchen/excaliapp`**：借鉴其极清晰的 React/Tauri/Rust 分层结构与路径安全白名单校验。**核心增强**：淘汰其“30 秒定时全量覆盖写”模式，解决多 Tab 编辑下的写入风暴，补齐原子落盘、外部文件变动监听与多工作区支持。
- **相比 `ImGajeed76/excalidraw_desktop`**：借鉴其将 `@excalidraw/excalidraw` 作为标准 npm 依赖引入的隔离思路。**核心增强**：补充完整的本地文件索引、缩略图 Worker 缓存与崩溃恢复状态机。
- **相比 `NineRec/excalidraw-client`**：借鉴其利用 `fonttools` 合并小赖字体与 Virgil.woff2 解决中文手绘体缺失的技术路线。**核心增强**：将字体打包融入生产级双层持久化与桌面文件系统框架中。
- **相比 `burnt0rice/excalidraw-desktop`**：避开其保存路径写死在 Downloads 目录的粗暴处理，构建真正的虚拟化文件边栏与多工作区支持。

## 4. User Stories & 验收标准 (User Stories & Acceptance Criteria)

### US-1: 高频绘制不卡顿与实时热保存

- **As a** 绘图用户，
- **I want** 在画布上密集绘制、拖拽大量元素时界面保持 60fps 顺畅，
- **So that** 我的高频编辑能即时保存在本地，且不会造成系统掉帧或磁盘卡顿。
- **Acceptance Criteria (验收标准)**：
    1. 拖拽元素触发 `onChange` 时，前端仅更新 Zustand 内存状态（`isDirty = true`），不得触发物理磁盘写入。
    2. 停止操作 300 ms 后，自动将场景 JSON 写入 SQLite `drafts` 表（热层）。
    3. 冷层 `.excalidraw` 物理磁盘文件更新仅在按 `Cmd+S`、切换 Tab 或停笔静置 3 秒后执行。

### US-2: 意外崩溃与断电后的静默恢复

- **As a** 用户，
- **I want** 应用发生段错误崩溃或电脑意外断电重启后，
- **So that** 我能完整恢复崩溃前最后几百毫秒内的未保存草稿，且源文件绝不会损坏。
- **Acceptance Criteria (验收标准)**：
    1. 冷层文件写操作必须严格包含同卷 `.tmp` 写入、`file.sync_all()` 和 POSIX `rename` 三步。
    2. 启动时若存在 `session.lock` 且草稿表/快照目录中存在未刷盘数据，必须唤起 Recovery 对话框。
    3. 点击“恢复”后准确回填画布，并保持磁盘原文件为备份状态。

### US-3: 外部文件变更与乐观冲突提示

- **As a** 使用 Git 或云盘同步白板文件的开发者，
- **I want** 当磁盘上的 `.excalidraw` 文件在外部被修改（如 Git 切换分支）时得到感知，
- **So that** 我不会无意中静默覆盖外部的修改，造成内容冲突。
- **Acceptance Criteria (验收标准)**：
    1. Rust 后端通过 `notify` 监听工作区，当文件发生 `Write`/`Rename` 事件时推送到前端。
    2. 若当前 Tab 无未保存内存修改，自动静默刷新画布为外部最新版本。
    3. 若当前 Tab 有未保存修改，弹窗拦截并提供：[覆盖本地草稿]、[加载外部版本]、[另存为新文件] 三种消解选项。

### US-4: 离线中文手绘体验

- **As a** 中文用户，
- **I want** 在断网环境下输入中文文本，
- **So that** 文字能呈现与西文一致的手绘风格，且导出 SVG 时字符不乱码。
- **Acceptance Criteria (验收标准)**：
    1. 静态资产通过 `window.EXCALIDRAW_ASSET_PATH = "/fonts/"` 本地加载，离线无网络报错。
    2. CJK 字符区自动渲染为合并打包后的手绘字体，中西文混排基线对齐。
    3. 导出的 SVG 文件标头内嵌 Base64 字体，移至其他设备打开仍保持中文手绘视觉。

## 5. 技术栈与依赖规范 (Tech Stack & Dependencies)

### 后端 (Tauri v2 / Rust)

- **Framework**: Tauri `v2.x`
- **Database**: `sqlx` (SQLite driver) 开启 WAL 模式
- **File Watcher**: `notify` `v6.x` + `notify-debouncer-full`
- **Serialization**: `serde`, `serde_json`
- **Async Runtime**: `tokio`

### 前端 (WebView / TS)

- **UI Framework**: React `19.x` + TypeScript `5.x`
- **Build Tool**: Vite `7.x`
- **Editor Core**: `@excalidraw/excalidraw` (标准 npm 依赖包，禁用 CDN 远程拉取)
- **State Management**: Zustand `v5.x`
- **Styling**: Tailwind CSS + `shadcn/ui`
- **Virtualization**: `@tanstack/react-virtual`

## 6. 规范目录结构 (Project Directory Structure)

```
excalidraw-desktop/
├── src/
│   ├── app/                    # 页面布局、Tab 栏、全局 Context
│   ├── editor/                 # Excalidraw 封装与适配层
│   │   ├── ExcalidrawAdapter.ts# 隔离官方 SDK 的接口适配器
│   │   ├── ExcalidrawEditor.tsx# Canvas 渲染组件
│   │   ├── exportService.ts    # PNG/SVG 本地导出
│   │   └── fontLoader.ts       # 本地字体注入配置
│   ├── documents/              # 前端持久化状态机
│   │   ├── documentStore.ts    # Zustand 文档 Tab 与草稿状态
│   │   ├── draftScheduler.ts   # 300ms Debounce & Flush 调度器
│   │   └── conflictResolver.ts # 外部文件变更冲突处理 UI
│   ├── sidebar/                # 虚拟化文件树与工作区组件
│   └── ipc/                    # 强类型 Tauri Command 调用封装
├── src-tauri/
│   ├── capabilities/           # Tauri 2 ACL 权限定义文件
│   ├── migrations/             # SQLite 数据库 DDL 脚本
│   └── src/
│       ├── commands/           # Tauri Command Handler (IPC)
│       ├── documents/          # 原子保存 (.tmp + rename) 与恢复逻辑
│       ├── database/           # SQLite 连接池与 CRUD 接口
│       ├── watcher/            # notify 目录监听与事件 Debouncer
│       └── main.rs             # 应用入口与 Single-Instance 插件注册
```

## 7. 数据库 Schema (SQLite DDL)

SQLite 数据库用于管理应用元数据与热层草稿，文件放置于系统 `AppDataDir` 目录下的 `metadata.db`。

```sql
-- 工作区表
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);

-- 文件索引与缩略图缓存表
CREATE TABLE IF NOT EXISTS file_index (
    canonical_path TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    mtime INTEGER NOT NULL,
    file_size INTEGER NOT NULL,
    content_hash TEXT,
    thumbnail_blob BLOB,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- 热层持久化草稿表 (Hot Tier Drafts)
CREATE TABLE IF NOT EXISTS drafts (
    file_path TEXT PRIMARY KEY,
    scene_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    is_dirty INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_drafts_dirty ON drafts(is_dirty);
```

## 8. 核心工程规格与逻辑实现流程

### 8.1 双层持久化架构 (Two-Tier Persistence Pipeline)

不得采用传统的 30 秒全量定时覆盖写磁盘文件模式。必须执行三级持久化流转：

1. **内存层 (Immediate)**：拖拽绘制触发 `onChange` 时，仅更新 Zustand 内存 State，设置 `is_dirty = true` (0 ms)。
2. **热层 (Debounce 300ms)**：300 ms 防抖后，将 scene_json 写入 SQLite `drafts` 表 (WAL 追加写)。
3. **冷层 Checkpoint (Atomic Save)**：刷新到磁盘 `.excalidraw` 原生文件。

#### 冷层落盘 Checkpoint 触发条件：

- 用户按下 `Cmd+S` / `Ctrl+S`
- 切换当前编辑的 Document Tab 或关闭 Tab
- 停笔静置 3 秒后（Trailing Debounce）
- 监听 `app_exit` 或 `window_close` 事件前强制阻塞刷新（Sync Flush）
- 脏数据持续存在达到 60 秒上限（Max Wait 60s 兜底）

### 8.2 原子化文件替换流水线 (Atomic File Save Pipeline)

写冷层 `.excalidraw` 磁盘文件时，Rust 后端**严格禁止**直接对源文件执行 `std::fs::write` 覆盖写。必须按顺序执行以下 POSIX 原子操作：

1. **创建同卷临时文件**：在目标文件相同目录下创建 `.filename.excalidraw.tmp.<PID>`。
2. **数据刷盘**：写入 JSON 字符流后调用 `file.sync_all()` (执行系统 `fsync`)。
3. **结构校验**：反序列化校验临时文件 JSON 的语法完整性（防止截断）。
4. **POSIX 替换**：调用 `std::fs::rename(tmp_path, target_path)` 原子覆盖目标文件。
5. **父目录刷盘**：打开父级目录并调用 `dir.sync_all()` 保存目录元数据。

### 8.3 异常崩溃恢复系统 (Crash Recovery System)

1. **Session Lock 监控**：应用启动时在 `AppDataDir` 下创建 `session.lock`，正常退出时销毁。若启动时存在 `session.lock`，判定上一次运行发生了非正常崩溃。
2. **多版本快照轮换 (Ring Buffer)**：在 `AppDataDir/recovery/<file_hash_id>/` 下保留最多 5 个快照文件 (`recovery-001.json` ~ `recovery-005.json`)。
3. **恢复判定逻辑**：崩溃后重启时，校验恢复快照的 `savedAt` 时间戳是否晚于磁盘文件的 `mtime`。若晚于，前端唤起恢复对话框，提供“恢复为当前草稿”、“另存为副本”和“丢弃草稿”选项。

### 8.4 CJK 中文字体本地化与离线打包 (Font Integration)

1. **资源本地化**：构建脚本中将 `node_modules/@excalidraw/excalidraw/dist/prod/fonts` 拷贝至 `public/fonts`。在前端入口（`main.tsx`）首行显式配置：
    
    ```tsx
    window.EXCALIDRAW_ASSET_PATH = "/fonts/";
    ```
    
2. **CJK 手绘字体合并**：采用 `fonttools` 将“小赖字体 (`XiaolaiSC-Regular.ttf`)”补全至 `Virgil.woff2` 中处理 Unicode `0x4E00` - `0x9FFF` 字符区，替换 `public/fonts/Virgil.woff2`。

### 8.5 文件监听与乐观并发冲突对账 (File Watcher & Conflict Resolution)

1. **Notify 增量监听**：Rust 后端启动 `notify::RecommendedWatcher` 监听工作区目录，设置 200 ms 事件 Debounce。
2. **冲突对账校验**：当监听到磁盘文件变化，比较三元组 `(mtime, file_size, content_hash)`。
    - **若当前 Tab 无未保存内存修改**：前端自动静默载入最新文件。
    - **若当前 Tab 存在未保存内存修改**：弹窗拦截，显示“外部文件已变更”冲突 UI，由用户决定保留本地草稿或加载外部改动。

### 8.6 缩略图异步队列与缓存 (Thumbnail Queue & Optimization)

1. **内容寻址 Key**：`Key = SHA256(scene_json + "v1")`。
2. **懒加载与 Web Worker**：仅当文件节点滚动进入侧边栏 Viewport 时触发请求。使用 Web Worker 调用 `OffscreenCanvas` 将图纸渲染为 320x200 的 WebP Blob，写入 SQLite `file_index.thumbnail_blob` 缓存字段。

## 9. Tauri IPC 通信 Command 接口规范

Coding Agent 在实现 Rust 与 TypeScript 桥接时，必须严格遵守以下 API 签名：

```rust
// src-tauri/src/commands/document.rs

// 1. 读取本地文档 (读取冷层，自动比对热层草稿)
#[tauri::command]
pub async fn read_document(path: String) -> Result<DocumentPayload, String>;

// 2. 提交热层草稿 (防抖高频调用)
#[tauri::command]
pub async fn save_draft(path: String, scene_json: String) -> Result<(), String>;

// 3. 触发冷层原子落盘 (Checkpoint)
#[tauri::command]
pub async fn flush_to_disk(path: String) -> Result<FlushResult, String>;

// 4. 工作区扫描与增量索引
#[tauri::command]
pub async fn scan_workspace(root_path: String) -> Result<Vec<FileMeta>, String>;

// 5. 崩溃恢复检查
#[tauri::command]
pub async fn check_crash_recovery() -> Result<Vec<RecoveryItem>, String>;
```

## 10. AI Coding Agent 分阶段开发路线图 (Implementation Steps)

请 Coding Agent 按照以下任务链分阶段逐步生成与重构代码：

### Task 1: 项目骨架与平台验证 (PoC)

- 使用 Vite + React 19 + TypeScript + Tauri v2 建立项目结构。
- 安装 `@excalidraw/excalidraw` 并配置 `EXCALIDRAW_ASSET_PATH` 静态资源托管。
- 实现 `ExcalidrawAdapter` 解耦组件。

### Task 2: Rust 底层文件系统与原子保存 (Core IO)

- 在 Rust 侧实现 `atomic_write` 模块（含临时文件写、`fsync`、校验与 `rename`）。
- 实现带有路径规范化与白名单校验的安全校验函数。

### Task 3: SQLite 热层与双层持久化调度器 (Persistence)

- 配置 SQLite WAL 数据库连接池与 Migration 脚本。
- 实现前端 `draftScheduler`（300 ms Debounce 存 SQLite 热层；3 秒拖尾 Debounce / `Cmd+S` 刷盘至冷层文件）。

### Task 4: 崩溃恢复与 Session Lock (Reliability)

- 实现启动阶段 `session.lock` 创建与销毁逻辑。
- 实现轮换快照保存机制与启动时的草稿恢复对话框。

### Task 5: 文件系统监听与冲突处理 UI (Integration)

- 在 Rust 侧集成 `notify` 并建立 200 ms 事件节流推送。
- 前端实现乐观并发冲突 UI 对账组件。

### Task 6: 虚拟化文件树与缩略图 Worker (Performance)

- 集成 `@tanstack/react-virtual` 构建虚拟化侧边栏文件树。
- 实现基于 Web Worker 的异步缩略图渲染引擎与 SQLite Blob 缓存。