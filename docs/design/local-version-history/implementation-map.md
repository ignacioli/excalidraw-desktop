# History component anatomy 与实现映射

状态：2026-09-30 H0目录及H1文字规范/在线设计回填已完成；可编辑source已通过Web UI同步，H2/H3组件与browser组合验收已完成，native待验。当前七屏高保真已获负责人批准；组件实现验收待执行，不能继承设计批准为产品PASS。

## 权威与实施入口

- 共享组件：[组件目录](../components.md)、[003组件合同](../desktop-shell/hf-2/components.md)、[DESIGN](../../../DESIGN.md)。系统UI字体继承003，不引入History字体体系；Penpot Inter/IBM Plex为设计渲染proxy。
- 当前设计：[manifest](high-fi/manifest.json)、[组件tokens](high-fi/tokens.json)、[共享tokens](../desktop-shell/hf-2/tokens.json)、[交互](interaction.md)。每个组件的值从这些来源取，不从当前错误实现反向提取。
- 文件/page：`a5ac146a-5787-80fa-8008-b3c2d0b30bae` / `87d1db27-904b-80ba-8008-aeafe0fb388d`。本轮已核对实际连接身份、Preview在画布侧、重复Mark反馈在画布侧、Unavailable原因在固定详情区。
- 本文件是History专属anatomy唯一入口。后续feature只引用共享目录并声明reuse/extend/new；不复制History视觉数值成为另一套系统。
- 当前英文文案保持已批准设计；后续语言支持通过统一formatter/copy角色扩展，不在本轮局部混改语言。

## 实施输入与完成条件

每项实现任务必须给组件ID、来源/本节、允许的variant、代表状态和DONE。优先生产组件+已有fixture，无新Storybook；组件验证后才进入页面组合抽检。H0/H1完成是进入H2的条件。

| ID / 分类                       | 代码owner                              | 来源画板       | 关键验收                                                     |
| ------------------------------- | -------------------------------------- | -------------- | ------------------------------------------------------------ |
| HISTORY-PANEL / extend          | HistoryPanel、history.css              | 01/06          | header/body/footer顺序；360→300；只有列表区滚动              |
| HISTORY-CURRENT / new组合       | HistoryPanel                           | 01/05          | Current卡与count/Mark同行；数量真实；反馈不占列表空位        |
| HISTORY-ROW / new组合           | HistoryList、historyFormat             | 01/05/06/07    | summary→metadata→badge；选中accent；长文案可读               |
| HISTORY-ACTIONS / extend        | HistoryPanel                           | 02             | 目标、Mark/Unmark、Delete顺序；键盘/焦点；不被scrollport裁切 |
| HISTORY-DETAIL / new组合        | HistoryPanel                           | 01/05/07       | summary与ID分层；146:174按钮；Unavailable原因与禁用          |
| HISTORY-PREVIEW / extend        | HistoryPreview、HistoryPanel、AppShell | 03             | 在画布区域独立只读展示；drawer保留；退出回焦点；零写入       |
| HISTORY-CONFIRM / reuse+variant | ApplicationDialog、HistoryPanel        | 04             | 目标、说明、Cancel/Restore；初始Cancel焦点、返回             |
| HISTORY-FEEDBACK / extend       | HistoryStates、AppShell、HistoryPanel  | 05/07+行为合同 | 状态/错误可见；重复Mark画布侧提示；标题旁信息入口            |

## HISTORY-PANEL：框架与Header

Anatomy：左边缘separator；header（标题、文件名、关闭）；flex body（当前卡、toolbar、列表/状态）；固定detail/actions。Preview不替代drawer内容。

- 标题仅`Version History`，section20/semibold600；文件名label12/regular400，截断时保留完整accessible name与title。无重复eyebrow。
- 默认360，用户拖动到300；不以窄viewport触发compact。键盘separator沿用现有10/20px及Home/End规则。Header/固定actions不随列表滚动。
- 行和footer使用共享panel/surface；不靠默认h1/h2字重。留足聚焦ring，禁用/焦点规则继承共享合同。
- 验收：360和300 geometry；标题层级/文件名；长列表bottom仍可操作；没有新增常驻保存栏。

