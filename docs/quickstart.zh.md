[English](quickstart.md) | [简体中文](quickstart.zh.md)

# 上手与验证指南：Excalidraw Desktop

**Date**: 2026-08-04 | **Last updated**: 2026-08-24 | **架构**: [architecture.zh.md](./architecture.zh.md) | **设计契约**: [../DESIGN.zh.md](../DESIGN.zh.md) | **IPC 契约**: [contracts/ipc-contracts.md](./contracts/ipc-contracts.md) | **ADR-009**: [adr/ADR-009-desktop-ui-interactions.md](./adr/ADR-009-desktop-ui-interactions.md)

本文件说明如何在本机运行 Excalidraw Desktop，以及如何按**产品能力**核对行为。实现细节见源码与 [architecture.zh.md](./architecture.zh.md)，此处不重复。

验证证据必须按来源分开报告，**不得互相替代**：

| 证据类 | 能证明什么 | 不能证明什么 |
|--------|------------|----------------|
| 浏览器 Playwright | 应用对话框、连续树、overlay/pinned 布局、键盘与 a11y | 废纸篓 Put Back、Finder、系统标题栏颜色、真实指针设备 |
| `APP_E2E=1` 进程级 | 文件系统变更、关闭队列、恢复、冲突、越界拒绝 | 操作员看到的原生标题栏着色、窗口遮挡/最小化 |
| 物理 macOS（或记录配置的 macOS VM） | 窗口标题 `Excalidraw Whiteboard`、系统标题栏颜色、正常层级、Trash/Finder、Gatekeeper | 不能用浏览器结果宣称已完成 |

原生窗口矩阵与参考环境性能测量**未在本文件预填 pass/fail**。未执行的检查保持未执行；预算失败仍须如实记录，但不阻断合并或开源发布（ADR-004）。

## 1. 环境前提

| 平台 | 要求 |
|------|------|
| 通用 | Node.js 22.13+（pnpm 11.20.0 要求）、pnpm（锁定为唯一包管理器）、Rust stable 1.80+（rustup）、Python 3.10+ 与 uv（仅构建期字体合并，解释器由 `.python-version` 固定，依赖由 `pyproject.toml` + `uv.lock` 声明，`uv run` 自动安装） |
| macOS | Xcode Command Line Tools；项目不需要 Developer ID、签名或公证；首次运行未签名产物时按 README 的 Gatekeeper 手动放行步骤验证 |
| Ubuntu 24.04 Desktop（可选） | `libwebkit2gtk-4.1-dev`、`libgtk-3-dev` 等 Tauri 2 系统依赖；可选单环境 smoke test，Fedora/其他 Linux 不在当前验收要求内 |

## 2. 构建与运行

以根目录 `package.json` 脚本名为准：

```bash
pnpm install                 # 前端依赖
pnpm fonts:build             # 构建期合并 Virgil-CJK 字体（uv 解析 pyproject.toml 依赖，产出 public/fonts/）
pnpm tauri dev               # 开发运行
pnpm tauri build             # 生产打包（dmg / AppImage / deb / rpm）

# 质量门禁（CI 同款）
pnpm lint && pnpm typecheck && pnpm test          # 前端
cargo fmt --manifest-path src-tauri/Cargo.toml --check && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings && cargo test --manifest-path src-tauri/Cargo.toml
APP_E2E=1 pnpm e2e           # Playwright 桌面 E2E（测试专用构建，暴露故障注入 Harness）
```

进程级用例还要求 `EXCALIDRAW_E2E_BINARY` 指向 `--features e2e-harness` 的测试二进制。生产构建不得注册 Harness，也不得注册 `thumb_lookup` / `thumb_store`。

相关套件（作为验证入口，本文件不宣称其已通过）：`e2e/tests/ui-sidebar-modes.spec.ts`、`e2e/tests/us3-workspace-files.spec.ts`、`e2e/tests/native-entry-mutations.spec.ts`、`e2e/tests/native-tab-close.spec.ts`、`e2e/tests/native-window-contract.spec.ts`、`e2e/tests/us7-thumbnails.spec.ts`（断言缩略图命令未被调用）。

