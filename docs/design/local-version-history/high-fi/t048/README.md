# T048 高保真设计基线

**状态：产品负责人于 2026-09-28 批准六张 T048 画板。** 这是设计批准，不是 production UI、原生包视觉验收或最终功能接受。

本目录是 T048 修订的仓库权威设计资料。后续 specs 和实现先读取本目录的 `manifest.json`、`tokens.json` 与所需画板；共享 shell 颜色、排版和圆角的唯一数值来源是 `docs/design/desktop-shell/hf-2/tokens.json`，本目录只记录 T048 组件如何使用这些 token。Penpot 是可编辑设计载体，不能以其未归档的后续改动覆盖此基线。已批准的 T004 设计仍保存在上级 `high-fi/`，属于之前的独立范围。

六个状态依次展示：默认 Light、行级操作菜单、历史预览、恢复确认、未变化内容重复 Mark 的反馈与长列表目标、300 px compact Dark。画板均为 1280×760；默认 drawer 为 360 px。当前绘图独立于历史行，所选历史版本与 Preview/Restore 固定在 drawer 底部。

T048-02 的行级菜单按审阅反馈保持 180 px 宽、约 40 px 的操作行；浅灰色小标题再次显示 `v-050 · Canvas spacing pass`，使菜单自身也能说明操作目标。包含标题时高度为 116 px。Mark 使用 16 × 16、1 px 描边的空心书签，Delete 使用同规格的空心垃圾桶；旧实心色块已隐藏。8 px 圆角、浅边框与轻阴影承接既有 shell 规范，Delete 保持独立分隔与危险色。此设计仍待产品负责人批准。

`manifest.json` 保存精确 file/page/shape ID、PNG 与源文件 SHA-256、尺寸和校验边界。`tokens.json` 保存从批准画板和 Penpot token 集提取的 T048 组件角色与几何，引用而不复制 HF-2 的共有 token 数值。Light 关键形状绑定 Penpot 语义 token；Dark 画板在 Light 为文件全局活动主题时以批准的 Dark token 数值静态呈现，不能把这点写成 Dark 形状已有活动主题绑定。

可编辑源 `source/excalidraw-desktop-uxui-redesign.penpot` 由产品负责人从 Penpot 手动导出。ZIP 完整性与内部 file/page ID、六个画板 ID 已核对；归档内的 `revn` 为 93，Remote MCP 在设计批准时读取到 92，两个观测分别保留，不推断其差异原因。实现以本目录批准的画板、token 映射和交互合同为准；`.penpot` 用于恢复和进一步设计编辑。
