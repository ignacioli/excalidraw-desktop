# History 实现前设计映射

状态：2026-09-29 建立，字体家族已由负责人统一为既有系统字体；本表不是视觉通过记录。

## 权威与约束

- 组件几何：[T048 tokens](high-fi/tokens.json)；共同颜色、字号、字重：[HF-2 tokens](../desktop-shell/hf-2/tokens.json)。
- 结构与角色：[默认 Light](high-fi/screens/01-history-default-light.png)、[重复 Mark](high-fi/screens/05-repeated-mark-long-list-light.png)、[compact Dark](high-fi/screens/06-history-compact-dark.png)。不修改批准图片来适配实现。
- 字体家族按负责人本轮决定统一继承既有系统字体；[共享 DESIGN](../../../DESIGN.md) / [中文](../../../DESIGN.zh.md) 为当前权威，[HF2-FONT-001](../../evidence/003-visual-acceptance/font-decision.md) 保留历史及范围更新。不引入 Inter，不新增字体资源；冻结导出中的家族名不覆盖此共享决定。

## 组件映射

| 区域 | 必须落实的批准设计 | 实现位置 |
| --- | --- | --- |
| Header | 仅保留 `Version History` 标题 20px / 600、文件名 12px / 400 和关闭按钮；2026-09-30 负责人要求移除重复 eyebrow | HistoryPanel / history.css |
| Current drawing | 59px 卡片；Light app.background、Dark surface.background；随后计数与 30px Mark 按钮同行 | HistoryPanel / history.css |
| 历史行 | 摘要 14px / 600 在上；时间与来源 12px / 400 在下；状态徽标第三层；82px 行高、6px 圆角 | HistoryList / historyFormat / history.css |
| 状态 | Ready 与 Marked 不重复作为同一行的并列主状态；Unavailable 保留警示图标和明确文字 | HistoryList / history.css |
| 选中行 | Light surface.hover、Dark surface.active；左侧 accent 强调；选中不改变外部尺寸 | history.css |
| 固定详情 | 12px 标签；摘要 16px / 600；版本 ID 位于时间/来源的元数据行 | HistoryPanel / history.css |
| 固定操作 | Preview / Restore 同行保持批准的 146:174 宽度比例（compact 按比例收缩）、38px 高；Restore 使用 accent / contrast | HistoryPanel / history.css |
| 重复 Mark | 按批准画板布置反馈，不以普通长段落或空白占位挤占列表；不重新调查已停止处理的轻微弹跳 | HistoryPanel / history.css |
| 保留策略 | 保留说明的可访问性，但不在默认画面插入高保真没有的大段正文 | HistoryPanel |

数据文案不是固定示例：没有可靠摘要时使用 `Canvas changed`；不能复制画板中的虚构摘要；只知道已加载数量时不得称为全部版本总数；没有证据时不得声称 `no content change`。

## 开发前与开发后的检查

1. 改 UI 前，给现有浏览器检查补充基于上述来源的设计约束，并在当前实现上记录差异。断言不能以当前 CSS 值作为期望值。
2. 实现使用现有共享 token 和本表中的组件角色；不得依赖默认 heading 字重、默认 button 外观或另建一套视觉数值。
3. 同一批组件修改结束后跑相关测试。字体 ready 后生成一个匹配状态的实际渲染，由主代理先对照批准画板检查完整结构；再决定是否值得打包。
4. Native 只检查剩余平台呈现事实。测试、浏览器图和原生 owner 判断分别记录，不新增逐屏审批或证据平台。

负责人已确认 Tab tooltip 正常；对 Mark 区域的轻微肉眼弹跳，负责人明确表示不一定真实、可能是错觉，并要求停止修复。保留该观察，不标记为已修复，也不继续扩大调查。

## Penpot 回填与暂停

2026-09-29 已回填共享字体说明及 typography token 绑定，新增 `T048 · 07 · Unavailable Version · Light · Draft`。当前 Penpot file `a5ac146a-5787-80fa-8008-b3c2d0b30bae`，page `87d1db27-904b-80ba-8008-aeafe0fb388d`；quick-check revision 98。默认 Light、compact Dark、Unavailable 已做一次视觉抽查；7画板140个文字角色绑定检查无差异，文件校验0错误。仍待负责人 Review，不等于设计批准或产品验收。

直接读取设计 shape 后纠正了初始映射中的“等宽”推断：批准按钮为146:174。初次设计检查报告中等宽断言是错误预期，已修正；其余字号/字重/行高等偏差保留。文字13/11px等未绑定值已按统一body/label角色回填共享token，不为History新增独立字号体系。

代码对齐已按负责人要求暂停：当前未完成改动包含typecheck失败（Mark callback的void结果处理）及5项定向测试失败；没有进行修后browser或native验证，不继续打包。
