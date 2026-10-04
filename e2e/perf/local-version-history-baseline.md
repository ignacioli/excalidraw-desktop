# Local version history performance baseline

**当前执行范围（2026-10-04 owner决定）：** Parallels Desktop已不可用，本轮004关闭只在同一M5 Pro物理机测量基线／候选，跳过VM。共同startup-idle、canvas-io、完整15分钟edit-soak与候选History专项均保留。`PERF_REFERENCE_RUN=0`、`PERF_EXECUTION_ENVIRONMENT=physical`；保存原始diagnostic budget verdict与完整性结果，另报告配对绝对值／差值，不把历史VM阈值改造成新的M5 Pro硬门槛。VM不再是本轮T049完成条件，下文VM环境与旧失败作为历史保留。基线已重新构建，见[构建绑定](../../docs/evidence/local-version-history-t049/baseline-build-20261004/binding.json)；尚未开始本轮测量。

**此前状态（2026-09-29）：T049 仍为 `not_evaluated`。** 固定基线 `babc027d64c2c50e6922482b416ef1099ea9d07e` 的独立 `e2e-harness` binary 已构建，SHA-256 为 `158fc23d122d5595b3950e934da77014b119f0382f393afac95a5628caa50511`。一次物理 macOS `startup-idle` 尝试在第 5 次冷启动等待 `ready.json` 15 秒后失败；只有 4/10 次 editable-canvas 样本。操作员最小化了挡住工作的窗口，精确时点未知，无法归因。本次整体 **INVALID**，原始报告及运行前 binary/runner binding 见[物理基线尝试](../../docs/evidence/local-version-history-t049/physical-startup-20260929/README.md)。没有重试、有效物理配对、参考 VM 报告或速度／回归结论。候选 UI 正在修改；先前构建的候选 binary 不预支修改后的候选身份。

**先前状态（2026-09-28，保留历史）：** T049 正式配对测量尚未执行。History 专项 workload 已准备为 1 次预热和 3 次独立测量；共同三项性能报告现会写入实际 binary `realpath` 和 SHA-256。旧 smoke 保留为历史诊断，所有当时预算仍为 `not_evaluated`。当时的候选实现尚有未提交并行修改，不能用当时 HEAD 伪装成测量提交。

本文件定义功能 004 的可比较性能证据格式，并记录实际尝试的有效性；计划中的二进制、环境或预算不得写成已经执行的事实。

## 基线身份

功能前基线提交固定为：

```text
babc027d64c2c50e6922482b416ef1099ea9d07e
```

基线和候选版本必须在同一环境、同一工作负载、同一夹具 seed 和同一 runner 命令下各自生成报告。报告的 `commit` 必须是实际 checkout 的 40 位 Git commit；不能用分支名、缩写或“当前版本”代替。

每个报告还必须包含新增的 `binary` 对象（见 `report.schema.json`）：

| 字段               | 规则                                                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `binary.path`      | 测量时实际启动的可执行文件的 `realpath`，不使用 glob、别名、符号链接或仅能推断的目录。准备阶段使用 `<PENDING: exact executable realpath>`；占位符不得进入有效 `pass`/`fail` 报告。 |
| `binary.sha256`    | 对上述精确文件按字节计算的完整 64 位小写 SHA-256；准备阶段使用 `<PENDING: sha256 of exact executable>`，不得使用缩写、bundle 名称或 Git commit 代替。                              |
| `binary.kind`      | `e2e-harness` 或 `production`。T090/T108 性能负载必须明确记录测试专用 harness；生产包行为不能由 harness 结果冒充。                                                                 |
| `binary.pathScope` | `absolute` 表示原始 runner 路径；`workspace-relative` 仅用于去除工作区根目录后的机器报告。若采用后者，配套证据仍须能还原并核对原始绝对路径。                                       |

