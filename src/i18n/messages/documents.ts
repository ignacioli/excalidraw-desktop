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

export const documentsEs: Record<keyof typeof documentsEn, string> = {
  "conflict.title": "El archivo cambió en el disco",
  "conflict.description":
    "El archivo se modificó fuera de esta aplicación mientras tenía cambios sin guardar. No se escribe nada en el archivo hasta que usted elija qué hacer.",
  "conflict.externalChanged": "La versión externa cambió",
  "conflict.localSaved": "Último guardado del borrador local",
  "conflict.unknownTime": "en un momento desconocido",
  "conflict.useExternal": "Usar la versión externa",
  "conflict.keepLocal": "Conservar cambios locales",
  "conflict.saveAsNew": "Guardar los cambios locales como nuevo…",
  "conflict.saveDialog.filterName": "Dibujo de Excalidraw",
  "conflict.saveDialog.title":
    "Guardar los cambios locales como un dibujo nuevo",
  "recovery.title": "Recuperar dibujos sin guardar",
  "recovery.description":
    "Excalidraw Desktop encontró instantáneas de recuperación de una sesión interrumpida. Elija qué hacer con cada dibujo.",
  "recovery.candidatesLabel": "Candidatos de recuperación",
  "recovery.snapshotSaved": "Instantánea guardada {time}",
  "recovery.unknownTime": "en un momento desconocido",
  "recovery.untitled": "Dibujo sin título",
  "recovery.actionsFor": "Acciones para {name}",
  "recovery.restore": "Restaurar {name}",
  "recovery.keepDisk": "Conservar la versión del disco de {name}",
  "recovery.saveAsNew": "Guardar {name} como nuevo",
  "recovery.discard": "Descartar la recuperación de {name}",
  "recovery.error.chooseDestination":
    "Elija un destino antes de guardar la recuperación como un dibujo nuevo.",
  "recovery.error.resolveFirst":
    "Resuelva los candidatos de recuperación antes de continuar.",
  "recovery.error.startupCheck":
    "No se pudieron comprobar las instantáneas de recuperación: {reason}",
  "recovery.notice.one": "Recuperado · {count} dibujo restaurado",
  "recovery.notice.other": "Recuperado · {count} dibujos restaurados",
  "recovery.saveDialog.filterName": "Dibujo de Excalidraw",
  "recovery.saveDialog.title": "Guardar el dibujo recuperado",
  "workspace.panelLabel": "Espacios de trabajo",
  "workspace.eyebrow": "Espacio de trabajo",
  "workspace.defaultTitle": "Espacio de trabajo",
  "workspace.actionsLabel": "Acciones del espacio de trabajo",
  "workspace.newDrawing": "Nuevo dibujo",
  "workspace.newFolder": "Nueva carpeta",
  "workspace.collapseAll": "Contraer todo",
  "workspace.expandAll": "Expandir todo",
  "workspace.refresh": "Actualizar",
  "workspace.loadingFolder": "Cargando la carpeta…",
  "workspace.empty": "No hay ningún espacio de trabajo abierto.",
  "workspace.mountFolder": "Abrir carpeta…",
  "workspace.mountDialogTitle": "Abrir carpeta del espacio de trabajo",
  "workspace.menu.actionsFor": "Acciones para {name}",
  "workspace.menu.filesNotDeleted": "Los archivos del disco no se eliminarán",
  "workspace.menu.rename": "Cambiar nombre",
  "workspace.menu.delete": "Eliminar",
  "workspace.menu.copyPath": "Copiar ruta",
  "workspace.menu.copyRelativePath": "Copiar ruta relativa",
  "workspace.menu.removeWorkspace": "Quitar espacio de trabajo",
  "workspace.remove.title": "¿Quitar {name}?",
  "workspace.remove.description":
    "Los dibujos abiertos de este espacio de trabajo se guardarán y se cerrarán. Los archivos del disco no se eliminarán.",
  "workspace.remove.cancel": "Cancelar",
  "workspace.remove.confirm": "Quitar espacio de trabajo",
  "workspace.nested.title": "“{target}” contiene un espacio de trabajo abierto",
  "workspace.nested.description":
    "“{workspace}” ya está abierto en otra ventana. Un espacio de trabajo no se puede abrir dentro de otro.",
  "workspace.nested.switch": "Cambiar a esa ventana",
  "workspace.nested.closeAndOpen": "Cerrarla y abrir aquí",
  "workspace.nested.closing": "Cerrando esa ventana…",
  "workspace.nested.cancel": "Cancelar",
  "workspace.nested.notClosed":
    "“{workspace}” no se cerró, así que “{target}” no se abrió.",
  "workspace.tree.label": "Archivos del espacio de trabajo",
  "workspace.tree.activeDrawing": "Dibujo activo",
  "workspace.error.loadFolder": "No se puede cargar esta carpeta.",
  "workspace.error.loadWorkspaces":
    "No se pueden cargar los espacios de trabajo.",
  "workspace.error.mount": "No se puede abrir este espacio de trabajo.",
  "workspace.error.mountNoDialog":
    "Elija un directorio en el diálogo de archivos del sistema para abrir un espacio de trabajo.",
  "workspace.error.remove": "No se puede quitar este espacio de trabajo.",
  "workspace.error.removeOrphaned":
    "Resuelva el dibujo abierto que no está disponible antes de quitar este espacio de trabajo.",
  "workspace.error.removeStillClosing":
    "Los dibujos abiertos aún se están cerrando. Intente quitar el espacio de trabajo de nuevo.",
  "workspace.error.saveBeforeDelete":
    "Guarde el dibujo abierto antes de eliminarlo.",
  "workspace.error.fileOperation": "La operación de archivo falló.",
  "workspace.error.deleteEntry": "No se pudo eliminar el elemento.",
  "workspace.error.revealFolder": "El Finder no pudo abrir esta carpeta.",
  "workspace.error.outsideWorkspace":
    "Esta ubicación está fuera del espacio de trabajo.",
  "workspace.notice.historyCleanupPending":
    "El dibujo se eliminó. La limpieza del historial de versiones sigue pendiente y se reintentará más tarde.",
  "workspace.notice.historyResourcesPending":
    "El dibujo se eliminó. Algunos datos del historial de versiones aún no se han limpiado.",
};

