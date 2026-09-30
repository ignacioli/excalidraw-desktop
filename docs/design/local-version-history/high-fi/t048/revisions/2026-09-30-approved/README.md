# 2026-09-30 批准的 History 高保真修订

**状态：负责人 Review 通过，已归档。** 本次只记录设计批准，不表示当前产品实现、原生视觉验收或 Phase 7 完成。

本修订保留统一系统字体标准及明确的 Penpot 字体 proxy 说明，将文字角色绑定到共享 token，移除重复 header 小标题，并补充 Unavailable 状态。底部按钮保留批准的 146:174 比例。旧批准截图及源文件不覆盖；从本修订起，History 视觉实现以本目录截图和共享 DESIGN 规范为准。

## 截图

- [T048 · 01 · History · Default · Light](screens/01-history-default-light.png)
- [T048 · 02 · Row Actions · Light](screens/02-row-actions-light.png)
- [T048 · 03 · Version Preview · Light](screens/03-version-preview-light.png)
- [T048 · 04 · Restore Confirmation · Light](screens/04-restore-confirmation-light.png)
- [T048 · 05 · Repeated Mark · Long List · Light](screens/05-repeated-mark-long-list-light.png)
- [T048 · 06 · History · Compact 300 · Dark](screens/06-history-compact-dark.png)
- [T048 · 07 · Unavailable Version · Light · Draft](screens/07-unavailable-version-light.png)

## 源文件与校验

- [Penpot 源文件](source/excalidraw-desktop-uxui-redesign-2026093001.penpot)：使用负责人下载的原始文件，未重新打包或修改。
- [Manifest](manifest.json)：记录每张 PNG 的 SHA-256、1280×760 尺寸、源文件哈希、身份与批准范围。
- ZIP 完整性、file/page 身份、7 个画板 ID、7 个重复 eyebrow 的 hidden 状态均核对通过。
- 导出前后 MCP revision 均为 101；下载归档内部 revision 为 102。两者分别记录，不推断差异原因。
- 第 07 张源画板名保留 `Draft` 后缀；其批准状态以本次明确 owner 决定和 manifest 为准。

按负责人要求，提交后停止，等待 incident Review；本轮没有启动 incident Review、产品修复、测试或打包。