## 3. 验证场景（按产品能力）

### 离线创建、编辑与保存

1. 断开网络 → 启动应用 → 新建图纸，绘制图形 + 中文文本 + 拖入图片。
   - 预期：全功能可用；中文呈手绘字体（无系统字体回退）；DevTools Network 零外部请求。
2. `Cmd/Ctrl+S` 保存 → 关闭应用 → 重新打开该文件。
   - 预期：内容一致；文件可被官方 excalidraw.com 正常导入。
3. 检查主窗口内容区与原生框架。
   - 预期：普通系统装饰窗口，标题为 `Excalidraw Whiteboard`；默认画布占满，无空右侧栏；侧边栏未固定时为 overlay（覆盖画布、不改变画布盒），固定后进入布局并缩小画布列；没有浏览器/PWA 顶栏或账号、Excalidraw+、协作与云服务入口。系统标题栏颜色由 OS 控制（物理 macOS 证据）；内容浅色/深色/跟随系统独立解析。
4. 依次选择浅色、深色、跟随系统；在跟随系统时切换操作系统外观，再分别以三种偏好重启应用。
   - 预期：壳层与画布始终同步；仅跟随系统响应运行中系统变化；重启首个可交互画面无相反主题闪现；浅色/深色截图基线 `maxDiffPixelRatio <= 0.001`。标题栏不随内容主题被应用强制着色。
5. 注入未知 `themeId`、未知模式和损坏的版本化外观偏好后启动。
   - 预期：安全回退为跟随系统，应用正常进入可交互状态，已打开或保存的 `.excalidraw` 内容没有变化。
6. 在浅色与深色模式分别只使用键盘操作标签、工作区空状态、外观选择和文件对话框，并启用系统减少动态效果。
   - 预期：键盘闭环与焦点顺序正确，焦点始终可见，状态不只依赖颜色，非必要动画被移除或减弱；WCAG 2.2 AA 适用对比度通过，自动化扫描严重/致命问题均为 0。

### 崩溃恢复与原子写

1. **保存中强杀**：`APP_E2E=1` 构建下对 `temp_created`、`mid_write`、`temp_synced`、`json_validated`、`before_rename`、`after_rename`、`before_parent_sync`、`parent_synced` 八个原子写故障点逐点注入 `SIGKILL` → 重启。PR 全点确定性执行；计划性可靠性任务额外运行并记录 100 个随机 seed。
   - 预期：每个故障点的目标文件均为可解析的完整旧版本或完整新版本；无静默覆盖；恢复对话框出现且草稿恢复后内容符合最后持久化窗口。生产构建中 Harness 接口不存在。
2. **快照自损**：Harness 破坏最新 `recovery-00N.json` → 触发恢复。
   - 预期：自动回退次新快照并提示实际恢复时间点。
3. **正常退出**：编辑后正常退出 → 重启。
   - 预期：无恢复弹窗；内容已落盘。

原子写、草稿窗口与恢复快照是现行可靠性契约，不因壳层或 IPC 变更而放宽。

### 工作区树与条目管理

生产列表/变更命令是 `workspace_entry_list` / `workspace_entry_create` / `workspace_entry_rename` / `workspace_entry_delete_preflight` / `workspace_entry_delete` / `workspace_entry_reveal`，**不是** `dir_list` 或 `file_*`。

1. 挂载含多级子目录的工作区 → 用应用对话框新建图纸/目录、重命名、删除；多标签打开。
   - 预期：命名对话框默认 `Untitled` / `Untitled Folder`；图纸扩展名 `.excalidraw` 固定不可编辑；确认前不创建；取消零变更；重名保持对话框并显示行内错误，不覆盖。标签跟随 rename；干净条目删除进系统废纸篓（物理 macOS：可 Put Back）。各标签撤销历史独立。
2. 删除已打开且 dirty 的图纸；删除含任意子项（含隐藏/不支持文件）的目录。
   - 预期：dirty 删除被阻断并聚焦对应标签；非空目录被阻断，提供取消与在文件管理器中打开（仅用户明确选择后才 reveal）。空性以 Rust 真实 `read_dir` 为准，不以树的过滤结果为准。
