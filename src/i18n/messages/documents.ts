// Documents copy, merged into en.ts / zh-CN.ts / es.ts / ja.ts. Keep this file to TypeScript
// syntax that Node can strip directly: scripts/native-menu-check.mjs imports
// the catalogs.
export const documentsEn = {
  "conflict.title": "File changed on disk",
  "conflict.description":
    "The file was changed outside this app while it had unsaved changes. Nothing is written to the file until you choose what to do.",
  "conflict.externalChanged": "External version changed",
  "conflict.localSaved": "Local draft last saved",
  "conflict.unknownTime": "at an unknown time",
  "conflict.useExternal": "Use external version",
  "conflict.keepLocal": "Keep local changes",
  "conflict.saveAsNew": "Save local changes as new…",
  "conflict.saveDialog.filterName": "Excalidraw drawing",
  "conflict.saveDialog.title": "Save local changes as a new drawing",

  "recovery.title": "Recover unsaved drawings",
  "recovery.description":
    "Excalidraw Desktop found recovery snapshots from an interrupted session. Choose what to do with each drawing.",
  "recovery.candidatesLabel": "Recovery candidates",
  "recovery.snapshotSaved": "Snapshot saved {time}",
  "recovery.unknownTime": "at an unknown time",
  "recovery.untitled": "Untitled drawing",
  "recovery.actionsFor": "Actions for {name}",
  "recovery.restore": "Restore {name}",
  "recovery.keepDisk": "Keep disk version for {name}",
  "recovery.saveAsNew": "Save {name} as new",
  "recovery.discard": "Discard recovery for {name}",
  "recovery.error.chooseDestination":
    "Choose a destination before saving the recovery as a new drawing.",
  "recovery.error.resolveFirst":
    "Resolve recovery candidates before continuing.",
  "recovery.error.startupCheck":
    "Recovery snapshots could not be checked: {reason}",
  "recovery.notice.one": "Recovered · {count} drawing restored",
  "recovery.notice.other": "Recovered · {count} drawings restored",
  "recovery.saveDialog.filterName": "Excalidraw drawing",
  "recovery.saveDialog.title": "Save recovered drawing",

  "workspace.panelLabel": "Workspaces",
  "workspace.eyebrow": "Workspace",
  "workspace.defaultTitle": "Workspace",
  "workspace.actionsLabel": "Workspace actions",
  "workspace.newDrawing": "New Drawing",
  "workspace.newFolder": "New Folder",
  "workspace.collapseAll": "Collapse all",
  "workspace.expandAll": "Expand all",
  "workspace.refresh": "Refresh",
  "workspace.loadingFolder": "Loading folder…",
  "workspace.empty": "No workspace mounted.",
  "workspace.mountFolder": "Mount folder…",
  "workspace.mountDialogTitle": "Mount workspace folder",
  "workspace.menu.actionsFor": "Actions for {name}",
  "workspace.menu.filesNotDeleted": "Files on disk will not be deleted",
  "workspace.menu.rename": "Rename",
  "workspace.menu.delete": "Delete",
  "workspace.menu.copyPath": "Copy Path",
  "workspace.menu.copyRelativePath": "Copy Relative Path",
  "workspace.menu.removeWorkspace": "Remove Workspace",
  "workspace.remove.title": "Remove {name}?",
  "workspace.remove.description":
    "Open drawings from this Workspace will be saved and closed. Files on disk will not be deleted.",
  "workspace.remove.cancel": "Cancel",
  "workspace.remove.confirm": "Remove Workspace",
  "workspace.nested.title": "“{target}” contains an open Workspace",
  "workspace.nested.description":
    "“{workspace}” is already open in another window. A Workspace can't be opened inside another one.",
  "workspace.nested.switch": "Switch to that window",
  "workspace.nested.closeAndOpen": "Close it and open here",
  "workspace.nested.closing": "Closing that window…",
  "workspace.nested.cancel": "Cancel",
  "workspace.nested.notClosed":
    "“{workspace}” was not closed, so “{target}” was not opened.",
  "workspace.tree.label": "Workspace files",
  "workspace.tree.activeDrawing": "Active drawing",
  "workspace.error.loadFolder": "Unable to load this folder.",
  "workspace.error.loadWorkspaces": "Unable to load workspaces.",
  "workspace.error.mount": "Unable to mount this workspace.",
  "workspace.error.mountNoDialog":
    "Choose a directory from the native file dialog to mount a workspace.",
  "workspace.error.remove": "Unable to remove this workspace.",
  "workspace.error.removeOrphaned":
    "Resolve the unavailable open drawing before removing this Workspace.",
  "workspace.error.removeStillClosing":
    "Open drawings are still closing. Try removing the Workspace again.",
  "workspace.error.saveBeforeDelete":
    "Save the open drawing before deleting it.",
  "workspace.error.fileOperation": "The file operation failed.",
  "workspace.error.deleteEntry": "The entry could not be deleted.",
  "workspace.error.revealFolder": "Finder could not open this folder.",
  "workspace.error.outsideWorkspace": "This location is outside the Workspace.",
  "workspace.notice.historyCleanupPending":
    "The drawing was deleted. Version history cleanup is still pending and will be retried later.",
  "workspace.notice.historyResourcesPending":
    "The drawing was deleted. Some version history data has not been cleaned up yet.",
} as const;

