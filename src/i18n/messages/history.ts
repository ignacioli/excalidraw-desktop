// History copy, merged into en.ts / zh-CN.ts. Keep this file to TypeScript
// syntax that Node can strip directly: scripts/native-menu-check.mjs imports
// the catalogs.
export const historyEn = {
  // Version metadata
  "history.source.automatic": "Automatic",
  "history.source.manual": "Manual",
  "history.source.protected": "Protected",
  "history.source.beforeRestore": "Before restore",
  "history.source.beforeClear": "Before clear",
  "history.source.beforeImport": "Before import",
  "history.deleteSource.manual": "manual",
  "history.deleteSource.automatic": "automatic",
  "history.time.unknown": "Unknown time",
  "history.time.today": "Today · {time}",
  "history.time.yesterday": "Yesterday · {time}",
  "history.summary.canvasChanged": "Canvas changed",

  // Version list
  "history.list.label": "Version history",
  "history.status.unavailable": "Unavailable",
  "history.status.current": "Current",
  "history.status.preview": "Preview",
  "history.status.marked": "Marked",
  "history.status.ready": "Ready",

  // State views
  "history.state.retry": "Try again",
  "history.state.loading.title": "Loading version history",
  "history.state.loading.message": "Retrieving saved versions…",
  "history.state.empty.title": "No saved versions",
  "history.state.empty.message":
    "Versions will appear here after this drawing is saved.",
  "history.state.processing.title": "Updating version history",
  "history.state.processing.message":
    "This operation is still being processed. The current file is unchanged.",
  "history.state.permissionDenied.title": "Version history access denied",
  "history.state.permissionDenied.message":
    "This file does not allow access to its version history. Check its permissions and try again.",
  "history.state.conflict.title": "Version history conflict",
  "history.state.conflict.message":
    "The file changed outside Excalidraw Desktop. Resolve the conflict before restoring a version.",
  "history.state.resourceUnavailable.title": "Version resource unavailable",
  "history.state.resourceUnavailable.message":
    "A saved version or one of its resources is unavailable. The current file has not changed.",
  "history.state.error.title": "Version history could not be loaded",
  "history.state.error.message":
    "Your current file is unchanged. Try loading version history again.",

  // Preview
  "history.preview.label": "Version preview",
  "history.preview.title": "Preview · {version} · {summary}",
  "history.preview.separation":
    "Read-only snapshot. The current drawing remains separate and unchanged.",
  "history.preview.exitLabel": "Exit version preview",
  "history.preview.exit": "Exit preview",
  "history.preview.canvasRegion": "Read-only canvas preview",
  "history.preview.ready": "Preview content is ready.",
  "history.preview.renderFailed": "This version could not be rendered safely.",
  "history.preview.preparing": "Preparing version preview…",
  "history.preview.imageAlt": "Read-only version canvas",
  "history.preview.staticLoadFailed":
    "The static version preview could not load.",

  // Protected input
  "history.input.dropMissingData":
    "The dropped content doesn’t contain readable drawing data.",
  "history.input.dropCanvasUnavailable":
    "The dropped image’s canvas is no longer available.",

  // Panel chrome
  "history.panel.title": "Version History",
  "history.panel.infoLabel": "History info",
  "history.panel.closeLabel": "Close version history",
  "history.panel.close": "Close",
  "history.panel.resizeLabel": "Resize version history panel",
  "history.panel.resizeHelp":
    "Left Arrow moves the divider left and increases width by 10 pixels; Right Arrow moves it right and decreases width by 10 pixels. Home sets 300 pixels; End sets 360 pixels. Hold Shift to resize by 20 pixels.",
  "history.panel.retention.title": "Version retention",
  "history.panel.retention.body":
    "Automatic and before-operation versions share the newest 20 entries. They do not expire by age. Manual marks stay until you delete them.",

  // Current drawing section
  "history.panel.current.region": "Current drawing",
  "history.panel.current.title": "Current drawing",
  "history.panel.current.canvas": "Open canvas",
  "history.panel.count.one": "{count} version shown",
  "history.panel.count.other": "{count} versions shown",
  "history.panel.markCurrent": "Mark current version",
  "history.panel.markingCurrent": "Marking current version…",

  // Row actions
  "history.panel.moreActionsFor": "More actions for {target}",
  "history.panel.moreActions": "More version actions",
  "history.panel.mark": "Mark version",
  "history.panel.unmark": "Unmark version",
  "history.panel.delete": "Delete version",

  // Mark feedback
  "history.panel.feedback.marked": "Marked",
  "history.panel.feedback.alreadyMarked": "Already marked · no new version",
  "history.panel.feedback.unmarked": "Unmarked",
  "history.panel.feedback.announce": "{message} · {identity}",
  "history.panel.notice.markedTitle": "Version marked",
  "history.panel.notice.markedMessage": "Version marked and saved to history.",
  "history.panel.notice.unmarkedTitle": "Version unmarked",
  "history.panel.notice.unmarkedRemoved":
    "Version unmarked and removed by the retention policy.",
  "history.panel.notice.deletedTitle": "Version deleted",
  "history.panel.notice.deletedMessage": "Version deleted from history.",

  // Selected version section
  "history.panel.selected.region": "Selected version actions",
  "history.panel.selected.eyebrowUnavailable": "Selected version · unavailable",
  "history.panel.selected.eyebrowReused": "Selected version · reused target",
  "history.panel.selected.eyebrowTarget": "Selected version · action target",
  "history.panel.selected.unavailableReason":
    "{reason} Your current drawing is unchanged.",
  "history.panel.selected.preview": "Preview",
  "history.panel.selected.restoreLabel": "Restore this version",
  "history.panel.selected.restore": "Restore",

  // Dialogs
  "history.panel.cancel": "Cancel",
  "history.panel.deleteDialog.title": "Delete {version}?",
  "history.panel.deleteDialog.description":
    "Delete the {source} version from history? This cannot be undone.",
  "history.panel.deleteDialog.delete": "Delete",
  "history.panel.deleteDialog.deleting": "Deleting…",
  "history.panel.restoreDialog.title": "Restore this version?",
  "history.panel.restoreDialog.description":
    "The current drawing will be replaced after a protected snapshot is created.",
  "history.panel.restoreDialog.target": "Target: {version} · {summary}",
  "history.panel.restoreDialog.restore": "Restore version",
  "history.panel.restoreDialog.restoring": "Restoring…",

  // Guards and failures
  "history.panel.guard.documentChanged":
    "The history document changed. Reopen the version menu before acting.",
  "history.panel.guard.menuVersionUnavailable":
    "This version is no longer available. Reopen the history menu to choose an available version.",
  "history.panel.guard.restoreChanging":
    "Version history is changing. Cancel and reopen Restore when the list is ready.",
  "history.panel.guard.restorePreviewUnavailable":
    "A safe preview of this version is no longer available. Cancel and preview it again before restoring.",
  "history.panel.guard.restoreVersionUnavailable":
    "This version is no longer available. Cancel and choose an available version.",
  "history.panel.error.markFailed": "The current version could not be marked.",
  "history.panel.error.updateFailed":
    "The selected version could not be updated.",
  "history.panel.error.deleteFailed":
    "The selected version could not be deleted.",
  "history.panel.error.restoreFailed":
    "The selected version could not be restored.",
} as const;