3. 多个工作区同时展开 → 单一连续滚动面浏览。
   - 预期：标题与子项连续纵向排列，无重叠、无横向滚动；无画布内容缩略图。万级树滚动/展开的帧率与内存是测量项，本文件不预填 pass/fail。
4. 构造 `../` 越界路径调用 `workspace_entry_list`（或等价条目命令）。
   - 预期：返回 `PATH_ACCESS_DENIED`。前端只按 `code` 分流，不解析 `message`。

浏览器可覆盖对话框、树与键盘。Trash/Finder/`PATH_ACCESS_DENIED` 的进程级证明需要 `APP_E2E=1`。物理 macOS：空图纸/空目录删除进入废纸篓且可 Put Back；非空目录阻断后，仅在用户选择时用 Finder 打开。真实触控板/滚轮滚动树时，菜单须在视口内翻折。

### 外部变更、冲突、失联关闭与标签切换

1. 应用内文档无修改 → 外部编辑器改写该文件。
   - 预期：约 3 秒内自动重载 + 轻提示。
2. 应用内有未保存修改 → 外部改写。
   - 预期：冲突弹窗（采用外部版本 / 保留本地草稿 / 另存为新文件），决策前目标文件零写入。
3. 外部删除打开中的文件 → 关闭该失联标签。
   - 预期：标签页失联标示；关闭提供另存 / 丢弃 / 取消；`doc_close` 使用 `discardOrphan` 时不向已缺失路径做 checkpoint。取消后标签仍在。
4. 脚本 1s 内写文件 20 次（模拟云盘风暴）。
   - 预期：事件合并，无弹窗轰炸。
5. 连续关闭多个标签或滚轮快速切换。
   - 预期：关闭串行；失败即停；激活只落实最新意图。浏览器可测队列行为；Cmd+W / 中键的原生命中需物理 macOS，不得用 harness 合成事件宣称已验证真实快捷键。

### 导出

1. 中英混排画布导出 PNG（2x/透明底）与 SVG → 在固定无字体干净环境打开 SVG。
   - 预期：SVG 内嵌 WOFF2 且无字体回退；Playwright 固定截图基线 `maxDiffPixelRatio <= 0.001`；PNG 尺寸=画布×倍率。
2. 导出到只读目录。
   - 预期：明确错误提示，无残留半成品文件。

### 系统集成与原生窗口

1. 在记录配置的 macOS VM 或物理机安装 GitHub Release 同类产物 → Finder 双击 `.excalidraw`；Ubuntu 24.04 可选执行对应 smoke test。
   - 预期：应用启动并打开该文件；应用已运行时复用实例新开标签。
2. macOS 首次启动未签名、未公证产物。
   - 预期：Gatekeeper 可能拦截；README/Release 警告风险并提供用户主动手动放行步骤，放行后应用可运行。
3. 检查原生窗口契约（见 ADR-009）。
   - 预期：标题为 `Excalidraw Whiteboard`；普通装饰 `Visible` 窗口；标题栏颜色由系统控制；可被其他应用遮挡、最小化、恢复；生产不是 always-on-top。`e2e_harness` 在 `EXCALIDRAW_PERF_CONTROL_DIR` 下的置顶不得出现在生产构建。首次启动侧边栏默认隐藏；**Workspace sidebar** 打开 overlay，不改变画布盒；固定后进入布局；指针离开 500ms 后关闭 overlay，除非 focus/menu/dialog/drag 仍将其保持；Escape 关闭 overlay（除非对话框或菜单已消费 Escape）。
4. Ubuntu 24.04 Desktop 可选安装 AppImage/deb；rpm 为 best-effort 产物，不要求其他 Linux 发行版验收。
   - 预期：应用菜单入口 + 文件图标关联生效。

第 3 步的系统着色标题栏与窗口管理是物理 macOS 证据。静态读取 `tauri.conf.json` 只能核对标题字符串，不能代替目视标题栏。

原生验收 run 只能从已存在且为空的 absolute directory 与 exact production package manifest 创建。当前支持的 mode 把 backend app data 重定向到 run root；它不声称独立的 WKWebView filesystem root：

