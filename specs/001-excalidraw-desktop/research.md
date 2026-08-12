# Research & Decisions: 跨平台 Excalidraw Desktop

**Date**: 2026-08-04 | **Plan**: [plan.md](./plan.md) | **依据**: [Cross-platform-Excalidraw-desktop-deep-research.md](../Cross-platform-Excalidraw-desktop-deep-research.md)、社区实现调研（tyrchen/excaliapp、ImGajeed76/excalidraw_desktop、NineRec/excalidraw-client、burnt0rice/excalidraw-desktop）

本文件是 Phase 0 决策记录（ADR 集）。每项按 Decision / Rationale / Alternatives considered 组织。Technical Context 无遗留 NEEDS CLARIFICATION。

---

## R1. 桌面框架

- **Decision**: Tauri 2.x（Rust Core + 系统 WebView：macOS WKWebView / Linux WebKitGTK）。
- **Rationale**: 性能预算约束——SC-002/013 要求声明的 macOS 参考环境中空载应用进程树 RSS ≤150MB、冷启动 P95 ≤2s、空闲 CPU P95 ≤单逻辑核 1%，并约束大场景与长时内存增长。Tauri 空载 30–80MB、启动 <1s、包体 10–25MB 的研究量级为预算留有余量；Electron 空载 120–400MB、包体 80–200MB，存在直接击穿预算的高风险。可靠性核心能力（原子写、SQLite、文件监听、路径 ACL）在 Rust 侧实现最稳健，且 Tauri 2 Capabilities 提供默认最小权限的安全模型；最终结论以声明的参考环境完整实测为准。
- **Alternatives considered**:
  - **Electron**：渲染一致性最好、生态最全，但资源开销与启动速度不满足 SC；安全模型需手工加固。
  - **Wails (Go)**：NineRec 路线；Go 后端可行，但 Tauri 的权限模型、插件生态（single-instance、updater）与社区规模更适合生产级目标。
- **风险与对冲**: WebKitGTK 在 Linux 的碎片化（发行版版本、Wayland/X11、GPU 驱动、IME）→ 当前版本仅保留 Ubuntu 24.04 Desktop 可选 smoke test，Fedora/其他 Linux 与完整显示协议/输入法矩阵移出当前门禁，失败项记录为社区兼容性边界。

## R2. 热层存储：SQLite first，redb 触发式重构

- **Decision**: SQLite（WAL 模式，rusqlite bundled）承载全部热层数据：drafts（草稿）、workspaces、file_index、file_meta。PRAGMA 基线：`journal_mode=WAL; busy_timeout=5000; foreign_keys=ON; synchronous=NORMAL`（草稿关键提交路径可用独立连接 `synchronous=FULL`）。
- **Rationale**: 用户已确认 SQLite 先行。WAL 追加写满足 300ms 防抖下的草稿吞吐并具备 ACID；file_index/file_meta 需要索引查询与 JOIN，SQL 直接支持；bundled 编译无系统依赖；工具链（CLI 检修、迁移）成熟。冷层文件是最终事实来源，即使 WAL 极端断电丢失最后 0.1s 提交，用户文件依然完好——热层数据安全等级要求可适当放宽。
- **Alternatives considered**: **redb**（纯 Rust KV）——写路径简洁、无 C 依赖，但需自建二级索引，生态不成熟。保留为备选。
- **redb 重构触发条件**（满足任一且有实测数据，另立 ADR 评估）:
  1. 草稿写 P99 > 50ms 且无法通过 checkpoint/synchronous 调优解决；
  2. 多文档并发下单连接锁竞争实测阻塞 UI 关键路径；
  3. bundled SQLite 在目标平台出现构建/分发障碍。
- **重构保险**: `database/` 模块以仓储 trait 为唯一访问入口，上层不感知具体存储实现。

## R3. Excalidraw 集成策略

- **Decision**: `@excalidraw/excalidraw` npm 正式版锁定引入；业务代码仅通过 `src/editor/ExcalidrawAdapter.ts` 访问官方 API；静态资源（字体、Worker）构建期拷贝至 `public/fonts/` 并注入 `window.EXCALIDRAW_ASSET_PATH = "/fonts/"`。
- **Rationale**: Fork 上游 `excalidraw-app`（ImGajeed76 路线）带来持续的 Git 冲突、构建链耦合与安全补丁滞后；npm 依赖 + 适配层将 breaking changes 的影响面收敛到单文件。资源本地化是 FR-004/SC-001（完全离线）的必要条件——官方默认从 CDN 拉取字体。
- **Alternatives considered**: Fork 上游 PWA 仓库（完全控制权，维护成本不可接受）；运行时代理 CDN 请求（引入网络依赖与 CSP 冲突）。

