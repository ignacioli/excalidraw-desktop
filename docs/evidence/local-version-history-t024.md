# T024：真实进程历史恢复验证

## 当前结论（2026-09-26）

**T024 当前 native A→B→A 旅程：PASS（1/1）。T050 的 T024 回归项随本次复验闭合。** 本轮失败不是历史保留实现回归，而是 Phase 3 的 T024 seed 使用了与运行时相差数十年的固定时间戳；修正 fixture 时间基准后，当前 test-only binary fresh-process 复验通过。

- 产品提交：`b6fca0d77d2b3e9d06b7f866fbd6ff79eaa56766`；改动仅在 T024 harness fixture clock。
- Test-only release binary SHA-256：`c43012c081fc8d9616194bc61db1eceb9eb693ebaf896419d44353e03acfab49`。
- 环境：macOS `26.6.2`（build `25G83`），`arm64`；运行环境由 `sw_vers` 与报告中的 Darwin/arm64 字段核对。
- fresh-process journey：**1/1 PASS**；A→B→A 两次恢复、正常窗口关闭、独立进程验证及后续淘汰/GC 资源读取均记录在原始报告中。
- [本次原始 JSON](local-version-history-t024/t024-2026-09-26-fixture-clock-retest/native-history-restart-evidence.json) SHA-256：`1c1c1cabd9a41cf343429bf5506a702b96889d26e3c9bd28b7691ed8516d29e5`；[binding](local-version-history-t024/t024-2026-09-26-fixture-clock-retest/binding.json)。
- 失败根 `/private/var/folders/xm/lf7020f924g8h8qf_k899b6c0000gn/T/excalidraw-desktop-e2e-7W21bo` 保留为历史诊断数据；原失败不从记录中删除。
- 结论边界：本轮确认并修复 T024 fixture 时间基准，不能据此宣布 T047/T048/T049 或 Feature 004 完成。启动时 SDK 规范化旧格式场景并在没有用户编辑时触发保存，是独立观察。只读追踪确认现有 `hasPersistedSceneChange` 判定早于历史功能；FR-003/004 未定义这种格式规范化是否属于内容变化，因此现有证据不足以判定产品回归或契约违反。若另立产品问题，需要规范文件与旧格式文件的无操作启动对照。

### 根因分类：T024 fixture 时间基准

旧 seed 将完整 20 条历史池的 `recorded_at` 固定为 `1..20`：B 是最旧项，A 次旧，另外 18 条为 filler。前端启动后发生的 automatic checkpoint 使用实际当前时间；由于它晚于 seed 数十年，统一 newest-20 淘汰会先删除 B。之后恢复请求针对已经淘汰的 B 返回 `HISTORY_UNAVAILABLE`。这条排序与淘汰路径解释了失败，且没有要求产品代码改变。

fixture 现以运行时 Unix 时间减 20 秒作为 seed 起点，保留相同的 20 项满池、B 最旧、A 次旧和原有淘汰断言。由此 seed 与运行时处于同一时间窗口，启动时检查点不会仅因 fixture 时间落后数十年而淘汰 B。当前实现见 `src-tauri/src/e2e_harness.rs` 的 `run_history_restart_seed`；本次原始报告记录 seed 20 条、B/A 场景哈希、两个 GUI 进程、两次独立 verify 进程、各自保护记录、池大小与 GC 后对象状态。

旧场景在 SDK 启动时被规范化、随后观察到无用户编辑保存的现象不等同于上面的淘汰根因。本次不据此认定产品实现违反 FR-003/FR-007；它保留为单独的产品契约评估项。

| 记录 | 事实 | 结论 |
|---|---|---|
| 旧失败 | 20 条 fixture 时间戳为 `1..20`，B 最旧；前端启动写入的 automatic 版本排在 B 之后并触发淘汰，恢复 B 报 `HISTORY_UNAVAILABLE` | T024 本次失败由 harness fixture 的时间基准触发；历史 `FAIL` 保留在失败 root |
| 本次修正 | 只将 seed 起点改为运行时附近；保留 20 项、A/B 次序、恢复和淘汰断言 | fixture-only 修正 |
| 本次 fresh run | 当前 test-only binary；fresh process A→B→A；1/1 PASS | 当前 T024 技术旅程 PASS；不推导视觉、性能或生产包结论 |

## 当前结论（2026-09-24）

**T024 技术验收 PASS：native journey 1/1，通过耗时 3.3 秒。**