```bash
pnpm native:screen:prepare -- \
  --checkpoint VSL \
  --package-manifest <absolute-sealed-package-manifest.json> \
  --semantic-collection <absolute-T031-collector-report.json> \
  --run-root <absolute-empty-run-root> \
  --plan <absolute-new-capture-plan.json> \
  --isolation-mode backend-app-data-home-redirect
```

VSL 的 `--semantic-collection` 是必需参数，必须指向 immutable T031 `collector-report.json`；prepare 会验证其 PASS/gate/manifest binding，并记录 report file SHA 与 collection digest。Capture 会在 launch 前与封存输出前重新验证这些 bytes。六屏 final plan 使用 `FINAL`。`backend-app-data-home-redirect` 只 provision 能通过当前安全格式表达的仓库已声明 fixture data，记录每张屏的 `fixture|operator-assisted` preparation mode，为每张屏创建独立 backend-home root，并另建 T023b root，然后写绑定 harness v4 的 immutable schema-v2 plan。Capture 必须实际观察 Application Support 与 `excalidraw-desktop.sqlite3` 位于该 root 内，否则返回 `BLOCKED`。它不写 WebKit 私有存储，也不增加 production diagnostic/state channel；`isolation.json` 记录 `webkitFilesystemIsolationClaimed: false`，harness 不得读取、打印、备份、清理或直接修改 operator WebKit data。

运行 capture 后，若终端打印 `OPERATOR_SETUP_REQUIRED`，请在 600 秒内使用正常应用 UI 建立打印出的 exact target。Operator action 只用于状态准备，不构成交互 PASS；对应 evidence 仍由 focused tests 与 semantic Playwright collection 持有。随后 collector 打印一次性的精确 `CAPTURE <gate-id> <challenge>`。Codex/非交互场景由 Agent 保持 collector PTY、向 operator 展示该行、等待明确回复 `ready`，再转发到同一 PTY；不得在另一个 shell 执行。Collector 随后重新校验同一 PID/window/bounds/scale，并只 capture 一次。

VSL-001 的打印 checklist 会要求 Sidebar 准确 360px、`flows` 展开、Architecture/Migration/Research 可见、Architecture active 且 selected、Library panel 打开。Sidebar width、expanded directories、selection 与 Library visibility 仍由 semantic/reviewer evidence 负责；terminal confirmation 不是 evidence。Plan 的保守 canvas mask 从 x=480（Sidebar 最大宽度之后）开始，Library mask 独立保留，因此无法遮蔽 Sidebar width/perimeter mismatch。

```bash
pnpm native:screen:capture -- \
  --plan <absolute-capture-plan.json> \
  --gate VSL-001 \
  --collection-dir <absolute-new-collection-dir>

pnpm native:screen:capture -- \
  --plan <absolute-final-capture-plan.json> \
  --all-final \
  --collection-root <absolute-new-final-collection-root>
```

Collector 将 launched child 与唯一 bundle-owned window 匹配，调用 macOS window-only capture，把 raw dimension 校验为严格的 `1280×760 × backingScale`，再经一次 `lanczos3-srgb-v1` 比例 normalization 输出 `actual.png`。它不得自动操作应用内容；禁止 full-screen/coordinate search、crop、padding、超出 scale normalization 的 stretch 或 visual repair。每个输出目录必须不存在。退出码为 `0=PASS`、`1=FAIL`、`2=BLOCKED`、`64=invalid invocation`。

最终安装包的原生入口 collection 必须同时提供上述 FINAL plan、sealed manifest 与 immutable binding，且输出目录必须尚不存在：

```bash
pnpm native:macos:validate -- \
  --manifest <sealed-package-manifest.json> \
  --capture-plan <final-capture-plan.json> \
  --collection-dir <new-native-entrypoint-collection> \
  --binding <evidence-binding.json>
```

adapter 写入 collector 自有的 `environment.json`、`route-acknowledgements.json`、`filesystem-outcomes.json`、`native-report.json` 与 `collector-report.json`，绝不写 reviewer 或 product owner 状态。只有 VSL-001 或 FINAL-003 所需角色各自封存 artifact 后，才能发布完整 gate：

