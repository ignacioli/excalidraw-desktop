# T049 M5 Pro 物理配对（2026-10-04）

**T049 已批准的物理机测量范围已完整完成，diagnostic budget FAIL 保留。** 共同 startup、canvas、完整15分钟 soak 均有有效配对；candidate soak 在Harness修复后以第三次运行完成。首次自动屏保导致的无效运行及第二次owner审查中断记录均保留。History 专项已完成1次预热与3次完整样本，workload PASS，耗时只作描述。原始 diagnostic `fail` 如实保留，不自动阻断 merge 或 release；本记录不授予 T054 owner 接受，也不宣布 Phase 7 或 release 完成。机器可读身份、digest、原值及差值见 [comparison.json](comparison.json)。

## 环境、身份与可比性

全部有效报告为 schema `2.0.0`，实际物理机为 `Mac17,9 (Apple M5 Pro)`、48 GiB、arm64、15 logical cores、macOS `26.6.2 (25G83)`、WebKit `21624.5.1.11.3`。执行为 `PERF_REFERENCE_RUN=0` / `physical`。按 owner 于 2026-10-04 的决定，本轮跳过不可用的 Parallels；没有 VM PASS，也不将物理数据移入历史 VM series。

| 身份                                | Baseline                                                               | Candidate 共同负载                                                      |
| ----------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Product source                      | `babc027d64c2c50e6922482b416ef1099ea9d07e`                             | `eb961ca8c8b221c34a11989d5e4d37e9a9e8f537`                              |
| Build checkout                      | 同 baseline source                                                     | `711ce26ff94976e91d48ad39970b7ca46e22152a`                              |
| Runner checkout / raw report commit | 同 baseline source                                                     | startup/canvas：`849b1ffcff908146f288ed9ac4330153d925ce11`；soak：`8ec98ca3d9cc840fefe5682699d01d7bd838464c` |
| Binary SHA-256                      | `c5e6cd8ed502a0a2b9f002bfb71441833d2d049607fb6a445af22a16eb0cee8b`     | `3b641885ffa43a439f99ca16ad8c424830fb2a16f2ec16cbcc932bd66d95fe99`      |
| 构建绑定                            | [corrected binding](../baseline-build-20261004/corrected-binding.json) | [corrected binding](../candidate-build-20261004/corrected-binding.json) |

每个 run 的 `binding.json` 保存实际 binary path、报告和解压 runner log 的 SHA-256；soak 另有 health digest。原报告不改写。Baseline runner 没有报告内 `binary` 字段，身份由独立 binding 提供；candidate raw commit 是 runner checkout，不冒称 build checkout。Candidate startup 的 `hostHardware` 标签格式不同，实际 hardware、memory、cores、OS、WebKit 字段完全一致。

Startup/canvas 两侧 runner 的实际 Git diff 只新增测量前 binary hash/provenance 与报告字段，以及一处 CPU 表达式格式。Candidate soak runner另增加utility-scoped `caffeinate`、fatal error及时消费和部分样本保留（`8ec98ca`）；workload、seed、计时起止、统计、采样窗口、进程关联方法和预算未变。共同负载使用独立隔离数据目录、单 worker、零 retry。当前 startup 和 canvas 的 `workload`、`budget`、`processTreeAccounting` 内容逐项相同，可以描述本次配对差值。

## 预算和工作负载

依据 [performance baseline](../../../../e2e/perf/local-version-history-baseline.md)、`PERF_BUDGETS` 及 ADR-006/007/008，预算使用十进制 MB，不为这次运行改变阈值：

- Startup：10 次新进程和新数据 root，spawn 前至 `ready.json` 的 editable empty canvas，monotonic clock / nearest-rank P95；预算 ≤2,000 ms。随后 30 s 预热、60 s / 1 s 采样，idle 全树 RSS P95 ≤500 MB。
- Canvas：确定性 10,000 rectangles，30 s 预热、30 s RSS / 1 s 采样，30 s 恒定 zoom=1 平移，60 s / 3,600 次脚本编辑；稳定全树 RSS ≤950 MB、平移 ≥30 FPS、最大 rAF interval ≤100 ms、观察文件事件/编辑比 ≤0.01。
- Soak：30 s 预热、60 s warmed baseline；完整 900,000 ms 编辑 / 10 s 资源采样，5 s settle 后 60 s / 1 s 静置采样；全树 RSS 增长同时 ≤50 MB 且 ≤15%，idle CPU P95 ≤单逻辑核35%，静置文件事件和持久路径变化均为0。
- History：仅候选，另有 `VITE_E2E_HISTORY_FRONTEND=1` 构建；1 次预热、3 次完整 A→B→A 旅程，描述性 P95，不编造不存在的 baseline History 或专项资源预算。

## 完整测量结果