export const documentsZhCN: Record<keyof typeof documentsEn, string> = {
  "conflict.title": "文件已在磁盘上更改",
  "conflict.description":
    "此文件在有未保存更改时被应用之外的程序修改。在你选择处理方式之前，不会向文件写入任何内容。",
  "conflict.externalChanged": "外部版本修改时间",
  "conflict.localSaved": "本地草稿上次保存时间",
  "conflict.unknownTime": "未知时间",
  "conflict.useExternal": "使用外部版本",
  "conflict.keepLocal": "保留本地更改",
  "conflict.saveAsNew": "将本地更改另存为新文件…",
  "conflict.saveDialog.filterName": "Excalidraw 绘图",
  "conflict.saveDialog.title": "将本地更改另存为新绘图",

  "recovery.title": "恢复未保存的绘图",
  "recovery.description":
    "Excalidraw Desktop 发现了上次意外中断的会话留下的恢复快照。请选择如何处理每个绘图。",
  "recovery.candidatesLabel": "可恢复的绘图",
  "recovery.snapshotSaved": "快照保存于 {time}",
  "recovery.unknownTime": "未知时间",
  "recovery.untitled": "未命名绘图",
  "recovery.actionsFor": "「{name}」的操作",
  "recovery.restore": "恢复「{name}」",
  "recovery.keepDisk": "保留「{name}」的磁盘版本",
  "recovery.saveAsNew": "将「{name}」另存为新文件",
  "recovery.discard": "放弃「{name}」的恢复内容",
  "recovery.error.chooseDestination":
    "请先选择存储位置，再将恢复内容另存为新绘图。",
  "recovery.error.resolveFirst": "请先处理完恢复项，再继续。",
  "recovery.error.startupCheck": "无法检查恢复快照：{reason}",
  "recovery.notice.one": "已恢复 · 已还原 {count} 个绘图",
  "recovery.notice.other": "已恢复 · 已还原 {count} 个绘图",
  "recovery.saveDialog.filterName": "Excalidraw 绘图",
  "recovery.saveDialog.title": "保存已恢复的绘图",

  "workspace.panelLabel": "工作区",
  "workspace.eyebrow": "工作区",
  "workspace.defaultTitle": "工作区",
  "workspace.actionsLabel": "工作区操作",
  "workspace.newDrawing": "新建绘图",
  "workspace.newFolder": "新建文件夹",
  "workspace.collapseAll": "全部折叠",
  "workspace.expandAll": "全部展开",
  "workspace.refresh": "刷新",
  "workspace.loadingFolder": "正在加载文件夹…",
  "workspace.empty": "尚未挂载工作区。",
  "workspace.mountFolder": "挂载文件夹…",
  "workspace.mountDialogTitle": "挂载工作区文件夹",
  "workspace.menu.actionsFor": "「{name}」的操作",
  "workspace.menu.filesNotDeleted": "不会删除磁盘上的文件",
  "workspace.menu.rename": "重命名",
  "workspace.menu.delete": "删除",
  "workspace.menu.copyPath": "复制路径",
  "workspace.menu.copyRelativePath": "复制相对路径",
  "workspace.menu.removeWorkspace": "移除工作区",
  "workspace.remove.title": "移除「{name}」？",
  "workspace.remove.description":
    "此工作区中已打开的绘图将被保存并关闭。不会删除磁盘上的文件。",
  "workspace.remove.cancel": "取消",
  "workspace.remove.confirm": "移除工作区",
  "workspace.nested.title": "「{target}」包含一个已打开的工作区",
  "workspace.nested.description":
    "「{workspace}」已在另一个窗口中打开。工作区不能嵌套打开。",
  "workspace.nested.switch": "切换到该窗口",
  "workspace.nested.closeAndOpen": "关闭该窗口后在此打开",
  "workspace.nested.closing": "正在关闭该窗口…",
  "workspace.nested.cancel": "取消",
  "workspace.nested.notClosed":
    "「{workspace}」未关闭，因此「{target}」未打开。",
  "workspace.tree.label": "工作区文件",
  "workspace.tree.activeDrawing": "当前绘图",
  "workspace.error.loadFolder": "无法加载此文件夹。",
  "workspace.error.loadWorkspaces": "无法加载工作区。",
  "workspace.error.mount": "无法挂载此工作区。",
  "workspace.error.mountNoDialog":
    "请通过系统文件对话框选择一个目录来挂载工作区。",
  "workspace.error.remove": "无法移除此工作区。",
  "workspace.error.removeOrphaned":
    "请先处理无法访问的已打开绘图，再移除此工作区。",
  "workspace.error.removeStillClosing":
    "已打开的绘图仍在关闭中。请稍后再次尝试移除工作区。",
  "workspace.error.saveBeforeDelete": "请先保存已打开的绘图，再将其删除。",
  "workspace.error.fileOperation": "文件操作失败。",
  "workspace.error.deleteEntry": "无法删除此项目。",
  "workspace.error.revealFolder": "访达无法打开此文件夹。",
  "workspace.error.outsideWorkspace": "此位置不在工作区内。",
  "workspace.notice.historyCleanupPending":
    "绘图已删除。版本历史清理仍待完成，稍后会重试。",
  "workspace.notice.historyResourcesPending":
    "绘图已删除。部分版本历史资源暂未清理完成。",
};

/** English placeholders until the Spanish translation lands. */
export const documentsEs: Record<keyof typeof documentsEn, string> = {
  ...documentsEn,
};

/** English placeholders until the Japanese translation lands. */
export const documentsJa: Record<keyof typeof documentsEn, string> = {
  ...documentsEn,
};