```bash
pnpm evidence:publish -- \
  --source <sealed-gate-dir> \
  --destination docs/evidence/003-visual-acceptance/<commit>/<gate-id>
```

目标必须是 003 evidence root 内的新目录。发布器验证 digest 与角色边界，逐字节复制全部来源文件，再次计算来源/目标 hash，并在复制树旁写 `<gate-id>.publication.json`。退出码固定为 `0=PASS`、`1=FAIL`、`2=BLOCKED`、`64=invalid invocation`。

对于 FINAL-003，sealed source 顶层精确包含四个角色目录：`collection/`、`aggregate/`、`review/` 与 `owner/`。`aggregate/technical/` 只能包含五个 T062 输出（`input.json`、`dependency-graph.json`、`stale-evidence.json`、`technical-report.json`、`technical-report.md`）；publisher 会复核 technical PASS、所有 manifest/delta/report 路径与 digest、7 个 browser claim collections 及 6 个 T061 native visual collections。`review/reviewer-report.json` 是 canonical index，只能索引这六个 visual collections 与六份 `review/screens/<gate-id>/reviewer-report.json` PASS 文件，不得把 T059、T060、T023b、T062 或其他 technical collection 声称为已做视觉 review。`owner/product-owner-decision.json` 必须记录 `APPROVED`，并按 digest 同时绑定 `aggregate/technical/technical-report.json` 和 `review/reviewer-report.json`。角色或文件缺失/多余、传递字节 stale、reviewer 越权绑定 technical collection，或 owner 缺少任一绑定，均返回 `BLOCKED`。通过验证后，aggregate 与逐屏 review 的每个字节都和其他 source bytes 一样原样发布。

### Read-only evidence aggregation（只读证据聚合）

所有 mode 都读取 immutable input，校验 raw artifact bytes 与 transitive binding，只写指定的新 output；绝不编辑 source evidence、reviewer/owner artifact、product repository 或 `tasks.md`：

```bash
pnpm evidence:aggregate -- --mode delta --product-root <path> --checkpoint-map <json> --final-commit <sha> --ownership-map e2e/visual/003EvidenceOwnership.json --output <new-json>
pnpm evidence:aggregate -- --mode technical --input <final-input.json> --output-dir <new-dir>
pnpm evidence:aggregate -- --mode task-proof --tasks <tasks.md> --proof-source <proof-source.json> --output <new-map.json>
pnpm evidence:aggregate -- --mode closure --technical-report <report.json> --task-proof-map <map.json> --tasks <tasks.md> --self-task <id> --output-dir <new-dir>
pnpm evidence:aggregate -- --mode closure-verify --closure-report <report.json> --tasks <tasks.md> --output <new-json>
```

`delta` 要求 clean product HEAD。其 schema-v1 checkpoint map 将每项 claim 绑定到一个绝对 source report 路径、collection digest 与 source commit：

```json
{
  "schemaVersion": 1,
  "checkpoints": [
    {
      "claimId": "shell-semantic",
      "sourceReportPath": "/absolute/collector-report.json",
      "sourceCollectionDigest": "<64-hex>",
      "fromCommit": "<40-hex>"
    }
  ]
}
```

分类前，aggregator 会重新读取每份 report，校验全部 artifact bytes 与重新计算的 collection digest，并要求 report 的 product-commit binding 等于 `fromCommit`。它为每个 checkpoint 独立计算 `fromCommit..finalCommit`，因此其他 checkpoint 的变更不会把可复用 claim 污染为 `RERUN`。输出 `entries` 仍是去重后的 union，且每条 path 必须恰好命中一个 ownership rule。versioned ownership map 包含 `commandCatalog` 与 `claimCommands`；只有该 checkpoint 自身结果为 `RERUN` 时，其映射命令才会作为已排序、去重的 `{ "id", "command" }` 写入 `rerunCommands`。缺失 report、过期 digest/binding、未知 command mapping，以及未分类或多重分类的 path 均为 `BLOCKED`。