export const documentsJa: Record<keyof typeof documentsEn, string> = {
  "conflict.title": "ファイルがディスク上で変更されました",
  "conflict.description":
    "未保存の変更があるあいだに、このアプリの外でファイルが変更されました。どうするかを選ぶまで、ファイルには何も書き込まれません。",
  "conflict.externalChanged": "外部のバージョンが変更されました",
  "conflict.localSaved": "ローカルの下書きの最終保存",
  "conflict.unknownTime": "時刻は不明です",
  "conflict.useExternal": "外部のバージョンを使う",
  "conflict.keepLocal": "ローカルの変更を保持",
  "conflict.saveAsNew": "ローカルの変更を新規として保存…",
  "conflict.saveDialog.filterName": "Excalidraw の図",
  "conflict.saveDialog.title": "ローカルの変更を新しい図として保存",
  "recovery.title": "未保存の図を復旧",
  "recovery.description":
    "Excalidraw Desktop は、中断したセッションのリカバリスナップショットを見つけました。図ごとに行う操作を選んでください。",
  "recovery.candidatesLabel": "リカバリの候補",
  "recovery.snapshotSaved": "スナップショットの保存時刻 {time}",
  "recovery.unknownTime": "時刻は不明です",
  "recovery.untitled": "無題の図",
  "recovery.actionsFor": "{name} の操作",
  "recovery.restore": "{name} を復元",
  "recovery.keepDisk": "{name} はディスク上のバージョンを保持",
  "recovery.saveAsNew": "{name} を新規として保存",
  "recovery.discard": "{name} のリカバリを破棄",
  "recovery.error.chooseDestination":
    "リカバリを新しい図として保存する前に、保存先を選んでください。",
  "recovery.error.resolveFirst":
    "続ける前に、リカバリの候補を解決してください。",
  "recovery.error.startupCheck":
    "リカバリスナップショットを確認できませんでした： {reason}",
  "recovery.notice.one": "復旧しました · 図 {count} 個を復元しました",
  "recovery.notice.other": "復旧しました · 図 {count} 個を復元しました",
  "recovery.saveDialog.filterName": "Excalidraw の図",
  "recovery.saveDialog.title": "復旧した図を保存",
  "workspace.panelLabel": "ワークスペース",
  "workspace.eyebrow": "ワークスペース",
  "workspace.defaultTitle": "ワークスペース",
  "workspace.actionsLabel": "ワークスペースの操作",
  "workspace.newDrawing": "新規の図",
  "workspace.newFolder": "新規フォルダ",
  "workspace.collapseAll": "すべて折りたたむ",
  "workspace.expandAll": "すべて展開",
  "workspace.refresh": "更新",
  "workspace.loadingFolder": "フォルダを読み込んでいます…",
  "workspace.empty": "開いているワークスペースはありません。",
  "workspace.mountFolder": "フォルダを開く…",
  "workspace.mountDialogTitle": "ワークスペースのフォルダを開く",
  "workspace.menu.actionsFor": "{name} の操作",
  "workspace.menu.filesNotDeleted": "ディスク上のファイルは削除されません",
  "workspace.menu.rename": "名前を変更",
  "workspace.menu.delete": "削除",
  "workspace.menu.copyPath": "パスをコピー",
  "workspace.menu.copyRelativePath": "相対パスをコピー",
  "workspace.menu.removeWorkspace": "ワークスペースを取り除く",
  "workspace.remove.title": "{name} を取り除きますか？",
  "workspace.remove.description":
    "このワークスペースで開いている図は保存して閉じます。ディスク上のファイルは削除されません。",
  "workspace.remove.cancel": "キャンセル",
  "workspace.remove.confirm": "ワークスペースを取り除く",
  "workspace.nested.title":
    "「{target}」には、開いているワークスペースが含まれています",
  "workspace.nested.description":
    "「{workspace}」は別のウインドウで既に開いています。ワークスペースを別のワークスペースの中で開くことはできません。",
  "workspace.nested.switch": "そのウインドウに切り替える",
  "workspace.nested.closeAndOpen": "閉じてここで開く",
  "workspace.nested.closing": "そのウインドウを閉じています…",
  "workspace.nested.cancel": "キャンセル",
  "workspace.nested.notClosed":
    "「{workspace}」は閉じられなかったため、「{target}」は開きませんでした。",
  "workspace.tree.label": "ワークスペースのファイル",
  "workspace.tree.activeDrawing": "作業中の図",
  "workspace.error.loadFolder": "このフォルダを読み込めません。",
  "workspace.error.loadWorkspaces": "ワークスペースを読み込めません。",
  "workspace.error.mount": "このワークスペースを開けません。",
  "workspace.error.mountNoDialog":
    "ワークスペースを開くには、システムのファイルダイアログでディレクトリを選んでください。",
  "workspace.error.remove": "このワークスペースを取り除けません。",
  "workspace.error.removeOrphaned":
    "このワークスペースを取り除く前に、利用できない開いている図を解決してください。",
  "workspace.error.removeStillClosing":
    "開いている図をまだ閉じています。もう一度、ワークスペースを取り除いてください。",
  "workspace.error.saveBeforeDelete":
    "削除する前に、開いている図を保存してください。",
  "workspace.error.fileOperation": "ファイル操作に失敗しました。",
  "workspace.error.deleteEntry": "項目を削除できませんでした。",
  "workspace.error.revealFolder": "Finder でこのフォルダを開けませんでした。",
  "workspace.error.outsideWorkspace": "この場所はワークスペースの外です。",
  "workspace.notice.historyCleanupPending":
    "図を削除しました。バージョン履歴のクリーンアップはまだ保留で、後で再試行します。",
  "workspace.notice.historyResourcesPending":
    "図を削除しました。バージョン履歴のデータの一部は、まだクリーンアップされていません。",
};