## R4. Rust SQLite 绑定

- **Decision**: rusqlite（`bundled` feature），数据库操作经专用写线程/`spawn_blocking` 队列化。
- **Rationale**: 嵌入式单文件库的访问模式（低并发、批量小事务）不需要 async 连接池；rusqlite API 直接映射 SQLite 语义，便于精确控制 PRAGMA 与事务边界。
- **Alternatives considered**: **sqlx**（async + 编译期 SQL 校验）——收益集中在网络数据库场景，代价是依赖面大、构建慢；**diesel**——ORM 抽象超出需求。

## R5. 冷层原子写

- **Decision**: 六步流水线：同卷 `.tmp` 创建 → 写入 + `sync_all()`（fsync）→ 重读反序列化校验 JSON 完整性 → `std::fs::rename` 原子替换 → 父目录 fsync → 异常路径清理 `.tmp`。
- **Rationale**: APFS/ext4/btrfs 下 rename 原子性保证文件要么旧完整、要么新完整（SC-003 损坏率 0 的唯一可靠实现）；同卷要求排除跨卷 rename 退化为 copy 的风险；写后校验拦截截断。
- **故障验证边界**: `APP_E2E=1` 测试构建在 `temp_created`、`mid_write`、`temp_synced`、`json_validated`、`before_rename`、`after_rename`、`before_parent_sync`、`parent_synced` 八个可观察点提供确定性中断；生产构建不得编译或注册 Harness。每个 PR 全点执行；声明的维护者环境可额外运行 100 个记录 seed 的随机用例。
- **Alternatives considered**: 直接覆盖写（tyrchen/excaliapp 30s 全量覆盖模式——半写损坏窗口，被研究文档明确否定）；写前备份副本（双倍 IO 且不解决写入中断原子性）。

## R6. 崩溃恢复机制

- **Decision**: 会话锁（应用数据目录 `session.lock`，含 PID + 启动时间戳，正常退出清理）判定异常退出；每文档 3–5 份 Ring Buffer 轮换恢复快照（含 documentId、originalPath、baseFileHash、savedAt、appVersion、完整 scene）；启动时以 `savedAt > cold mtime` 和 scene 差异识别普通未保存草稿，并以 `baseFileHash` 与冷层 hash 的差异识别外部替换；冷层缺失或不可读时保留候选并引导另存。
- **Rationale**: 满足 FR-012/013 与 SC-004（≤5s 恢复窗口）；多版本轮换对冲快照自身损坏（Edge Case）；scene 差异避免漏掉从同一冷层版本产生的普通未保存草稿，baseFileHash 比对则避免把外部替换后的过期草稿静默恢复到原文件。
- **Alternatives considered**: 单快照（快照损坏即全失）；事件日志重放（实现复杂度高，Excalidraw scene 全量体量可控，无必要）。

## R7. 外部变更监听与冲突消解

- **Decision**: `notify` crate（macOS FSEvents / Linux inotify）对工作区根递归监听；后端 200ms 事件合并去抖；以 `(mtime, size, content_hash)` 三元组校验真实变更并抑制自身写入回声；经事件总线推送前端，按 isDirty 分流"自动重载"或"三选项冲突弹窗"。
- **Rationale**: FR-018/019 与 SC-008（3s 感知、零静默覆盖）；三元组避免 mtime 单独比对的误报；回声抑制（记录自身写入产生的 hash）防止保存后自触发冲突。参照 VS Code 外部变更处理范式。
- **Alternatives considered**: 前端定时轮询（延迟与 CPU 开销）；仅 mtime 比对（云盘同步场景误报率高）。

## R8. 前端状态管理

- **Decision**: zustand。编辑态（scene 引用、isDirty、选中 Tab）、标签页registry、保存调度器状态置于独立 store。
- **Rationale**: onChange 以 60fps 触发，需要 O(1) 的无渲染订阅更新；zustand 的 transient update 适配；无样板代码。
- **Alternatives considered**: Redux Toolkit（样板与中间件开销）；React Context（高频更新导致级联渲染）；jotai（可行，团队采用 zustand 与研究文档一致）。

## R9. 文件树虚拟化

- **Decision**: @tanstack/react-virtual + 目录懒加载（展开时 `list_directory` IPC）。
- **Rationale**: SC-007（万级文件 ≥50fps）要求 DOM 数量与文件总量解耦；懒加载避免启动时全树扫描。
- **Alternatives considered**: react-window（能力相当，tanstack-virtual 的动态尺寸与 API 灵活性更好）；全量渲染（DOM 过载，被否）。

## R10. CJK 手绘字体