- 产品与 harness 提交：`113e18b`；此前 marker 隔离修复：`b5ffbda`。
- macOS 26.6.2（25G83），arm64；使用本 worktree 的 `e2e-harness` release binary。
- [原始 evidence](local-version-history-t024/native-history-restart-evidence.json)；[提交、binary 和报告 SHA-256 binding](local-version-history-t024/binding.json)。原始 evidence 从 Playwright 产物逐字节复制。
- 用户随后明确授权完成本轮收尾；private specs 提交 `f724bea` 已将 T024 勾选完成并引用上述验收证据。T025 保持未完成。
- 本轮不进入 T025，不宣称 User Story 1 全部完成、生产包验收、视觉验收、性能验收或 release。

## T024 实际要证明什么

A 与 B 是同一张绘图的两个持久化版本，都有文字、矩形和图片。A→B→A 表示从当前 A 恢复到历史 B，再恢复到历史 A；不是同进程内的 Undo。每次恢复前的当前内容都必须成为可找回的保护历史。

| 检查               | 用户侧意义                                       | 防止的问题                             |
| ------------------ | ------------------------------------------------ | -------------------------------------- |
| 磁盘字节           | 文件真正保存为目标，另一个进程仍能读到           | 只有内存或画面变了，重启后丢失         |
| 画布采用           | 编辑器实际获得正确文字、几何、图片字节           | 文件正确但用户还在编辑旧画布           |
| 版本与请求 ID      | 结果属于选中的历史和本次操作                     | 串版本、串文档、复用上一次成功结果     |
| 资源哈希与图片解码 | 图片字节正确并能被 WebKit 解码                   | 图片丢失、错图、旧缓存或伪图片 fixture |
| 操作引用保护       | 已接受的目标从历史列表淘汰后，恢复仍可读取其对象 | 恢复前新增保护记录反而清掉本次恢复目标 |

普通和保护历史共享 20 条保留池。如果已经有 20 条，恢复最旧目标之前新增保护记录，就可能淘汰目标的历史行。场景和图片对象必须先被固定，不能等历史行消失后再按版本 ID 查找。后续 GC 也不能删掉仍供 operation 状态重放使用的对象。

## 本次通过的具体旅程

1. seed 建立 20 条完整历史，B 最旧、A 次旧，当前文件明确为 A；其初始字节哈希等于 A。
2. 新 GUI 进程通过生产 IPC 列表和 preview 读取 B，校验文字、几何、图片解码及 SHA-256；捕获当前 A。
3. 恢复 B。新增保护 A 导致 B 历史行被淘汰，但固定的目标仍可完成恢复。通过 SDK public readback 验证 B。
4. 测试入口触发正常 window close request，复用生产 `checkpointAll("appExit") → destroy`。父进程要求 `code=0, signal=null`；成功路径不使用 SIGTERM/SIGKILL。
5. 独立 verify 进程核对 B 磁盘字节、Completed operation、共享 DB/document/request 身份、保护 A 的文字/几何/图片，以及池仍为 20、B 行已淘汰。
6. 再启动 GUI 恢复 A，重复上述过程；新保护 B 淘汰 A 行。正常关闭后新 verify 进程核对 A 与可找回的 B。
7. 追加不同场景且使用另一图片的 filler，淘汰剩余 A/B 保护记录。先确认目标场景和图片的 retained-version 引用数均为 0，再执行 GC，再读取 Completed operation；目标场景、图片仍存在且哈希正确。

两轮画布中的图片均解码为 1×1 像素、显示元素几何为 80×80；文字、矩形和图片的位置、尺寸、内容均有断言。图片哈希为 `207ec2682a6a97243715b7b46e0c93eee7dad74cc7f42b825295a8261684a463`。

## Root cause 分类与修复