编写 task proof 时推荐 schema v2。共享 metadata 放在 `defaults` 或一个 proof group 中；source group 不复制 checkbox state：

```json
{
  "schemaVersion": 2,
  "defaults": {
    "required": true,
    "reviewerRequirement": "NOT_REQUIRED",
    "ownerRequirement": "NOT_REQUIRED"
  },
  "proofGroups": [
    {
      "taskIds": ["<task-id-1>", "<task-id-2>"],
      "completionRefs": [{ "repository": "product", "commit": "<40-hex>" }],
      "claimIds": ["foundation"],
      "artifactRefs": [
        { "path": "/absolute/collector-report.json", "sha256": "<64-hex>" }
      ]
    }
  ]
}
```

`task-proof` 直接从 `tasks.md` 派生 `checked` / `unchecked`，要求每个解析出的 task 恰好属于一个 group，校验全部 commit 与 artifact reference，并在不修改任一 input 的前提下展开为 canonical schema-v1 per-task map。schema-v1 record source 保留兼容读取。`technical` 要求恰好七个 canonical `RERUN|REUSE` browser claim collections、六个互不重复的 final screen collections，以及 package/regression claim sets。它拒绝 reviewer/owner input fields，并独立校验每个 referenced report、collection digest、artifact bytes、commit 与 HF-2 manifest binding。`closure` 只允许声明的 self task 保持 unchecked；它计算预期 transition 后 hash，但不编辑 task。human/task writer 仅切换该 checkbox 后，再由 `closure-verify` 校验预期 hash。退出码为 `0=PASS`、`1=FAIL`、`2=BLOCKED`、`64=invalid invocation`。

### 多工作区与资产去重

1. 挂载两个工作区 → 在同一连续树中并列展示、独立移除（不删磁盘文件）。
2. 浏览文件列表。
   - 预期：**不**生成画布缩略图；生产与浏览器路径不得调用 `thumb_lookup` / `thumb_store`。`.excalidraw_assets` 内真实图片仍可加载；asset protocol 不是缩略图缓存。
3. 同一 10MB 图片粘贴 10 次 → 保存。
   - 预期：文档体积增幅 ≤5%（资产去重）。

## 4. 性能夹具（回归基线）

| 指标 | 夹具 | 阈值 |
|------|------|------|
| 冷启动 | 清空应用测试数据，执行 10 次冷进程启动；单调时钟记录进程启动 → 画布可编辑并计算 P95 | ≤2s |
| 空载内存 | 启动稳定 30s 后采样 60s，聚合 Tauri 主进程及关联 WebView/GPU 进程树 RSS P95 | ≤500MB（ADR-007） |
| 空闲 CPU | soak 后崩溃安全刷新完成，再采样 60s 进程树 CPU P95，按单逻辑核归一化 | ≤35% 单逻辑核（ADR-007） |
| 大场景帧率/内存 | 10k 图元固定 fixture + 恒定缩放平移脚本，采集帧时间与场景稳定后的进程树 RSS | ≥30fps、目标 60fps、无 >100ms 冻结、RSS ≤950MB（ADR-007） |
| 写盘削峰 | 60s 连续绘制脚本 + 应用管理路径写入计数 | 写次数 ≤事件数 1%，且无持久化掉帧尖峰 |
| 长时稳定性 | 热身后脚本编辑 15min，对比进程树 RSS；等待 5s 崩溃安全刷新后再静置 60s 观察 CPU 与写入 | RSS 增长同时 ≤50MB 且 ≤15%；空闲 CPU ≤35%；零持续写入（ADR-006/007） |

参考环境冷启动 / 画布 I/O / soak 测量在声明的 Parallels Desktop Pro 26.4.1、macOS 26.5.2、4 vCPU / 8GB 参考 VM 上完整执行；工作流仍使用 `self-hosted`、`macOS`、`ARM64`、`excalidraw-perf` 标签。报告记录宿主硬件、虚拟化软件/版本、客体 OS、WebView、vCPU 与内存并输出真实 `pass`/`fail`；预算失败不阻断合并或开源发布。参考配置变化时必须建立新的独立测量序列并更新 ADR，禁止把不可比结果混合或静默放宽预算。未跑完的测量不得写成已通过。