| 指标                    | Baseline    | Candidate   | Candidate − Baseline  | Diagnostic budget             |
| ----------------------- | ----------- | ----------- | --------------------- | ----------------------------- |
| Editable startup P95    | 1,769.80 ms | 2,112.38 ms | +342.58 ms / +19.36%  | Baseline PASS；Candidate FAIL |
| Idle 全树 RSS P95       | 315.11 MB   | 313.82 MB   | −1.29 MB / −0.41%     | 双方 PASS                     |
| 10k 全树 RSS P95        | 613.83 MB   | 1,366.77 MB | +752.94 MB / +122.66% | Baseline PASS；Candidate FAIL |
| 恒定 zoom 平移          | 59.98 FPS   | 31.74 FPS   | −28.24 FPS / −47.08%  | 双方 PASS                     |
| 平移最大 rAF interval   | 32 ms       | 60 ms       | +28 ms                | 双方 PASS                     |
| 编辑最大 rAF interval   | 62 ms       | 413 ms      | +351 ms               | Baseline PASS；Candidate FAIL |
| 文件事件/3,600 脚本编辑 | 0 / 3,600   | 0 / 3,600   | 比值差0               | 双方 PASS                     |

Startup 原报告：[baseline](../physical-startup-20261004/corrected/startup-idle.json) / [candidate](candidate-startup/startup-idle.json)，cold samples 均10；idle samples 分别61/60。Canvas 原报告：[baseline](baseline-canvas/canvas-io.json) / [candidate](candidate-canvas/canvas-io.json)，RSS samples 均30，pan/edit contract 均完整。

[有效 baseline soak 重测](baseline-soak-002/edit-soak.json)包含完整15分钟、3,600事件、warmed/soak/quiescent `60/90/60` 个资源样本；实际 driver 编辑时长 `900,007 ms`。Warmed RSS P95 `674.32 MB`、post-soak `822.71 MB`，增长 `148.39 MB / 22.01%`，两项增长预算 **FAIL**；idle CPU P95 `12.3%`、静置 `0` events / `0` changed paths **PASS**。候选对应结果与差值如下。

[有效 candidate soak](candidate-soak-003/edit-soak.json) 同样包含完整15分钟、3,600事件及 `60/90/60` 个资源样本，实际编辑 `900,003 ms`、结束时visible。Warmed RSS P95 `604.65 MB`、post-soak `1,149.29 MB`，增长 `544.64 MB / 90.07%`，两项增长预算 **FAIL**；idle CPU P95 `15.6%`、静置 `0` events / `0` changed paths **PASS**。Candidate − baseline：post-soak RSS **+326.58 MB**，RSS增长 **+396.25 MB（+267.03%）**，增长率 **+68.07 percentage points**，idle CPU **+3.3 percentage points**；静置事件／路径差均0。

[最终 binding](candidate-soak-003/binding.json) 保留原报告、解压log、health digest及 unchanged common binary身份。运行中 [awake assertion](candidate-soak-003/awake-assertions.txt) 生效，结束后 [记录](candidate-soak-003/awake-assertions-after.txt) 和primary核查确认释放，无持久系统设置修改。有效 baseline仍完整visible，不因候选Harness修复重新运行。Health记录的实际UTC窗口分别为 `2026-10-04T17:11:42.210Z–17:27:18.872Z` 与 `2026-10-04T22:04:16.311Z–22:20:51.205Z`；首观察相隔约4小时52分34秒。同日同硬件／OS／WebKit，workload／seed／预算／统计／进程口径完全相同，但没有控制此间背景负载和内存压力，也未交错运行；assertion只控制display/system idle，保留为配对方法差异。

[History 专项有效报告](candidate-history-002/local-version-history.json)在独立 history binary 上完成 **1次预热＋3次完整 A→B→A 样本，PASS_WORKLOAD**。三次耗时 `1558.379125 / 1573.335958 / 1564.361667 ms`，nearest-rank P95为 `1573.335958 ms`。每次均20条池和20条保留，四个列表观察均20；A/B场景与恢复后digest相符、adoption/旧autosave拒绝、对象/asset存在、GC目标保留检查均通过。原始预算 verdict **`not_evaluated`** 保留：没有批准的独立History耗时或RSS/CPU预算；这不构造旧baseline的History差值。

History独立 binary SHA-256 为 `e8e703560193ef907a6922eeceb311f0e13773535d84615932c8bc1d474534cd`，build checkout为 `849b1ffcff908146f288ed9ac4330153d925ce11`，见 [build report](../history-build-20261004/build-report.json)；启用了 `VITE_E2E_HISTORY_FRONTEND=1`，与共同负载binary分别绑定。有效run的runner/raw commit为 `91c5d7b36266935c64bd855a9956e8ae0526d73d`，见 [run binding](candidate-history-002/binding.json)。该提交仅修正runner/type中的证据阶段，未改product runtime，因此复用上述binary。原始报告、解压runner log、build与binary身份已核对，3条样本的absolute facts和P95已独立重算。