基线 binary 已在独立 target 中构建：`/private/tmp/t049-20260929-baseline-target/release/excalidraw-desktop`，SHA-256 `158fc23d122d5595b3950e934da77014b119f0382f393afac95a5628caa50511`。2026-09-29 首次物理运行未形成有效样本；旧基线 runner 的原始 JSON 没有 `binary` 字段，运行前 binding 单独保留路径、hash 和 runner 文件 hash。候选版本必须另有提交、路径和 hash；不能把基线 hash 复制给候选版本。

## 比较环境

比较单位是“同一环境内的基线／候选配对”，不是物理机与虚拟机之间的绝对值比较。每条报告都要记录 `report.schema.json` 现有的 `hardware`、`memory`、`architecture`、`logicalCores`、`osVersion`、`webviewVersion` 和 `executionEnvironment` 字段；缺少任何一项时该样本为 `not_evaluated`，不能进入回归判定。

### 同一物理 macOS：迭代诊断配对

T049 先在同一物理 macOS 上运行基线／候选的共同启动、编辑、保存和空闲负载，用于快速发现产品回归和工作负载问题。这是 non-blocking diagnostic trend，不是 fixed hard gate 或 authoritative reference 结果。首个实际运行前必须把以下占位符替换成系统采集值：

| 元数据                          | 要求                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `hardware`                      | 精确 Mac 型号与芯片字符串；不得只写芯片系列。                                               |
| `memory`                        | `bytes` 与 `gibibytes`，以实际物理 macOS 报告为准。                                         |
| `architecture` / `logicalCores` | `arm64` 及实际逻辑核数。                                                                    |
| `osVersion`                     | 精确 macOS product version 与 build，例如 `macOS <version> (<build>)`。                     |
| `webviewVersion`                | 精确系统 WebKit/WKWebView framework 版本。                                                  |
| `executionEnvironment`          | `{ "type": "physical", "hostHardware": "<exact host hardware>", "virtualization": null }`。 |

### 历史参考虚拟机（本轮已按owner决定跳过）

这是本项目的 authoritative auditable reference series；它只在同一 VM 配置内比较基线／候选。当前声明的配置来自 ADR-004 和功能 plan，仍须由运行时报告核实：

| 元数据                 | 声明值／运行时要求                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 宿主机                 | `Apple M5 Pro / 48GB`；必须由宿主配置核对，不能从虚拟 guest 字符串反推。                                                                     |
| 虚拟化                 | `Parallels Desktop Pro`，版本 `26.4.1`；版本变化开启新的测量 series。                                                                        |
| guest OS               | `macOS 26.5.2 (<exact build>)`；build 必须实测确认。                                                                                         |
| guest resources        | `architecture=arm64`、`logicalCores=4`、`memory≈8 GiB`。                                                                                     |
| WebView                | `<PENDING: exact guest WebKit framework version>`，必须由 guest 运行时采集。                                                                 |
| `executionEnvironment` | `{ "type": "virtual", "hostHardware": "Apple M5 Pro / 48GB", "virtualization": { "name": "Parallels Desktop Pro", "version": "26.4.1" } }`。 |

参考 VM 使用 `self-hosted`、`macOS`、`ARM64`、`excalidraw-perf` runner labels；这些 labels 只负责路由，不代表某一物理机型号。只有完整的 VM 环境字段、二进制身份和工作负载样本齐全时，结果才可作为 authoritative reference evidence。

宿主硬件、Parallels 版本、guest OS/build、vCPU、guest memory、WebView 或显示协议变化时，停止 before/after 直接比较，创建新的 series，并在 ADR/验证汇总中记录 rebaseline 原因。报告不得写入机器唯一标识、账号、token 或其他秘密。

## 工作负载、采样与预算

所有采样使用 monotonic clock；进程资源统计覆盖 Tauri 主进程及关联 WebView/GPU/Network 进程。必须在报告的 `processTreeAccounting` 中列出关联方法、纳入的进程类别、排除项和平台限制。浏览器或单独 Tauri 主进程数据不能代表应用进程树。