| 类别    | 已证实问题                                                                                                       | 修复与证据                                                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness | B/A 复用 ready 文件且不核 request/version；可能提前终止 A                                                        | 启动前清理，读取时核身份；旧实现相同测试 7 FAIL，修复后通过                                                                                    |
| Harness | 失败清理销毁 GUI evidence 与 DB                                                                                  | 按阶段保留 root、前序 evidence、错误报告和 Playwright attachment                                                                               |
| 产品    | HOME 外已授权文档的图片不在 asset protocol scope；resolver 的 fetch 也缺对应 CSP connect-src                     | 对已授权 scene 的合法资源授予精确文件访问；校验 canonical path，拒绝 symlink 越界；CSP 只增加所需 asset origin。native canvas hash/decode 通过 |
| 产品    | 先发布保护并淘汰目标行，随后才按目标版本 ID 读取；实际持久化错误为 `IntentCommitted: ... Query returned no rows` | 保护发布前固定并验证目标 bytes/assets，持有 RAII HydrationPin；后续不再查询已淘汰行。最旧目标测试先 FAIL 后 PASS                               |
| Harness | 原 fixture 初始写 B，实际 B→B→A；假 PNG、元素不完整、信号终止、事后淘汰不足以覆盖要求                            | 完整 fixture、真实 A→B→A、正常关闭、保护当场淘汰目标、独立前态验证和 GC 后状态读取                                                             |
| Specs   | 未发现导致失败的需求矛盾                                                                                         | 保持 specs 不变；按既有要求补齐实现与验证                                                                                                      |

历史最后一次 `HistoryStaleDocument` 的原始两端证据此前已被清理，无法追溯确认发生在 verifyA 还是 verifyB。marker 缺陷已机械复现，但不能把推断写成那次历史运行的完整事实。

权限错误分支也经过修复：新替换在 rename 前准备 asset grant；已提交请求重放或状态查询遇到显示授权失败时保留 pending，不把已提交磁盘结果误报为未提交失败，不改变既有 IPC schema。独立 review 发现的这两项 blocker 已关闭。

## 验证与失败记录

- 前端聚焦测试 30/30；HistoryCoordinator 9/9（含已提交但显示不可用仍保留 pending）。ESLint、Prettier、TypeScript、production frontend build 通过。
- Rust 默认配置全量 148/148、`e2e-harness` 配置全量 162/162；随后增加的授权生命周期回归 2/2 通过。Clippy（两种配置）、fmt 通过；最后新增测试模块的 Clippy 排序问题已修正并复验。
- 授权回归覆盖：精确文件、恶意引用/缺文件、symlink 越界、授权错误传播；precommit 拒绝不改磁盘；已提交 replay/status 失败仍可重试，授权恢复后返回 Completed。
- production frontend 包扫描未发现 history driver/close 测试入口；最终 native binary 有意启用测试入口，不作为生产分发包。
- 曾误用仅 `VITE_E2E_HARNESS=1` 构建，因缺少 history frontend driver 而超时，未产生 progress marker。检查编译开关和产物后补齐独立开关；不是通过重复运行碰 PASS。
- 早先 sandbox 内 macOS GUI/XPC 初始化失败；真实 native 验证在 sandbox 外、隔离数据目录执行。
- 既有 `e2e/helpers/fault.test.ts` 有一项预期遗漏 `EXCALIDRAW_E2E_HISTORY_FAULT_ARMED`，本轮未修改；不宣称前端全量 suite PASS。

## 可复用命令

从产品 worktree 根目录执行。构建约 2 分钟，native 验证通常数秒，超时按测试限制报告。

```sh
VITE_E2E_HARNESS=1 VITE_E2E_HISTORY_FRONTEND=1 \
  pnpm tauri build --features e2e-harness --no-bundle

APP_E2E=1 \
EXCALIDRAW_E2E_BINARY="$PWD/src-tauri/target/release/excalidraw-desktop" \
EXCALIDRAW_E2E_HISTORY_RESTART=1 \
PLAYWRIGHT_SKIP_WEBSERVER=1 \
  pnpm exec playwright test e2e/tests/local-version-history-recovery.spec.ts \
    --config=e2e/playwright.config.ts
```

构建后应先确认 `dist/assets` 含 history driver；缺少 `VITE_E2E_HISTORY_FRONTEND=1` 的包不能执行此旅程。成功报告写入 Playwright output directory 的 `native-history-restart-evidence.json`；失败保留隔离 root，不自动删除诊断文件。

## 2026-09-24 记录的下一次会话边界（历史）

在 2026-09-24 的记录点，T024 实现、技术验证及当时引用的证据已完成，下一会话计划从 T025 开始。2026-09-26 的 fixture-clock 复验和当前结论见本文顶部；本历史段不覆盖该更新，也不把 T024 扩大为 US1 全部完成。

独立 review 另指出 HOME 外文档的既有 Recovery Restore／Conflict TakeExternal 返回资源路径尚未应用本轮 exact grant；这不是 T024 已通过路径的证明范围，本轮未扩展修改。这些邻接问题及既有 fault 测试预期差异需要后续有界处理。
