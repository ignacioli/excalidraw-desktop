# History component-first 执行记录

日期：2026-09-30。当前状态：H4 首轮 owner review FAIL，反馈位置/生命周期、滚动条与 hover 正在定向修复；此前 H0–H3 结果保留，T048/native 未完成。

## 设计与组件

- 共享入口：`docs/design/components.md`；History anatomy：`docs/design/local-version-history/implementation-map.md`。
- 负责人选择Header旁History info入口。7张PNG已更新；Penpot7画板/425处组件元数据已回填。
- `File.export`仍报`No matching clause`；改用负责人现有Chrome Ignacio profile的Penpot tab → File → Download Penpot file，取得2,653,046-byte源文件。ZIP身份、7个信息入口、425处anatomy字段已验证，archive revision104；source/digests见唯一high-fi manifest。Computer Use随后停止并reset。
- 不合并设计目录、不新增Storybook、不重开Mark微动调查、不变更Rust/IPC持久化路径。

## 发现与纠正

| 层          | 发现                                                                              | 处理                                                                                               |
| ----------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 静态review  | 空portal host会拦截正常画布点击                                                   | 空host禁pointer events，preview子层恢复；现有真实editor绘图测试复验                                |
| 静态review  | Preview A后选B可能借用A的ready状态Restore                                         | active Preview时绑定selected/preview/rendered目标；Ready无Preview仍允许直接Restore确认             |
| 静态review  | retention移除预览项后canvas可能留在inert                                          | 缺失目标时退出、失效异步请求和清理状态；定向review未发现该路径剩余P1/P2                            |
| 首轮browser | Footer45px/比例偏差、drawer边框不符                                               | 对齐批准38px/146:174与strong border                                                                |
| 测试维护    | 旧aria-label定位器、毫秒fixture、Chromium字体alias、默认已选Unavailable被重复点击 | 改用真实region/rendered属性，秒单位，记录系统字体alias等价；检查默认选中而非强制点击禁用语义option |
| 渲染对照    | Footer次按钮背景/对齐、Preview工具栏分裂、Unavailable详情文案角色                 | 按既有anatomy同批修正，不修改高保真迁就实现                                                        |

## 验证记录

- 首次命令参数排列错误：Playwright将文件路径当作project，未执行测试；修正参数顺序。
- sandbox运行：Chromium MachPort Permission denied，测试未进入产品；相同headless命令在sandbox外运行。
- [首轮browser](browser-first.txt)：10/15 PASS，5 FAIL如上。
- [定向复跑](browser-retest.txt)：失败5项5/5 PASS；不是一次完整15/15运行。
- [最终受影响组件/组合复验](browser-final.txt)：4/4 PASS；覆盖默认层级、300px Dark、Unavailable、画布侧Preview及当前draft不变。
- [原有语义套件](semantic-pass.txt)：5/5 PASS；此前漏开VITE_E2E_HARNESS的[准备失败](semantic-setup-failure.txt)保留，非产品回归。
- UI实施代理报告focused Vitest 5 files / 82 tests PASS，包含A→B目标绑定、缺失Preview项退出、info键盘与日期格式；strict typecheck及本范围ESLint PASS。Primary随后pnpm lint、pnpm build、pnpm format、git diff --check PASS；build保留既有大chunk提醒。
- Primary已查看默认Light、compactDark、Unavailable与canvasPreview的实际PNG，确认本轮anatomy/字重/固定动作/状态区域；SDK示例内容、真实数据文案和已有外壳尺寸与画板示意不同，不声称整屏像素相同。PNG仅为browser组件/组合证据，不证明WKWebView原生表现。

## 原生准备

复用`prepare_history_visual_fixture`在独立系统临时目录生成50条历史、pending和resource-unavailable。首次`/private/tmp`被工具安全边界拒绝，改用真实系统TMPDIR成功；未修改日常profile、未启动原生App。进入集中session前仍需新production包、精确身份、入口验证及桌面时间协调。

本轮private specs的plan/T059已追加组件先验收的执行顺序，仍保持未提交；T059/T058/T048均未预先勾选。

## 当前原生候选与入口

产品提交`7562954f3f85e93c30345ceb237d56debf15b48a`，production build/seal PASS；package SHA-256 `cf8705c11650309bcd92303074d650b2d82a8aacef15261c9af073598f57e6e7`，身份见[manifest](package-manifest.json)。本轮误先执行单独build，而seal自带build，产生一次重复构建；后续直接seal，不重复。

首轮入口收集因调用方使用解析fixture前profile摘要，adapter拒绝封存；[失败](native-entry-binding-failure.txt)保留。按既有resolver契约修正摘要并新建profile后，同包History原生入口13/13 PASS，见[native-entry](native-entry/)。未改harness或产品以绕过断言。

负责人已授权现在复查。当前owner session PID73056，使用新合成profile，普通1280×760窗口，无置顶；Computer Use已停止。原生视觉与owner结论仍待逐项反馈，不由入口PASS代替。

## H4 反馈修复进展

- [Owner review](owner-review.json)记录原生首轮缺陷；没有将未反馈的检查项计作通过。
- 负责人确认成功提示位于画布右下靠近 History；使用 right 24px / bottom 64px、最新一条、4 秒消失，后续操作替换。History info 增加 hover，保留键盘和点击。
- Penpot 已回填，05 PNG 已更新；复用本地已配置官方 Playwright MCP 扩展成功下载 revision105，唯一 source/manifest/tokens 已同步，ZIP与位置/生命周期/7处hover元数据已核对。下载后断开连接，未关闭用户标签页。
- [本次 browser 回归](browser-feedback-hover-fixes.txt)：2/2 PASS，覆盖 Mark→Unmark 单一反馈、定位与消失、hover 不抢焦点、键盘关闭及细滚动条。仅证明 browser；修复包原生复查仍待执行。
- 本轮独立静态 review 发现 Preview 期间成功提示位于 inert/遮挡层；已移至 canvas 可见 sibling。加强原有同一 browser 用例后 [1/1 PASS](browser-preview-feedback-fix.txt)，直接检查无 inert 祖先及命中测试，未用截图猜测。其余 timer/error 保留和 hover/keyboard 路径未发现 P1/P2。
- 修复过程中新增 unit 的 fake-timer/userEvent 组合曾超时，另捕捉到 Escape 回焦触发弹层重开；修复测试驱动和焦点抑制后，相关两文件 75/75 PASS。Primary 全局 lint PASS；格式检查首次仅 AppShell.tsx 未格式化，待收口复验。
- 最终 UI agent 两文件 75/75 PASS、strict typecheck PASS；Primary 全局 lint、最终 format 与 diff check PASS。本次 H2/H3 受影响路径已收口，修复包 H4 仍未验收。
