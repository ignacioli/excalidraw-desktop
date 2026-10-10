// English is the source of every message key. Keep this file to TypeScript
// syntax that Node can strip directly: scripts/native-menu-check.mjs imports it.
export const en = {
  "language.autonym.en": "English",
  "language.autonym.zhCN": "简体中文",

  "menu.canvas.preferences": "Preferences",
  "menu.canvas.toolLock": "Tool lock",
  "menu.canvas.toggleGrid": "Toggle grid",
  "menu.canvas.snapToObjects": "Snap to objects",
  "menu.canvas.zenMode": "Zen mode",
  "menu.canvas.viewMode": "View mode",
  "menu.canvas.language": "Language",
  "menu.canvas.languageSystem": "Follow system",

  "menu.native.app.about": "About {name}",
  "menu.native.app.language": "Language",
  "menu.native.app.languageSystem": "Follow System",
  "menu.native.app.services": "Services",
  "menu.native.app.hide": "Hide {name}",
  "menu.native.app.hideOthers": "Hide Others",
  "menu.native.app.quit": "Quit {name}",
  "menu.native.file": "File",
  "menu.native.file.save": "Save",
  "menu.native.file.exportImage": "Export Image",
  "menu.native.file.versionHistory": "Version History…",
  "menu.native.file.closeWindow": "Close Window",
  "menu.native.edit": "Edit",
  "menu.native.edit.undo": "Undo",
  "menu.native.edit.redo": "Redo",
  "menu.native.edit.cut": "Cut",
  "menu.native.edit.copy": "Copy",
  "menu.native.edit.paste": "Paste",
  "menu.native.edit.selectAll": "Select All",
  "menu.native.view": "View",
  "menu.native.view.appearance": "Appearance",
  "menu.native.view.appearanceSystem": "System",
  "menu.native.view.appearanceLight": "Light",
  "menu.native.view.appearanceDark": "Dark",
  "menu.native.view.toolLock": "Tool Lock",
  "menu.native.view.grid": "Toggle Grid",
  "menu.native.view.snap": "Snap to Objects",
  "menu.native.view.zen": "Zen Mode",
  "menu.native.view.viewMode": "View Mode",
  "menu.native.view.fullscreen": "Enter Full Screen",
  "menu.native.window": "Window",
  "menu.native.window.minimize": "Minimize",
  "menu.native.window.zoom": "Zoom",
  "menu.native.help": "Help",
  "menu.native.help.excalidrawHelp": "Excalidraw Help",
  "error.PATH_ACCESS_DENIED":
    "Excalidraw doesn’t have permission to access this location.",
  "error.WORKSPACE_NOT_FOUND": "This workspace could not be found.",
  "error.WORKSPACE_MOUNTED": "This folder is already mounted as a workspace.",
  "error.WORKSPACE_OVERLAP":
    "This folder overlaps a workspace that is already mounted.",
  "error.INVALID_NAME": "This name isn’t valid.",
  "error.NAME_CONFLICT": "An item with this name already exists.",
  "error.ENTRY_PROTECTED": "This item is protected and can’t be changed.",
  "error.DIRECTORY_NOT_EMPTY": "The folder isn’t empty.",
  "error.ENTRY_CHANGED": "This item changed on disk. Refresh and try again.",
  "error.FILE_NOT_FOUND": "The file could not be found.",
  "error.FILE_CORRUPTED": "The file is damaged and could not be read.",
  "error.FILE_TOO_LARGE": "The file is too large to open.",
  "error.INVALID_SCENE": "The file doesn’t contain a valid Excalidraw drawing.",
  "error.CONFLICT_PENDING": "Resolve the file conflict first.",
  "error.DISK_FULL":
    "The disk is full. Your recovery draft is still available.",
  "error.IO_ERROR": "The file operation could not be completed.",
  "error.DB_ERROR": "Local app data could not be read or saved.",
  "error.HISTORY_UNAVAILABLE":
    "Version history isn’t available for this drawing.",
  "error.HISTORY_RESOURCE_MISSING": "This version’s data is missing.",
  "error.HISTORY_STALE_DOCUMENT":
    "The drawing changed. Reopen version history and try again.",
  "error.HISTORY_OPERATION_PENDING":
    "Another version history operation is still in progress.",
  "error.HISTORY_BUSY": "Version history is busy. Try again shortly.",
  "error.INTERNAL": "Something went wrong inside Excalidraw.",
  "error.unknown": "Something went wrong (error {code}).",
  "error.generic": "The requested operation could not be completed.",
  "error.fileOperationFailed":
    "The requested file operation could not be completed.",
  "error.saveFailed": "The drawing could not be saved.",
  "error.recoveryFailed": "The recovery action could not be completed.",
  "error.conflictFailed": "The conflict could not be resolved.",
  "error.importMultipleDrawings": "Only one drawing can be imported at a time.",

  "error.closeBeforeWorkspaceSwitch":
    "Close or save the open drawings before switching workspaces.",
  "history.error.notReady": "Version history isn’t ready yet.",
  "history.error.drawingClosed": "The drawing was closed.",
  "history.error.drawingNotReady": "The current drawing isn’t ready yet.",
  "history.error.replacementUnverified":
    "The replacement still needs to be confirmed. Editing is paused for this drawing.",
  "history.error.replacementStillUnverified":
    "The replacement still can’t be confirmed. Try again shortly.",
  "history.error.drawingSwitchedDuringImage":
    "The drawing changed before the image finished loading.",
  "history.error.imageHasNoDrawing":
    "This image doesn’t contain an Excalidraw drawing.",
  "recovery.error.snapshotUnavailable":
    "The selected recovery snapshot is no longer available.",
} as const;

export type MessageKey = keyof typeof en;