| 指标                     | 预热与采样                                                                                                                    | 统计／单位                                 | authoritative reference budget |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------ |
| 冷启动至 editable canvas | 每组 10 次冷启动；每次从 spawn 前开始，至 `ready.json` 证明 API ready、`editable=true` 且画布可编辑结束；不把 warm start 混入 | nearest-rank P95，毫秒                     | `<= 2,000 ms`                  |
| 空闲 RSS                 | 进程树进入稳定空闲后 warm-up 30 s；连续 60 s、1 s 间隔采样                                                                    | 进程树 RSS nearest-rank P95，bytes         | `<= 500 MB`                    |
| 空闲 CPU                 | 与空闲 RSS 使用同一稳定窗口                                                                                                   | 单逻辑核归一化 CPU P95，百分比             | `<= 35%`                       |
| 10,000-element 稳定 RSS  | 加载确定性 10,000-element fixture，待 `ready.json` 和稳定窗口完成；不得只计 root Tauri 进程                                   | 进程树 RSS nearest-rank P95，bytes         | `<= 950 MB`                    |
| 编辑 soak 增长           | warmed baseline 后运行 15 min scripted editing（ADR-006）；结束后同口径采样                                                   | `rssGrowthBytes` 与 `rssGrowthPercent`     | 同时 `<= 50 MB` 且 `<= 15%`    |
| 静置写入                 | 编辑／保存完成并进入 quiescent 后观察 60 s；覆盖 application-managed data directories 与 mounted workspaces                   | `eventCount=0` 且持久 `changedPathCount=0` | 零持续写入                     |

工作负载名称、fixture/seed、持续时间、采样间隔、warm-up、统计方法、预期方差、原始报告路径和报告 SHA-256 必须写入报告或配套证据。参考 VM 的预算失败仍记录为 `verdict.overall=fail`，但不阻断 merge 或 open-source release；缺少完整窗口、二进制身份或环境元数据则为 `not_evaluated`，不能降级成通过。物理 macOS 诊断结果不得替代参考 VM 证据。

### T049 配对与 History 专项方法

旧提交 `babc027d64c2c50e6922482b416ef1099ea9d07e` 不含 `history_*` IPC。基线和候选只比较双方均存在的 `startup-idle`、`canvas-io`、`edit-soak`：相同 10,000 元素 fixture、seed、预热/采样窗、显示条件和进程树口径。`local-version-history.spec.ts` 仅在候选上运行；它记录 20 条池的列表数、A→B→A 场景 SHA-256、对象/asset 存在与 GC 保留、恢复状态的**绝对值**，不构造旧版本 History 延迟或内存差值。每次旅程使用新隔离 root 和六个原生进程阶段；先做 1 次预热，再做 3 次完整样本，使用 monotonic clock，旅程耗时的 nearest-rank P95 仅作描述值。进程树 RSS/CPU 由共同的 T090/T108 workload 测量；History 报告明确列出该项排除，不得据此宣称 History 专属资源预算 `pass`。

本轮测量顺序为同一M5 Pro物理macOS的基线、候选配对；不再执行参考VM配对。每个 checkout 需构建独立 `e2e-harness` 二进制，记录实际可执行文件 `realpath` 与 SHA-256；报告的 `commit` 必须对应正在运行的 checkout，且构建输入不能有未提交产品改动。每条 spec 单独运行并保存 JSON 和 digest，不能让后一次运行覆盖前一次报告。参考 VM 的宿主、Parallels、guest OS/build、4 vCPU/8 GiB 与 WebView 必须由当次运行核对；如与声明系列不一致，按 rebaseline 流程新建系列，不直接比较绝对值。