## HISTORY-CURRENT：当前卡与toolbar

Anatomy：卡片label `CURRENT DRAWING` → 当前编辑器状态；随后一行 `N versions shown`（实际已加载数量） → `Mark current version`。

- 卡59px；panel内水平边距16px；toolbar Mark30px；count剩余宽度可换行，按钮保持完整文案。compact不转成两个独立大段。
- 没有可靠保存状态时只写`Open canvas`；不得复制样例`no content change`/`saved just now`。数量不冒充总量，单复数正确。
- Mark busy保留几何，禁重复执行；结果null表示取消/切换目标，不产生成功反馈。void回调兼容现有组件调用，不能访问undefined.reused。
- 新mark、row mark/unmark需有可见且无布局跳变的反馈；重复mark按HISTORY-FEEDBACK展示。变更后端行为不在本任务范围。

## HISTORY-ROW：历史版本行

Anatomy：content列依次summary → formatted time · source → status badge；trailing独立More Actions。版本ID放detail，不塞入summary。

- summary：body14/600；不可靠时`Canvas changed`。单行省略保留完整可访问文本/悬停说明。metadata：label12/400；Today/Yesterday+时间，较早日期用短日期，完整日期放time title/dateTime；统一formatter处理无效值，不直接平铺原始时间戳。
- 常规参考行82px/radius6，selected左3px accent+批准surface，无整圈accent替代。默认panel白/暗主题surface；More32px hit/icon16px。
- READY/MARKED为badge；Unavailable优先，带警告图标与danger色，不用虚线表达。marked不重复显示`Manual · Marked`字段。保留marked的可访问语义，preview/当前等组合不得掩盖unavailable。
- 长文案不扩张横向scrollport；状态原因在detail显示完整；metadata可压缩/截断并保留完整文本，不为82px裁掉关键交互。
- 不改变listbox/roving focus/Enter preview既有行为；unavailable仍可选中查看原因，但不能preview/restore。
- 验收：slot顺序与字重；Ready/Marked/Unavailable代表；selected不改变外部尺寸；300px长文件/摘要无横向溢出；键盘语义沿用现有tests。

## HISTORY-ACTIONS：行菜单

Anatomy：目标身份/摘要 → Mark或Unmark → separator → Delete。引用共享menu/focus规则；不能仅提供图标而丢失可访问名称。

- 180×116参考尺寸，menu title截断保留全名；危险动作用共享danger。
- 目标绑定document+version，选择变化不能悄悄重定向已打开菜单；Escape返回触发器；顶部/底部行菜单均不被滚动区域裁切。
- unavailable不意味着所有动作都禁用；沿用安全后端能力，preview/restore禁用，Mark/Delete按既有contract决定。

## HISTORY-DETAIL：固定详情与动作

Anatomy：`SELECTED VERSION · ACTION TARGET`（重复mark可用REUSED TARGET；Unavailable用UNAVAILABLE）→ summary → `v-NNN · time · source` → 可选完整Unavailable原因 → Preview/Restore。

- 标题16/600、其他label12/400；正常参考160px，Unavailable参考176px但内容需要时可长高，列表让出空间。不可硬裁原因。
- Preview/Restore为146:174比例、38px高、gap8；Restore accent/contrast，Preview panel/strong border。不是等宽，也不是按内容任意宽度。
- selected不足/状态不可用时不伪造目标；unavailable显示具体后端原因（没有时使用批准概述）及当前画布未改变说明，两个动作明确disabled。
- Ready无预览时保留直接Restore→确认的既有路径。Preview活跃时，所选目标必须与安全渲染的preview ID一致才可Restore；不要借用另一个版本的renderedVersionId放行。

## HISTORY-PREVIEW：画布侧只读区域

Anatomy：画布侧覆盖层 → toolbar（Preview · v-NNN · summary、只读说明）→ 独立snapshot → 退出入口；History drawer和选中detail保持可见。