export const historyZhCN: Record<keyof typeof historyEn, string> = {
  "history.source.automatic": "自动",
  "history.source.manual": "手动",
  "history.source.protected": "受保护",
  "history.source.beforeRestore": "恢复前",
  "history.source.beforeClear": "清空前",
  "history.source.beforeImport": "导入前",
  "history.deleteSource.manual": "手动",
  "history.deleteSource.automatic": "自动",
  "history.time.unknown": "时间未知",
  "history.time.today": "今天 · {time}",
  "history.time.yesterday": "昨天 · {time}",
  "history.summary.canvasChanged": "画布已更改",

  "history.list.label": "版本历史记录",
  "history.status.unavailable": "不可用",
  "history.status.current": "当前",
  "history.status.preview": "预览中",
  "history.status.marked": "已标记",
  "history.status.ready": "可用",

  "history.state.retry": "重试",
  "history.state.loading.title": "正在载入版本历史",
  "history.state.loading.message": "正在读取已保存的版本…",
  "history.state.empty.title": "没有已保存的版本",
  "history.state.empty.message": "此绘图保存后，版本会显示在这里。",
  "history.state.processing.title": "正在更新版本历史",
  "history.state.processing.message": "此操作仍在处理中，当前文件未更改。",
  "history.state.permissionDenied.title": "无法访问版本历史",
  "history.state.permissionDenied.message":
    "此文件不允许访问其版本历史。请检查文件权限后重试。",
  "history.state.conflict.title": "版本历史冲突",
  "history.state.conflict.message":
    "文件已在 Excalidraw Desktop 之外被更改。请先解决冲突，再恢复版本。",
  "history.state.resourceUnavailable.title": "版本资源不可用",
  "history.state.resourceUnavailable.message":
    "某个已保存的版本或其资源不可用，当前文件未更改。",
  "history.state.error.title": "无法载入版本历史",
  "history.state.error.message": "当前文件未更改。请再次尝试载入版本历史。",

  "history.preview.label": "版本预览",
  "history.preview.title": "预览 · {version} · {summary}",
  "history.preview.separation": "只读快照。当前绘图保持独立，不会被更改。",
  "history.preview.exitLabel": "退出版本预览",
  "history.preview.exit": "退出预览",
  "history.preview.canvasRegion": "只读画布预览",
  "history.preview.ready": "预览内容已就绪。",
  "history.preview.renderFailed": "无法安全地渲染此版本。",
  "history.preview.preparing": "正在准备版本预览…",
  "history.preview.imageAlt": "只读版本画布",
  "history.preview.staticLoadFailed": "无法载入静态版本预览。",

  "history.input.dropMissingData": "拖放内容缺少可读取的绘图数据。",
  "history.input.dropCanvasUnavailable": "拖放图片所在的画布已不可用。",

  "history.panel.title": "版本历史",
  "history.panel.infoLabel": "历史记录说明",
  "history.panel.closeLabel": "关闭版本历史",
  "history.panel.close": "关闭",
  "history.panel.resizeLabel": "调整版本历史面板宽度",
  "history.panel.resizeHelp":
    "按向左箭头键将分隔条左移并使宽度增加 10 像素；按向右箭头键将其右移并使宽度减少 10 像素。按 Home 设为 300 像素；按 End 设为 360 像素。按住 Shift 可每次调整 20 像素。",
  "history.panel.retention.title": "版本保留规则",
  "history.panel.retention.body":
    "自动版本和操作前版本共享最新的 20 条记录，不会因时间而过期。手动标记的版本会保留，直到你将其删除。",

  "history.panel.current.region": "当前绘图",
  "history.panel.current.title": "当前绘图",
  "history.panel.current.canvas": "已打开的画布",
  "history.panel.count.one": "显示 {count} 个版本",
  "history.panel.count.other": "显示 {count} 个版本",
  "history.panel.markCurrent": "标记当前版本",
  "history.panel.markingCurrent": "正在标记当前版本…",

  "history.panel.moreActionsFor": "{target}的更多操作",
  "history.panel.moreActions": "更多版本操作",
  "history.panel.mark": "标记版本",
  "history.panel.unmark": "取消标记版本",
  "history.panel.delete": "删除版本",

  "history.panel.feedback.marked": "已标记",
  "history.panel.feedback.alreadyMarked": "已标记 · 未创建新版本",
  "history.panel.feedback.unmarked": "已取消标记",
  "history.panel.feedback.announce": "{message}（{identity}）",
  "history.panel.notice.markedTitle": "版本已标记",
  "history.panel.notice.markedMessage": "版本已标记并保存到历史记录。",
  "history.panel.notice.unmarkedTitle": "版本已取消标记",
  "history.panel.notice.unmarkedRemoved":
    "版本已取消标记，并已按保留规则移除。",
  "history.panel.notice.deletedTitle": "版本已删除",
  "history.panel.notice.deletedMessage": "版本已从历史记录中删除。",

  "history.panel.selected.region": "所选版本的操作",
  "history.panel.selected.eyebrowUnavailable": "所选版本 · 不可用",
  "history.panel.selected.eyebrowReused": "所选版本 · 沿用的目标",
  "history.panel.selected.eyebrowTarget": "所选版本 · 操作目标",
  "history.panel.selected.unavailableReason": "{reason}当前绘图未更改。",
  "history.panel.selected.preview": "预览",
  "history.panel.selected.restoreLabel": "恢复此版本",
  "history.panel.selected.restore": "恢复",

  "history.panel.cancel": "取消",
  "history.panel.deleteDialog.title": "删除 {version}？",
  "history.panel.deleteDialog.description":
    "要从历史记录中删除这个{source}版本吗？此操作无法撤销。",
  "history.panel.deleteDialog.delete": "删除",
  "history.panel.deleteDialog.deleting": "正在删除…",
  "history.panel.restoreDialog.title": "恢复此版本？",
  "history.panel.restoreDialog.description":
    "创建受保护的快照后，当前绘图将被替换。",
  "history.panel.restoreDialog.target": "目标：{version} · {summary}",
  "history.panel.restoreDialog.restore": "恢复版本",
  "history.panel.restoreDialog.restoring": "正在恢复…",

  "history.panel.guard.documentChanged":
    "历史记录所属的绘图已更改。请重新打开版本菜单后再操作。",
  "history.panel.guard.menuVersionUnavailable":
    "此版本已不可用。请重新打开历史记录菜单，选择可用的版本。",
  "history.panel.guard.restoreChanging":
    "版本历史正在变化。请取消，待列表就绪后重新打开“恢复”。",
  "history.panel.guard.restorePreviewUnavailable":
    "此版本的安全预览已不可用。请取消，重新预览后再恢复。",
  "history.panel.guard.restoreVersionUnavailable":
    "此版本已不可用。请取消，并选择可用的版本。",
  "history.panel.error.markFailed": "无法标记当前版本。",
  "history.panel.error.updateFailed": "无法更新所选版本。",
  "history.panel.error.deleteFailed": "无法删除所选版本。",
  "history.panel.error.restoreFailed": "无法恢复所选版本。",
};