- **Decision**: 构建期 Python fonttools 管线：Virgil/Excalifont woff2 → TTF → 与小赖字体（SIL OFL）`fonttools merge`（西文优先、CJK 补充）→ 基线/度量对齐微调 → 子集化压缩为 `Virgil-CJK.woff2` 替换 `public/fonts/`。脚本入库 `scripts/`，产物入库或 CI 生成。
- **Rationale**: FR-004 + SC-009——运行时中文回退系统字体破坏手绘风格；SVG 导出时 Excalidraw 自动内嵌字体，合并字体保证导出自包含。NineRec 已验证该路线可行。
- **Alternatives considered**: 运行时多字体 fallback 链（导出 SVG 不自包含、双字体度量不齐）；商业手写字体（许可证不允许再分发）。

## R11. 缩略图生成

- **Decision**: 前端专用 Web Worker + OffscreenCanvas（复用 `exportToBlob`）生成 320×200 WebP；懒触发（进入可视区）+ 1–2 并发上限低优先级队列；缓存键 `SHA256(file_content + renderer_version + theme)`，WebP 存本地缓存目录、元数据入 SQLite file_meta。
- **Rationale**: FR-022 + SC-007；渲染必须复用 Excalidraw 前端渲染器（rough.js 手绘风格无法在 Rust 侧低成本复刻）；内容寻址保证零重复生成。
- **Alternatives considered**: Rust 侧 headless 渲染（需嵌入 JS 引擎或复刻渲染器，成本过高）；打开时同步生成（阻塞 UI）。

## R12. 图片资产去重

- **Decision**: 应用内部存储将内嵌图片按二进制 SHA-256 剥离至工作区 `.excalidraw_assets/<hash>` 目录，文档 JSON 持哈希引用；画布经 Tauri `convertFileSrc`/asset 协议异步加载；对外保存/导出时重新内嵌为官方自包含格式。
- **Rationale**: SC-011（重复 10 次体积增幅 ≤5%）；Base64 内嵌在重复大图场景导致文档膨胀与序列化灾难；导出时重组保证 FR-002 格式兼容。
- **Alternatives considered**: 始终 Base64 内嵌（兼容最好但性能不可接受）；全局资产库（跨工作区引用破坏文件可移植性）。

## R13. 安全边界

- **Decision**: Tauri Capabilities 最小集（core:default + 受限 dialog/fs scope，随功能增量收紧）；严格 CSP（`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' asset: blob: data:`）；所有前端传入路径经 `std::fs::canonicalize` + 工作区白名单校验；文档 JSON 视为不可信输入（结构校验 + 尺寸上限）。
- **Rationale**: FR-031/032/033 与宪法安全条款；现状 `csp: null` 为存量违规，列入 Phase 0 清偿。
- **Alternatives considered**: 宽泛 fs:allow-all + 运行时自律（违反最小权限原则，被否）。

## R14. 测试与故障注入

- **Decision**: 分离三类证据——Vitest/RTL 与 Playwright 验证浏览器可见 UI、状态机、a11y 和视觉；cargo test 验证 Rust 领域单元/集成行为；`APP_E2E=1` Tauri 测试构建验证进程强杀、文件系统故障、恢复与冲突；记录完整配置的 macOS 原生环境（虚拟机或物理机）验证窗口、IME、剪贴板、拖放、文件关联与安装，Ubuntu 24.04 可选补充。浏览器套件不得替代后两类。
- **Rationale**: 宪法原则 II 与 SC-003/012；故障场景只能在进程级 E2E 证明，原生平台行为只能由对应桌面 OS 环境闭环。虚拟机可覆盖该 OS 中的功能与安装行为，但必须披露宿主、虚拟化层与未覆盖的物理硬件边界。
- **Alternatives considered**: WebDriver/tauri-driver（Linux 可用但 macOS 支持弱、生态小）；仅单元测试（无法证明断电/强杀行为）。

## R15. 打包与分发

- **Decision**: macOS——GitHub Actions 构建未签名、未公证的 Universal Binary（lipo 合并 arm64/x86_64），产物 `.dmg` 与 `.app.tar.gz` 上传 GitHub Releases；Linux——AppImage（首选）+ deb + rpm 同步上传，注册 MIME `application/x-excalidraw` 与 `.desktop`；文件关联 macOS 侧 `CFBundleDocumentTypes`。项目不规划 App Store、Developer ID 或 Apple 公证。
- **Rationale**: FR-028/029 与 SC-010 将项目定位为非营利开源分发；发布说明必须披露 Gatekeeper 风险与手动放行方法。AppImage 覆盖最广，deb/rpm 服务原生包管理生态。
- **Alternatives considered**: 仅 AppImage（放弃系统包管理集成，FR-029 不满足）；Flatpak/Snap（沙箱与文件关联复杂度高，列为后续评估项）。