夹具输出 JSON 报告，包含 schema 版本、commit、硬件型号、内存、准确 OS/WebView 版本、样本、统计量、预算与 verdict，不得包含机器唯一标识或秘密。聚合口径必须覆盖 Tauri 主进程和关联 WebView/GPU 进程，并在报告中写明任何无法归属的排除项；性能回归 = 缺陷（宪法原则 IV）。

## 5. 中文 IME 验证（Linux 目标 OS 矩阵项）

拼音输入组合中：候选框紧随画布文本光标（含缩放/平移后）；组合事件不丢字、不重复。macOS 原生验收为必选；Ubuntu 24.04 可选执行一次记录配置的 smoke test，Fedora/其他 Linux 与完整显示协议/输入法矩阵不属于当前版本要求。

## 6. 验证证据汇总与统一门禁

全量回归结果、三类验证证据（浏览器 UI、`APP_E2E=1` 进程级可靠性、记录配置的原生 OS 环境矩阵）统一记录于 `docs/evidence/validation-summary.md`，本文件不再重复明细。

**可靠性阻断门禁**：以下三套故障测试合并为合并阻断门禁，任一失败即阻止合并，且不允许以本文件外的单套件结果替代：

1. `e2e/tests/us2-kill-during-save.spec.ts`：原子写八个故障点逐点 SIGKILL，目标文件必须为完整旧/新版本且恢复 UI 正确；
2. `e2e/tests/us2-snapshot-corruption.spec.ts`：快照自损回退次新并提示实际恢复时间点；
3. `e2e/tests/us4-external-changes.spec.ts`：外部变更自动重载/冲突/失联另存，决策前零写入。

执行方式：`APP_E2E=1 pnpm e2e` 且 `EXCALIDRAW_E2E_BINARY` 指向故障注入测试构建（生产构建无 Harness 接口）。

**性能参考测量**：冷启动 / 画布 I/O / 15 分钟 soak 在 Parallels Desktop Pro 26.4.1、macOS 26.5.2、4 vCPU / 8GB VM 中完整执行；运行时设置 `PERF_REFERENCE_RUN=1`、`PERF_EXECUTION_ENVIRONMENT=virtual`、`PERF_HOST_HARDWARE`、`PERF_VIRTUALIZATION_NAME="Parallels Desktop Pro"` 与 `PERF_VIRTUALIZATION_VERSION`。报告必须产生真实 `pass`/`fail`，但预算失败不阻断合并或开源发布；不同环境结果不直接对比。壳层或 IPC 变更后的 before/after 必须另记，不得把架构意图写成已经改善。

在参考 VM 内手动执行时，先把最后一项替换为已安装的准确 Parallels Desktop Pro 版本：

```bash
VITE_E2E_HARNESS=1 pnpm tauri build --features e2e-harness

PERF_TEST=1 \
PERF_REFERENCE_RUN=1 \
PERF_EXECUTION_ENVIRONMENT=virtual \
PERF_HOST_HARDWARE="Apple M5 Pro / 48GB" \
PERF_VIRTUALIZATION_NAME="Parallels Desktop Pro" \
PERF_VIRTUALIZATION_VERSION="26.4.1" \
pnpm exec playwright test \
  --config=e2e/playwright.config.ts \
  --project=browser-ui \
  --retries=0 \
  e2e/perf/startup-idle.spec.ts \
  e2e/perf/canvas-io.spec.ts \
  e2e/perf/edit-soak.spec.ts
```

若通过 GitHub Actions 执行，需先在该 macOS VM 安装 self-hosted runner 并赋予 `self-hosted`、`macOS`、`ARM64`、`excalidraw-perf` 标签，再配置仓库变量 `PERF_HOST_HARDWARE` 与 `PERF_VIRTUALIZATION_VERSION`，随后手动触发 `performance.yml`。

**开源分发**：macOS 产物长期以未签名、未公证形式发布到 GitHub Releases；项目不规划 App Store、Developer ID 或 Apple 公证。README 与发布说明必须披露 Gatekeeper 风险与用户主动手动放行步骤。
