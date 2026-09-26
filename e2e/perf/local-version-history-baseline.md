# Local version history performance baseline

状态：**正式性能测量尚未执行**（T003/T049）；history 专项 smoke 已运行，预算仍为 `not_evaluated`

本文件定义功能 004 的可比较性能证据格式。它不是测量结果，也不把计划中的二进制、环境或预算写成已经执行的事实。

## 基线身份

功能前基线提交固定为：

```text
babc027d64c2c50e6922482b416ef1099ea9d07e
```

基线和候选版本必须在同一环境、同一工作负载、同一夹具 seed 和同一 runner 命令下各自生成报告。报告的 `commit` 必须是实际 checkout 的 40 位 Git commit；不能用分支名、缩写或“当前版本”代替。

每个报告还必须包含新增的 `binary` 对象（见 `report.schema.json`）：

| 字段 | 规则 |
| --- | --- |
| `binary.path` | 测量时实际启动的可执行文件的 `realpath`，不使用 glob、别名、符号链接或仅能推断的目录。准备阶段使用 `<PENDING: exact executable realpath>`；占位符不得进入有效 `pass`/`fail` 报告。 |
| `binary.sha256` | 对上述精确文件按字节计算的完整 64 位小写 SHA-256；准备阶段使用 `<PENDING: sha256 of exact executable>`，不得使用缩写、bundle 名称或 Git commit 代替。 |
| `binary.kind` | `e2e-harness` 或 `production`。T090/T108 性能负载必须明确记录测试专用 harness；生产包行为不能由 harness 结果冒充。 |
| `binary.pathScope` | `absolute` 表示原始 runner 路径；`workspace-relative` 仅用于去除工作区根目录后的机器报告。若采用后者，配套证据仍须能还原并核对原始绝对路径。 |

当前只记录基线 commit，尚未构建或测量该 commit 的二进制，因此不填入路径和 hash。候选版本必须另有提交、路径和 hash；不能把基线 hash 复制给候选版本。

## 比较环境

比较单位是“同一环境内的基线／候选配对”，不是物理机与虚拟机之间的绝对值比较。每条报告都要记录 `report.schema.json` 现有的 `hardware`、`memory`、`architecture`、`logicalCores`、`osVersion`、`webviewVersion` 和 `executionEnvironment` 字段；缺少任何一项时该样本为 `not_evaluated`，不能进入回归判定。

### 同一物理 macOS：迭代诊断配对

T049 先在同一物理 macOS 上运行基线／候选的共同启动、编辑、保存和空闲负载，用于快速发现产品回归和工作负载问题。这是 non-blocking diagnostic trend，不是 fixed hard gate 或 authoritative reference 结果。首个实际运行前必须把以下占位符替换成系统采集值：

| 元数据 | 要求 |
| --- | --- |
| `hardware` | 精确 Mac 型号与芯片字符串；不得只写芯片系列。 |
| `memory` | `bytes` 与 `gibibytes`，以实际物理 macOS 报告为准。 |
| `architecture` / `logicalCores` | `arm64` 及实际逻辑核数。 |
| `osVersion` | 精确 macOS product version 与 build，例如 `macOS <version> (<build>)`。 |
| `webviewVersion` | 精确系统 WebKit/WKWebView framework 版本。 |
| `executionEnvironment` | `{ "type": "physical", "hostHardware": "<exact host hardware>", "virtualization": null }`。 |

### 可比较参考虚拟机

这是本项目的 authoritative auditable reference series；它只在同一 VM 配置内比较基线／候选。当前声明的配置来自 ADR-004 和功能 plan，仍须由运行时报告核实：

| 元数据 | 声明值／运行时要求 |
| --- | --- |
| 宿主机 | `Apple M5 Pro / 48GB`；必须由宿主配置核对，不能从虚拟 guest 字符串反推。 |
| 虚拟化 | `Parallels Desktop Pro`，版本 `26.4.1`；版本变化开启新的测量 series。 |
| guest OS | `macOS 26.5.2 (<exact build>)`；build 必须实测确认。 |
| guest resources | `architecture=arm64`、`logicalCores=4`、`memory≈8 GiB`。 |
| WebView | `<PENDING: exact guest WebKit framework version>`，必须由 guest 运行时采集。 |
| `executionEnvironment` | `{ "type": "virtual", "hostHardware": "Apple M5 Pro / 48GB", "virtualization": { "name": "Parallels Desktop Pro", "version": "26.4.1" } }`。 |

参考 VM 使用 `self-hosted`、`macOS`、`ARM64`、`excalidraw-perf` runner labels；这些 labels 只负责路由，不代表某一物理机型号。只有完整的 VM 环境字段、二进制身份和工作负载样本齐全时，结果才可作为 authoritative reference evidence。

宿主硬件、Parallels 版本、guest OS/build、vCPU、guest memory、WebView 或显示协议变化时，停止 before/after 直接比较，创建新的 series，并在 ADR/验证汇总中记录 rebaseline 原因。报告不得写入机器唯一标识、账号、token 或其他秘密。

## 工作负载、采样与预算