## 无效尝试与保留边界

第一次 [baseline soak](baseline-soak/edit-soak.json) 的 raw verdict 为 `not_evaluated`，runner exit1，root process 后来已退出。Owner 明确确认点击、拖拽或滚动，但具体动作/时点没有记录；[operator record](baseline-soak/operator-interference.json)标记 `INVALID_OPERATOR_INTERFERENCE`，**整次排除配对**。过程退出的准确原因、与人工动作的因果关系均未建立；不把误操作推断成 crash 原因。只有该 workload 重测为 `baseline-soak-002`，原始失败与 health/log 保留。

第一次 [candidate soak](candidate-soak/edit-soak.json) 也为 `not_evaluated` / runner exit1，标记 `INVALID_WINDOW_HIDDEN`，**整次排除配对**。原始 [driver error](candidate-soak/observed-error.json) 记录 `visibilityState=hidden` 且 `requestAnimationFrame` 连续 `10,199 ms` 无帧；该错误先被保存，primary 随后按 [termination record](candidate-soak/termination.json) 主动停止唯一匹配的 owned PID `72464`。因此最终 raw report 的 `root process ... is not running` 是停止后的观察，不能替代先出现的 hidden/no-frame 原因，也不能写成已证实的产品 crash。实际 warmed samples 为60，soak/quiescent samples 均0，没有有效15分钟编辑或静置窗口；报告中的配置 `actualDurationMs=900000` 不证明窗口已执行。系统日志随后确认空闲1,200秒触发自动屏保，见[最小诊断记录](candidate-soak/automatic-screensaver.json)；owner明确未操作电脑，不能归因于人工操作或产品crash。Valid baseline-soak-002 保持有效，不因该候选失败整体重跑。

第一次 [History预热失败 binding](candidate-history-001/binding.json)标记 `FAILED_WARMUP_ASSERTION`，未产出performance report，测量样本0。Runner错误地从 `verifyB/A` 读取 `staleAutosaveRejected`，实际producer是 `frontendB/A`，因 `undefined` 失败。修复提交 `91c5d7b` 移动类型字段与断言读取阶段，并保留/扩展session-generation、clean draft、hash与dirty防旧autosave断言；没有删除失败断言来取得PASS。该次失败log保留，只有修正后的 `candidate-history-002` 进入有效专项结果。

Primary报告该runner修复的 scoped typecheck 与 lint **PASS**；full e2e TypeScript check 仍有既有 DOM/config 错误，未宣称全量typecheck通过，也未扩展本轮产品范围去修复。专项原生run实际PASS与全量check的限制分别保留。

此前 devUrl 构建导致的 startup INVALID 仍在 [原记录](../physical-startup-20261004/README.md)；它不是本次 corrected binary 的有效预算样本。

## 回归结论、归因与限制

本次完整 startup/canvas 配对观察到候选冷启动、10k RSS 和编辑冻结超预算，平移仍达预算但明显低于本次 baseline。完整 soak 双方均存在增长预算失败，候选本次增长明显更高。当前差值描述实际运行，不从一次测量归因到 History、Rust persistence 或 WebContent；还没有分角色 profile 和受控重复配对，也未指定产品优化 owner。

资源计量覆盖 Tauri、associated WebView、GPU、Network；全部有效资源样本均记录每类1个进程。排除无关/启动前已存在的 WebKit 进程。launchd-reparent 关联假设采样窗口内没有其他同用户 WebKit app 启动；`ps etime` 有1 s粒度/2 s余量，RSS 可能重复计共享页面，CPU 为 OS 区间估计，100%代表一个逻辑核。文件观察仅覆盖指定 app-managed roots 与合成 mounted workspace；`fs.watch` 可合并通知，metadata snapshot 也不能捕捉窗口内创建并删除的短命文件，0 events 不解释为物理磁盘从未写入。

每个角色/workload 只有一次完整运行，未交错或重复统计；RSS 约10%运行波动、startup individual samples约20%波动的预期不用于抹掉 FAIL。10个 cold samples 的 nearest-rank P95 是该组最大值，candidate 第一次 `2,112.38 ms` 保留；新进程不保证 OS cache-cold。物理环境不同于历史 VM/旧30分钟或旧口径，不能直接比较历史绝对值。

第二次[candidate soak](candidate-soak-002/review-interruption.json)在owner要求任务合理性审查时由primary中断，未形成有效样本，不算新的产品失败；临时assertion已释放。Incident审查发现两项MEDIUM Harness执行问题（环境保持、错误消费延迟），未发现需要删除15分钟窗口的HIGH/BLOCKER规格问题。Owner已批准修复后只补candidate完整soak，现已有效完成，并复用全部既有有效报告。T049测量完整性完成；T054产品接受仍由owner单独决定，当前报告不授予该决定。预算 FAIL 保持可见，不自动成为 release hard gate。
