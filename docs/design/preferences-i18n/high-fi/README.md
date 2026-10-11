# 画布主菜单高保真（双语与精选偏好）

**当前唯一权威版本：2026-10-09 负责人 Review 通过。** 范围只包括画布主菜单（CANVAS-MAIN-MENU）的展开态与强制只读态，English / 简体中文 × Light / Dark。设计批准不代表产品实现、浏览器验收或原生验收已完成。

## 文件

- [manifest.json](manifest.json)：批准范围、负责人原话、Penpot 身份、测量依据、图片尺寸和 SHA-256。
- [source/excalidraw-desktop-uxui-redesign.penpot](source/excalidraw-desktop-uxui-redesign.penpot)：可编辑设计的恢复源文件，由负责人通过 Penpot 网页界面下载，原样归档（archive revision 128）。
- `screens/`：当前批准的 PNG（1280×760）。
  - [01 · Expanded · English · Light](screens/01-expanded-en-light.png)
  - [02 · Expanded · 简体中文 · Light](screens/02-expanded-zh-light.png)
  - [03 · Expanded · English · Dark](screens/03-expanded-en-dark.png)
  - [04 · Expanded · 简体中文 · Dark](screens/04-expanded-zh-dark.png)
  - [05 · Forced read-only · English · Light](screens/05-forced-readonly-en-light.png)
  - [06 · Forced read-only · 简体中文 · Dark](screens/06-forced-readonly-zh-dark.png)

## 使用约束

实现先读 [实现映射](../implementation-map.md)，再看本 manifest 和相关画板。菜单视觉归 SDK 所有：几何、颜色、字体和图标取自锁定版本 `@excalidraw/excalidraw` 0.18.1 的实测值，图标是复制的 SDK SVG，没有重绘。顶栏是复用的 HF-2 已批准画板。Penpot 没有 PingFang SC，中文用 Noto Sans SC 作渲染替身；运行时由 WebKit 回退到系统中文字体。

## 负责人决定（2026-10-09）

- **SDK 中文缺翻译**：同意采用方案 D，用 pnpm 补丁补齐 SDK `zh-CN` 语言包，配覆盖率测试，并回馈上游。画板中「在画布上查找」「主题」即来自该补丁。
- **语言下拉箭头**：采用 B，即宿主样式的上下双 chevron（macOS 弹出按钮惯例），不使用 SDK 私有 CSS 类。对照画板「Language select · chevron options · DECIDED B」保留在 Penpot 页面中。
- **整套画板**：Review 通过。

本轮审阅中新增并获批准的设计决定：

- 选中标记使用 SDK 菜单项的 `selected` 底色，不加对勾，因为 SDK 0.18.1 没有导出图标。
- 语言选择用单行下拉，选项为「跟随系统 / English / 简体中文」。
- 强制只读时，不可用项的文字和快捷键以 40% 不透明度显示；View mode 保留选中底色，表示「已开启且不能更改」。

## 来源

Penpot 页面 `06 · Preferences & Language Menu · 005 T004`，file `a5ac146a-5787-80fa-8008-b3c2d0b30bae`，page `61581637-ab2a-807b-8008-c414802509bf`。导出时插件读到的 live revision 是 127，下载归档的内部 revision 是 128，两者分别记录。
