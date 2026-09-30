# Local Version History 高保真

**当前唯一权威版本：2026-09-30 负责人 Review 通过的 7 张画板。** 此目录不按任务编号或修订日期再分层；历史版本由 Git 保存。设计批准不表示产品实现、原生验收或 Phase 7 已完成。

## 文件

- [manifest.json](manifest.json)：批准范围、Penpot 身份、图片尺寸和 SHA-256。
- [tokens.json](tokens.json)：组件角色与几何；引用共享 desktop-shell token，不定义独立的字体/颜色体系。
- [source/excalidraw-desktop-uxui-redesign.penpot](source/excalidraw-desktop-uxui-redesign.penpot)：可编辑设计的恢复源文件。
- `screens/`：当前批准的 PNG 截图。

- [T048 · 01 · History · Default · Light](screens/01-history-default-light.png)
- [T048 · 02 · Row Actions · Light](screens/02-row-actions-light.png)
- [T048 · 03 · Version Preview · Light](screens/03-version-preview-light.png)
- [T048 · 04 · Restore Confirmation · Light](screens/04-restore-confirmation-light.png)
- [T048 · 05 · Repeated Mark · Long List · Light](screens/05-repeated-mark-long-list-light.png)
- [T048 · 06 · History · Compact 300 · Dark](screens/06-history-compact-dark.png)
- [T048 · 07 · Unavailable Version · Light · Draft](screens/07-unavailable-version-light.png)

## 使用约束

实现先读取 [设计映射](../implementation-map.md)、本 manifest 与 token，再查看相关画板。整个应用沿用 [共享 DESIGN](../../../../DESIGN.md) 的系统字体；Penpot 缺少 SF Pro/system-ui，导出使用的 Inter/IBM Plex 仅是明确标注的渲染 proxy。正文/标签/徽标与字重绑定共享 token；Header 保留主标题、文件名、负责人追加批准的 History info 和关闭按钮；Preview/Restore 为 146:174 比例、38px 高；Unavailable 是本轮批准的第七个状态，源画板保留的 Draft 后缀不改变批准状态。

`desktop-shell` 与 `local-version-history` 本轮仍分目录管理，均遵循同一套共享视觉规范；设计系统提取、汇总与合并留待后续，不在此次整理中进行。

## 来源与历史

首次归档使用负责人提供的下载文件；本次H1回填后，File.export仍失败，已从负责人现有Chrome Ignacio profile的Penpot tab执行 File → Download Penpot file。当前source为该Web UI原样下载文件，ZIP完整性、file/page身份、7个信息入口及425处anatomy元数据均已核对；archive revision104，与MCP记录分别保存。7张PNG均为1280×760，未手工拼装归档。

旧 `t048/`、`revisions/` 和更早高保真由 Git 提交 `45630f81c429ba30effe12118c200f193e713745` 保存；历史证据中的旧路径与哈希指向当时版本，不重写成当前设计。`task` 字段和原画板名称仅保留兼容/追溯用途，不组织目录，也不代表多套当前高保真。

## H1 component anatomy 回填（2026-09-30）

负责人追加选择标题旁 `History info` 按钮，七张当前PNG已同步；Penpot画板及入口附有指向 implementation-map 的组件元数据。默认画面只增加低强调入口，保留规则按需展开。已抽查默认Light，确认标题、入口和Close没有重叠。

API失败后已使用Web UI下载完成source同步，manifest的 `currentBackfillIncluded: true` 绑定本次入口和元数据。Computer Use已退出，未关闭负责人原有tab。