所有采样使用 monotonic clock；进程资源统计覆盖 Tauri 主进程及关联 WebView/GPU/Network 进程。必须在报告的 `processTreeAccounting` 中列出关联方法、纳入的进程类别、排除项和平台限制。浏览器或单独 Tauri 主进程数据不能代表应用进程树。

| 指标 | 预热与采样 | 统计／单位 | authoritative reference budget |
| --- | --- | --- | --- |
| 冷启动至 editable canvas | 每组 10 次冷启动；每次从 spawn 前开始，至 `ready.json` 证明 API ready、`editable=true` 且画布可编辑结束；不把 warm start 混入 | nearest-rank P95，毫秒 | `<= 2,000 ms` |
| 空闲 RSS | 进程树进入稳定空闲后 warm-up 30 s；连续 60 s、1 s 间隔采样 | 进程树 RSS nearest-rank P95，bytes | `<= 500 MB` |
| 空闲 CPU | 与空闲 RSS 使用同一稳定窗口 | 单逻辑核归一化 CPU P95，百分比 | `<= 35%` |
| 10,000-element 稳定 RSS | 加载确定性 10,000-element fixture，待 `ready.json` 和稳定窗口完成；不得只计 root Tauri 进程 | 进程树 RSS nearest-rank P95，bytes | `<= 950 MB` |
| 编辑 soak 增长 | warmed baseline 后运行 15 min scripted editing（ADR-006）；结束后同口径采样 | `rssGrowthBytes` 与 `rssGrowthPercent` | 同时 `<= 50 MB` 且 `<= 15%` |
| 静置写入 | 编辑／保存完成并进入 quiescent 后观察 60 s；覆盖 application-managed data directories 与 mounted workspaces | `eventCount=0` 且持久 `changedPathCount=0` | 零持续写入 |

工作负载名称、fixture/seed、持续时间、采样间隔、warm-up、统计方法、预期方差、原始报告路径和报告 SHA-256 必须写入报告或配套证据。参考 VM 的预算失败仍记录为 `verdict.overall=fail`，但不阻断 merge 或 open-source release；缺少完整窗口、二进制身份或环境元数据则为 `not_evaluated`，不能降级成通过。物理 macOS 诊断结果不得替代参考 VM 证据。

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

2026-09-26 修正 T024 fixture 时间基准后，以产品提交 `b6fca0d77d2b3e9d06b7f866fbd6ff79eaa56766` 的 test-only binary（SHA-256 `c43012c081fc8d9616194bc61db1eceb9eb693ebaf896419d44353e03acfab49`）运行一次 history 专项工作负载 smoke，1/1 PASS。原始 JSON 为 `/private/tmp/history-t049-smoke-b6fca0d.json`（SHA-256 `4a3801de9054784b5bf29f4d7d34bea72dc4cd410cf5ee9faa19ca902ed38f37`）：20 条池、A→B→A、恢复后场景与图片哈希、资源和 GC 检查均通过；单次旅程耗时 `1913.049167 ms`，仅为描述值。第一次调用遗漏 `PERF_TEST=1`，Playwright 报 `No tests found`，未进入产品旅程；加上该配置开关后才产生上述报告。该报告的 `executionEnvironment.type` 为 `unspecified`，未做基线／候选配对、进程树资源采样或规定 VM 运行，`verdict.overall` 仍为 `not_evaluated`；它只解除先前 smoke 的功能失败，不构成 T049 性能验收。

2026-09-26 T049 候选工作负载 smoke 已启动，但实际 test-only 前端 A→B→A 旅程在 `frontendB` 收到 `HISTORY_UNAVAILABLE`，没有生成可比较的性能 JSON。当前候选 `ab67c3c43ee69ae32a040bb3e6f9c762807d8c3c` 的测试专用二进制 SHA-256 为 `0a24d93a280c7db4c0231a3a244dcdd70928f76b5f998c8b2c64c622a6b654ba`；失败根 `/private/var/folders/xm/lf7020f924g8h8qf_k899b6c0000gn/T/excalidraw-desktop-e2e-7W21bo` 含 `history-restart-failure.json` 和前端状态。该 smoke 是实际失败，不得计作性能样本；T049 的预算 verdict 仍为 `not_evaluated`。修复旅程后仍须完成物理机基线/候选配对与规定 VM 的测量。

2026-09-25 只读环境审计：本机 `prlctl --version` 返回 `27.0.1 (58670)`；名为 `macOS26.5.2` 的 VM 处于 suspended 状态，`prlctl list -i` 显示 4 vCPU、12288 MB 内存。该名称不证明 guest 的实际 OS/build。Parallels 版本与声明的 `26.4.1`、VM 内存与声明的约 8 GiB 均不符；未恢复或修改 VM，未运行参考测量。当前环境不能进入既定 reference series，也不能把它的结果与旧系列直接配对。

- 已确认并固定：基线 commit、比较字段、物理 macOS 诊断→Parallels reference VM 的顺序、参考 VM 预算、环境分代规则、进程树计量边界及二进制占位规则。
- 尚未执行：同一物理 macOS 配对诊断、Parallels Desktop Pro 26.4.1 VM 测量、候选版本测量、任何 T090/T108 原始报告生成。
- 因此当前状态是 `not_evaluated`，不是 `pass`、`fail` 或 speedup/regression 结论。
