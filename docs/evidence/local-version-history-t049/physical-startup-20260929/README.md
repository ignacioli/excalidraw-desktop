# T049 物理 macOS 基线 startup-idle 尝试（2026-09-29）

**状态：INVALID / `not_evaluated`。** Playwright 单项命令退出码为 1；原始报告的 `verdict.overall` 为 `not_evaluated`。10 次冷启动要求中仅 4 次得到 editable-canvas `ready.json`，第 5 次等待 15,000 ms 后超时。没有完整冷启动窗口，不计算 startup P95，也不据此判定预算、产品回归或性能瓶颈。本次没有自动重试。

测试运行时，操作员将挡住工作的 Excalidraw 窗口最小化；该动作的精确时间无法与各次样本对应。test-only harness 在 `EXCALIDRAW_PERF_CONTROL_DIR` 存在时请求 `set_always_on_top(true)`，但现有证据不能判定最小化与 `ready.json` 超时的因果关系。此次尝试整体不进入基线／候选配对。测试命令已经退出；随后以仅列 PID 与可执行路径的进程检查确认无 `excalidraw-desktop` 可执行进程残留。没有再启动、激活或重启应用。

## 身份和原始文件

| 项目 | 实际值 |
| --- | --- |
| 基线提交 | `babc027d64c2c50e6922482b416ef1099ea9d07e`，测量前后 checkout 干净 |
| binary | `/private/tmp/t049-20260929-baseline-target/release/excalidraw-desktop`，`e2e-harness`，Mach-O arm64 |
| binary SHA-256 | `158fc23d122d5595b3950e934da77014b119f0382f393afac95a5628caa50511` |
| 原始报告 | [startup-idle.json](startup-idle.json)，SHA-256 `aa57685492a4d469156b3886b4618a4d1f7436696b0b58c21602752be249c686` |
| 运行前 binding | [startup-idle-binding.json](startup-idle-binding.json)，SHA-256 `923c63f18e8106628957645d0137d0cda33d922fbb4bb16637e9e360cb4d66ac` |
| Guard | claim `t049-baseline-physical-startup-001`，attempt `1fd9d648-36b7-4d05-a79b-a48eb7df86b6`，`EXECUTED` / process exit `FAIL` (1) |

binding 在运行前写入，故其 `reportState: pending` 是创建时状态，不能当作运行后结论。旧基线 runner 不向 JSON 写 `binary` 对象；binding 单独记录真实 executable `realpath`、hash 以及 runner 文件 hash。两份文件均按原字节归档，未改写原始报告的 verdict。

原始报告记录物理 `Mac17,9 (Apple M5 Pro)`、48 GiB、macOS 26.6.2 `(25G83)`、WebKit `21624.5.1.11.3`。它含 4 个 cold-start ready 样本、5 个 process-alive 样本和 60 个空闲进程树样本；空闲 RSS P95 为 329,908,224 bytes，观察到 0 次写入。进程树样本包含 Tauri、WebView、GPU、Network 各 1 个进程。由于用户操作时间未知且冷启动窗口不完整，这些绝对值仅作为失败诊断保留，不构成有效物理基线或 reference VM 证据。