- approved03的Preview veil位于x0..920，toolbar56px；不是在360px drawer内部替换列表。生产布局跟随实际可用画布区域，不用整屏fixed覆盖tabs/sidebar。
- 复用HistoryPreview/ReadonlyPreviewCanvas与已有安全scene加载；只变容器及展示，不把preview scene送入当前editor，不拆卸/覆盖其持久化状态。
- Preview loading/error在独立surface显示；Exit/Escape回原触发行，Restore走同一确认。背景编辑器在preview时不可被指针/键盘误编辑，其他文档/退出路径仍明确。
- 容器可用DOM portal连接AppShell canvas区域，保持HistoryPanel状态和dialog/focus owner；禁止依赖SDK私有DOM。
- 验收：snapshot在main canvas而非drawer；drawer列表/target仍在；退出后原场景不变/零写入；loading/error与安全禁用；焦点返回。现有semantic测试若假定drawer内preview，更新容器预期，保留安全断言。

## HISTORY-CONFIRM：恢复/删除确认

复用ApplicationDialog。Restore anatomy：title →保护说明→目标卡→Cancel/Restore；410×276为参考，长文字可扩展。动作40px；Cancel初始聚焦，busy阻重复，失败仍在dialog可读，关闭返回触发控制。Delete沿用已确认目标和不可撤销文案，不新增回收站或恢复系统。

## HISTORY-FEEDBACK：状态和提示

- 重复Mark：画布侧328×77参考notice，标题`Already marked · v-NNN`，正文`No new version. Focus moved to the saved version.`；无列表内长段落或永久空白占位。id绑定当前文档/版本，切换或关闭清理，避免陈旧提示。
- 新mark/row mark/unmark：复用同类非模态可见反馈与live announcement，不仅screen-reader-only；error在操作上下文可读，不用成功提示覆盖error。
- Loading/empty/processing/permissionDenied/conflict/resourceUnavailable/error复用HistoryStateView。title、body、可选Retry按统一text/button角色；没有retry回调不虚构操作，empty不出现Retry。processing避免断言尚未确认的磁盘结果。
- **保留策略已由owner选择标题旁信息按钮**：Header标题行右侧、Close左侧放32px低强调共享IconButton，accessible name/tooltip为`History info`。点击打开锚定信息popover，标题`Version retention`，正文解释最新20条automatic/before-operation共享池、无按年龄过期、manual不自动删除。默认关闭，不挤占列表；按钮aria-expanded/aria-controls，Escape或再次点击关闭，键盘焦点返回入口；点击外部可关闭。Popover内容可选择/阅读，长文案在drawer内换行，不用hover-only tooltip承载完整规则。
- 状态与错误按实际数据，不为像素一致修改业务语义。Recovery仅复用现有异常退出草稿流程。

## 组件与组合验证记录

本轮先执行组件定向unit/结构样式断言，再看一个包含上述组件的代表渲染；不能先打包交owner找错。组合抽检：默认Light完整drawer、300px Dark、Unavailable；Preview/confirmation检查新容器边界。必要平台范围见[acceptance contract](../../evidence/local-version-history-acceptance-contract.md)，不照搬003历史逐屏签字链。

| 批次 | 当前状态 | 完成信号                                                |
| ---- | -------- | ------------------------------------------------------- |
| H0   | DONE     | 共享目录映射实际代码/来源                               |
| H1   | DONE     | 本anatomy+设计元数据回填；保留策略入口决定              |
| H2   | PASS     | 相关formatter/lint/typecheck/unit通过，代表组件视觉符合 |
| H3   | PASS     | 受影响页面组合抽检通过                                  |
| H4   | 未执行   | exact-package集中owner观察覆盖现行合同                  |

历史WIP记录：此前typecheck及5项unit失败，本轮尚未重跑。初始“等宽按钮”assertion已确认是错误oracle，不计产品缺陷。Tab tooltip已owner确认；Mark轻微肉眼弹跳不确定且owner停止调查，本轮不重开。

本轮在线回填：7画板均有History info入口及规范链接，425个相关节点附组件anatomy ID。七屏PNG已保存并更新digest；source API导出失败后已通过Web UI同步，核对7个入口和425处元数据，详见high-fi manifest；不冒称组件或原生验证通过。

H2/H3结果：[component-first记录](../../evidence/local-version-history-t059/component-first/README.md)。测试、primary渲染抽检与native owner验收分别记录，H4未完成。