| 单次命令                                  | 计划窗口及保守耗时                                                          | 完成信号                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `startup-idle.spec.ts`                    | 10 次冷启动，30 s 预热 + 60 s 空闲采样；约 2–4 分钟                         | 独立 `startup-idle.json`，10 个冷启动样本和完整空闲窗口                 |
| `canvas-io.spec.ts`                       | 30 s 预热 + 30 s RSS + 30 s pan + 60 s edit；约 3–5 分钟                    | 独立 `canvas-io.json`，帧、写入与全树 RSS 样本                          |
| `edit-soak.spec.ts`                       | 30 s 预热 + 60 s 基线 + 15 min 编辑 + 5 s settle + 60 s 静置；约 18–22 分钟 | 独立 `edit-soak.json`，完整 15 分钟和静置窗口；短诊断不可作预算 verdict |
| `local-version-history.spec.ts`（仅候选） | 1 次预热 + 3 次 A→B→A；预估 2–5 分钟，需以实测确认                          | 独立 `local-version-history.json`，3 条完整样本及描述性 P95             |

每条长命令启动前宣布预计时长和报告路径；运行中约每 5 分钟检查样本或报告/错误产物；单命令不超过默认 30 分钟。调用需设 `PERF_TEST=1`、`APP_E2E=1`、`EXCALIDRAW_E2E_BINARY=<本 checkout 精确可执行文件>` 和独立 `PERF_*_REPORT_PATH`；History 另设 `EXCALIDRAW_E2E_HISTORY_RESTART=1`。参考 VM 另设 `PERF_REFERENCE_RUN=1` 及声明环境字段。共同三项 spec 的 `binary` 字段已补齐，但尚无真实原生测量报告；不能仅凭字段存在宣布可审计配对。

## 报告配对记录模板

每个环境单独建立一组基线／候选记录。以下模板中的 `<PENDING: ...>` 只表示尚未执行，不能作为测量结论：

```yaml
series: local-version-history-<physical-diagnostic|parallels-26.4.1-reference>
environment: <physical|virtual>
baseline:
  commit: babc027d64c2c50e6922482b416ef1099ea9d07e
  binary:
    path: "<PENDING: exact executable realpath>"
    sha256: "<PENDING: sha256 of exact executable>"
    kind: e2e-harness
    pathScope: absolute
  report: "<PENDING: raw JSON report path>"
  reportSha256: "<PENDING: SHA-256 of raw JSON report>"
candidate:
  commit: "<PENDING: 40-hex candidate commit>"
  binary:
    path: "<PENDING: exact executable realpath>"
    sha256: "<PENDING: sha256 of exact executable>"
    kind: e2e-harness
    pathScope: absolute
  report: "<PENDING: raw JSON report path>"
  reportSha256: "<PENDING: SHA-256 of raw JSON report>"
comparability:
  sameWorkloadAndSeed: false
  sameEnvironment: false
  verdict: not_evaluated
```

`sameWorkloadAndSeed`、`sameEnvironment` 在实际核对前必须保持 `false`；不能用模板本身宣称可比较。每个原始 JSON 报告必须符合 `e2e/perf/report.schema.json`，且 schema 中的 `binary` 字段在有效 T003/T049 结果里必须实际填充。

## 当前证据边界

2026-09-29 物理 macOS 基线 `startup-idle` 首次尝试的 Playwright 命令失败，原始报告 `verdict.overall=not_evaluated`：4/10 次 editable-canvas ready，第 5 次未在 15 秒内发布 `ready.json`；空闲窗口虽有 60 个进程树样本，整次运行仍因启动窗口不完整且操作员最小化时间未知而标记 **INVALID**。没有原样重跑。原始 JSON、SHA-256、独立 binary/runner binding 和停止检查归档在[物理基线尝试](../../docs/evidence/local-version-history-t049/physical-startup-20260929/README.md)。候选 `startup-idle`、其余共同负载、History 专项正式测量以及参考 VM 均未执行。

