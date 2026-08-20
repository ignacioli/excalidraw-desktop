[English](CONTEXT.md) | [简体中文](CONTEXT.zh.md)

# Excalidraw Desktop

本上下文定义 Excalidraw Desktop 本地图纸工作区与文档导航所使用的统一语言，并区分磁盘上的持久条目和应用中当前打开的图纸。

## 统一语言

### 工作区导航

**Workspace（工作区）**：
用户授权给应用使用的本地目录，其中的图纸与普通目录可在应用内访问。
_避免使用_：项目、仓库、资料库

**Workspace Root（工作区根目录）**：
Workspace 的顶层目录。它可以被挂载到应用或从应用移除，但不是可在应用内重命名或删除的普通条目。
_避免使用_：根条目、顶层文件夹

**Workspace Entry（工作区条目）**：
Workspace 内直接呈现的 Drawing 或 Directory。
_避免使用_：节点、项目、文件系统对象

**Drawing（图纸）**：
应用可使用的受支持 Excalidraw 文件；它既可以作为 Workspace Entry 出现，也可以经获准的文件选择直接打开。
_避免使用_：文档、画布文件

**Directory（目录）**：
Workspace 内由用户管理的普通文件夹。
_避免使用_：工作区、集合

**Protected Directory（受保护目录）**：
不参与普通重命名和删除操作的隐藏目录或应用管理目录。
_避免使用_：系统文件夹、锁定文件夹

### 已打开图纸生命周期

**Open Document（已打开文档）**：
一个 Drawing 在应用内唯一的编辑会话，包含其未保存状态与冲突状态。
_避免使用_：已打开文件、标签页

**Orphaned Document（孤立文档）**：
原始 Drawing 路径已不可用的 Open Document。
_避免使用_：已删除标签页、丢失文件

**Active Drawing（活动图纸）**：
当前显示在画布上的 Open Document。
_避免使用_：选中文件、聚焦标签页

### 壳层导航

**Workspace Sidebar（工作区侧边栏）**：
呈现已挂载 Workspace 及其条目的应用区域。
_避免使用_：文件管理器、资源管理面板

**Transient Sidebar（临时侧边栏）**：
临时覆盖画布并在交互结束后关闭的 Workspace Sidebar。
_避免使用_：浮动侧边栏、自动隐藏面板

**Pinned Sidebar（固定侧边栏）**：
在用户取消固定前持续参与窗口布局的 Workspace Sidebar。
_避免使用_：固定式侧边栏、永久侧边栏
