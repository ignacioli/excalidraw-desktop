# History component-first 执行记录

日期：2026-09-30。状态：H0–H3完成（组件与browser组合范围）；T048/native未完成。

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
