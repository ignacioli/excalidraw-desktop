// Japanese catalog. Keep this file to TypeScript
// syntax that Node can strip directly: scripts/native-menu-check.mjs imports it.
import { documentsJa } from "./documents.ts";
import type { MessageKey } from "./en.ts";
import { historyJa } from "./history.ts";
import { shellJa } from "./shell.ts";

export const ja: Record<MessageKey, string> = {
  ...shellJa,
  ...documentsJa,
  ...historyJa,

  "language.autonym.en": "English",
  "language.autonym.zhCN": "简体中文",
  "language.autonym.es": "Español",
  "language.autonym.ja": "日本語",
  "menu.canvas.preferences": "設定",
  "menu.canvas.toolLock": "ツールをロック",
  "menu.canvas.toggleGrid": "グリッドの表示切替",
  "menu.canvas.snapToObjects": "オブジェクトにスナップ",
  "menu.canvas.zenMode": "Zen モード",
  "menu.canvas.viewMode": "閲覧モード",
  "menu.canvas.language": "言語",
  "menu.canvas.languageSystem": "システムに合わせる",
  "menu.native.app.about": "{name} について",
  "menu.native.app.language": "言語",
  "menu.native.app.languageSystem": "システムに合わせる",
  "menu.native.app.services": "サービス",
  "menu.native.app.hide": "{name} を非表示",
  "menu.native.app.hideOthers": "ほかを非表示",
  "menu.native.app.quit": "{name} を終了",
  "menu.native.file": "ファイル",
  "menu.native.file.newWindow": "新規ウインドウ",
  "menu.native.file.openWorkspace": "ワークスペースを開く…",
  "menu.native.file.save": "保存",
  "menu.native.file.exportImage": "画像をエクスポート",
  "menu.native.file.versionHistory": "バージョン履歴…",
  "menu.native.file.closeWindow": "ウインドウを閉じる",
  "menu.native.edit": "編集",
  "menu.native.edit.undo": "取り消す",
  "menu.native.edit.redo": "やり直す",
  "menu.native.edit.cut": "カット",
  "menu.native.edit.copy": "コピー",
  "menu.native.edit.paste": "ペースト",
  "menu.native.edit.selectAll": "すべてを選択",
  "menu.native.view": "表示",
  "menu.native.view.appearance": "外観",
  "menu.native.view.appearanceSystem": "システム",
  "menu.native.view.appearanceLight": "ライト",
  "menu.native.view.appearanceDark": "ダーク",
  "menu.native.view.toolLock": "ツールをロック",
  "menu.native.view.grid": "グリッドの表示切替",
  "menu.native.view.snap": "オブジェクトにスナップ",
  "menu.native.view.zen": "Zen モード",
  "menu.native.view.viewMode": "閲覧モード",
  "menu.native.view.fullscreen": "フルスクリーンにする",
  "menu.native.window": "ウインドウ",
  "menu.native.window.minimize": "しまう",
  "menu.native.window.zoom": "拡大/縮小",
  "menu.native.help": "ヘルプ",
  "menu.native.help.excalidrawHelp": "Excalidraw ヘルプ",
  "error.PATH_ACCESS_DENIED":
    "Excalidraw には、この場所へアクセスする権限がありません。",
  "error.WORKSPACE_NOT_FOUND": "このワークスペースは見つかりませんでした。",
  "error.WORKSPACE_MOUNTED":
    "このフォルダは、既にワークスペースとして開いています。",
  "error.WORKSPACE_OVERLAP":
    "このフォルダは、既に開いているワークスペースと重なっています。",
  "error.WORKSPACE_NOT_OWNED":
    "このウインドウには、開いているワークスペースがありません。",
  "error.DOCUMENT_NOT_OWNED": "この図は別のウインドウで開いています。",
  "error.WINDOW_OWNERSHIP_CHANGED":
    "ワークスペースが別のウインドウで開かれるか閉じられました。もう一度お試しください。",
  "error.QUIT_CHECKPOINT_FAILED":
    "このウインドウの図を保存できなかったため、Excalidraw は終了しませんでした。",
  "error.INVALID_NAME": "この名前は無効です。",
  "error.NAME_CONFLICT": "この名前の項目は既にあります。",
  "error.ENTRY_PROTECTED": "この項目は保護されているため、変更できません。",
  "error.DIRECTORY_NOT_EMPTY": "フォルダは空ではありません。",
  "error.ENTRY_CHANGED":
    "この項目はディスク上で変更されました。更新して、もう一度お試しください。",
  "error.FILE_NOT_FOUND": "ファイルが見つかりませんでした。",
  "error.FILE_CORRUPTED": "ファイルが破損しているため、読み取れませんでした。",
  "error.FILE_TOO_LARGE": "ファイルが大きすぎて開けません。",
  "error.INVALID_SCENE":
    "このファイルには、有効な Excalidraw の図がありません。",
  "error.CONFLICT_PENDING": "先にファイルの競合を解決してください。",
  "error.DISK_FULL":
    "ディスクがいっぱいです。リカバリの下書きはまだ利用できます。",
  "error.IO_ERROR": "ファイル操作を完了できませんでした。",
  "error.DB_ERROR": "ローカルのアプリデータを読み取るか保存できませんでした。",
  "error.HISTORY_UNAVAILABLE": "この図ではバージョン履歴を利用できません。",
  "error.HISTORY_RESOURCE_MISSING": "このバージョンのデータがありません。",
  "error.HISTORY_STALE_DOCUMENT":
    "図が変更されました。バージョン履歴を開き直して、もう一度お試しください。",
  "error.HISTORY_OPERATION_PENDING":
    "別のバージョン履歴の操作がまだ進行中です。",
  "error.HISTORY_BUSY":
    "バージョン履歴が使用中です。しばらくしてから、もう一度お試しください。",
  "error.INTERNAL": "Excalidraw の内部で問題が発生しました。",
  "error.unknown": "問題が発生しました（エラー {code}）。",
  "error.saveLocationRequired": "図の保存先を選んでください。",
  "error.generic": "要求された操作を完了できませんでした。",
  "error.fileOperationFailed": "要求されたファイル操作を完了できませんでした。",
  "error.saveFailed": "図を保存できませんでした。",
  "error.recoveryFailed": "リカバリの操作を完了できませんでした。",
  "error.conflictFailed": "競合を解決できませんでした。",
  "error.importMultipleDrawings": "一度に読み込める図は 1 個だけです。",
  "error.closeBeforeWorkspaceSwitch":
    "ワークスペースを切り替える前に、開いている図を閉じるか保存してください。",
  "history.error.notReady": "バージョン履歴はまだ準備できていません。",
  "history.error.drawingClosed": "図は閉じられました。",
  "history.error.drawingNotReady": "現在の図はまだ準備できていません。",
  "history.error.replacementUnverified":
    "置き換えはまだ確認が必要です。この図の編集は一時停止しています。",
  "history.error.replacementStillUnverified":
    "置き換えをまだ確認できません。しばらくしてから、もう一度お試しください。",
  "history.error.drawingSwitchedDuringImage":
    "画像の読み込みが終わる前に、図が切り替わりました。",
  "history.error.imageHasNoDrawing":
    "この画像には Excalidraw の図が含まれていません。",
  "recovery.error.snapshotUnavailable":
    "選択したリカバリスナップショットは、もう利用できません。",
};