2026-09-26 修正 T024 fixture 时间基准后，以产品提交 `b6fca0d77d2b3e9d06b7f866fbd6ff79eaa56766` 的 test-only binary（SHA-256 `c43012c081fc8d9616194bc61db1eceb9eb693ebaf896419d44353e03acfab49`）运行一次 history 专项工作负载 smoke，1/1 PASS。原始 JSON 为 `/private/tmp/history-t049-smoke-b6fca0d.json`（SHA-256 `4a3801de9054784b5bf29f4d7d34bea72dc4cd410cf5ee9faa19ca902ed38f37`）：20 条池、A→B→A、恢复后场景与图片哈希、资源和 GC 检查均通过；单次旅程耗时 `1913.049167 ms`，仅为描述值。第一次调用遗漏 `PERF_TEST=1`，Playwright 报 `No tests found`，未进入产品旅程；加上该配置开关后才产生上述报告。该报告的 `executionEnvironment.type` 为 `unspecified`，未做基线／候选配对、进程树资源采样或规定 VM 运行，`verdict.overall` 仍为 `not_evaluated`；它只解除先前 smoke 的功能失败，不构成 T049 性能验收。

正式配对前的 2026-09-26 只读报告审计曾发现：`startup-idle.spec.ts`、`canvas-io.spec.ts`、`edit-soak.spec.ts` 当时均未向报告写入本文件要求的 `binary` 路径/完整 SHA-256；2026-09-28 已在三项 spec 补齐，尚未以原生测量验证。`report.schema.json` 为兼容旧报告将该字段设为 optional。有效 T049 报告仍需分别绑定实际基线与候选 checkout 的 commit 和 binary，不能运行基线 binary 却写候选 commit。下述 VM 配置不符尚未解决，正式预算仍为 `not_evaluated`。

2026-09-26 T049 候选工作负载 smoke 已启动，但实际 test-only 前端 A→B→A 旅程在 `frontendB` 收到 `HISTORY_UNAVAILABLE`，没有生成可比较的性能 JSON。当前候选 `ab67c3c43ee69ae32a040bb3e6f9c762807d8c3c` 的测试专用二进制 SHA-256 为 `0a24d93a280c7db4c0231a3a244dcdd70928f76b5f998c8b2c64c622a6b654ba`；失败根 `/private/var/folders/xm/lf7020f924g8h8qf_k899b6c0000gn/T/excalidraw-desktop-e2e-7W21bo` 含 `history-restart-failure.json` 和前端状态。该 smoke 是实际失败，不得计作性能样本；T049 的预算 verdict 仍为 `not_evaluated`。修复旅程后仍须完成物理机基线/候选配对与规定 VM 的测量。

2026-09-25 只读环境审计：本机 `prlctl --version` 返回 `27.0.1 (58670)`；名为 `macOS26.5.2` 的 VM 处于 suspended 状态，`prlctl list -i` 显示 4 vCPU、12288 MB 内存。该名称不证明 guest 的实际 OS/build。2026-09-29 安装的 Parallels app `Info.plist` 仍报告 `27.0.1`；本次 sandbox 中 `prlctl` 因 `/bin/ps` 权限失败，无法重新核对 VM 实际资源或 guest。已确认的 Parallels 版本与声明的 `26.4.1` 不符，旧 VM 内存记录也与约 8 GiB 不符；未恢复或修改 VM，未运行参考测量。当前环境不能进入既定 reference series，也不能把它的结果与旧系列直接配对。

- 已确认并固定：基线 commit、比较字段、物理 macOS 诊断→Parallels reference VM 的顺序、参考 VM 预算、环境分代规则、进程树计量边界及二进制占位规则。
- 已尝试但无效：物理 macOS 基线 `startup-idle`，原始失败报告如上；未形成完整 T090 冷启动样本。
- 尚未执行：同一物理 macOS 有效配对诊断、Parallels Desktop Pro 26.4.1 VM 测量、候选版本测量及其他 T090/T108 原始报告。
- 因此当前总体状态是 `not_evaluated`，不是预算 `pass`、预算 `fail` 或 speedup/regression 结论。