## R16. IME（中文输入法）适配

- **Decision**: 前端 `src/editor/imeBridge.ts` 保证 Excalidraw 隐形 textarea 的绝对坐标随画布缩放/平移实时映射（候选框跟随，FR-005）；Linux 端在 `src-tauri/src/lib.rs` 启动入口按需设置 `GTK_IM_MODULE`（及 Wayland 相关修正）规避 WebKitGTK/Fcitx5 兼容问题；Ubuntu 24.04 可选验证（tasks T103/T104 实现，T094 可选验证）。
- **Rationale**: FR-005 与 Edge Case"中文输入法组合输入"；WebKitGTK 的 IME 缺陷是已知风险点，需在对应 Linux 桌面 OS 原生环境（虚拟机或物理机）实际验证而非假设。
- **Alternatives considered**: 自绘输入框拦截 IME 事件（侵入 Excalidraw 内部实现，违反适配层原则）。

## R17. 文件删除进回收站

- **Decision**: 使用 `trash` crate（MIT/Apache-2.0）实现 `file_delete`：将文件移入系统回收站，而非物理删除（FR-016）。
- **Rationale**: 桌面应用惯例；误删可恢复；跨 macOS/Linux 统一 API，避免手写各平台回收站路径。
- **Alternatives considered**: 物理 `std::fs::remove_file`（不可恢复，UX 差）；自研平台分支（维护成本高）。

## R18. 性能与资源参考测量

- **Decision**: 以维护者声明的 Parallels Desktop Pro 26.4.1、macOS 26.5.2、4 vCPU / 8GB 虚拟机作为首个性能参考环境。聚合 Tauri 主进程及关联 WebView/GPU 进程的 RSS/CPU，分别测量冷启动、稳定空闲、10k 图元场景、60 秒高频编辑与 30 分钟 soak。完整运行产生真实 `pass` 或 `fail`，但预算失败不阻断合并或开源发布。
- **报告契约**: 机器可读报告记录 schema 版本、commit、宿主硬件、虚拟化软件与版本、客体硬件/内存/OS/WebView、样本、统计量、预算与 verdict，不记录机器唯一标识或秘密。
- **Rationale**: 使用已有 Parallels 基础设施降低非营利开源项目的维护门槛；保留完整工作负载、数值预算和环境元数据，能暴露性能风险而不伪造跨硬件可比性。
- **趋势分组**: 宿主硬件、Parallels、客体 OS/WebView 或虚拟资源改变时建立新趋势系列；不将不可比环境直接对比，预算调整必须附测量证据与 ADR，禁止静默放宽。
- **Alternatives considered**: 固定 Apple M1 / 8GB 真机硬门禁（维护成本与项目定位不匹配）；GitHub 托管 runner 绝对门禁（噪声和误报高）；三平台同时硬门禁（校准成本过高）。

## R19. 桌面壳层与主题系统

- **Decision**: 采用系统原生装饰窗口与传统桌面文档布局（顶部多文件标签、左侧文件管理、右侧画布），不复刻官方 PWA 的浏览器顶栏、应用菜单、账号/云服务/协作入口。官方 `@excalidraw/excalidraw` 随包样式是画布 UI 的事实来源；桌面壳层通过仓库根目录 `DESIGN.md` 定义的语义 token 对齐其浅色/深色视觉语言。
- **主题模型**: 将主题家族 `themeId` 与模式偏好 `modePreference = light | dark | system` 分离；第一版仅注册 `excalidraw` 家族，运行时统一解析为 `light | dark` 并同时驱动壳层与官方画布。偏好在首个用户可见界面前从本地恢复；损坏或未知值回退 `system`。
- **扩展边界**: 自定义主题未来仅能提供经校验的语义 token 与基础明暗模式，禁止任意 CSS、选择器、脚本和远程资源。应用主题不进入 `.excalidraw` 文档，导出与缩略图契约继续只使用 `light | dark`，因此本决策不要求 data-model 或 IPC 迁移。
- **Rationale**: 当前产品目标是将成熟的 Excalidraw 画布体验转化为可靠桌面工具，而不是创建第二套编辑器视觉；直接继承锁定包的公开样式能降低视觉漂移和上游升级成本。主题家族与明暗偏好解耦，可在不改变文档格式或画布契约的前提下增加内置/自定义主题。
- **Alternatives considered**: Fork 官方 PWA（同步与安全补丁成本高，已由 R3 否决）；逐像素手工重画画布控件（重复上游能力且易漂移）；第一版即实现任意 CSS 自定义主题（安全、兼容与维护边界不可控）；现在将 Open Design 纳入日常生成主链（当前属于参考驱动复刻，增加并行事实来源而无明显收益）。
