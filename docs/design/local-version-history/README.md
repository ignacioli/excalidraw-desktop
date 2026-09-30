# Local Version History 设计资料

本 feature 只有一份当前权威高保真：[high-fi/](high-fi/README.md)，为负责人于 2026-09-30 Review 通过的 7 张画板。历史版本由 Git 保存，不按 task ID 或 revisions 再建立高保真子目录。

- [interaction.md](interaction.md)：交互、语义、状态与可访问性规则。
- `low-fi/`：此前交互原型及其批准记录；不是当前高保真，也不是产品实现证据。
- [high-fi/manifest.json](high-fi/manifest.json)：当前设计身份、批准范围与校验信息。
- [high-fi/tokens.json](high-fi/tokens.json)：引用共享 token 的组件映射。
- [high-fi/screens/](high-fi/screens/)：当前批准的 7 张截图。
- [high-fi/source/excalidraw-desktop-uxui-redesign.penpot](high-fi/source/excalidraw-desktop-uxui-redesign.penpot)：可编辑源的恢复文件。
- [implementation-map.md](implementation-map.md)：开发前的组件角色与设计约束。

当前继续与 `desktop-shell` 分目录存放，遵守同一套共享设计系统；后续再考虑提取、汇总和合并。设计批准不替代产品实现验证及原生视觉验收。历史证据中的旧路径和摘要按原记录保留，可从 Git 提交 `45630f81c429ba30effe12118c200f193e713745` 恢复。
