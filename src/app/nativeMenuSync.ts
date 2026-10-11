import { translate, type MessageKey, type ResolvedLanguage } from "../i18n";
import type { CommandInvoker } from "../ipc/client";
import type {
  NativeMenuLabelId,
  NativeMenuSyncRequest,
  NativeMenuSyncState,
} from "../ipc/contracts";

export type { NativeMenuSyncState } from "../ipc/contracts";

const APP_NAME = "Excalidraw";

const LABEL_KEYS: Readonly<Record<NativeMenuLabelId, MessageKey>> = {
  "app.about": "menu.native.app.about",
  "app.language": "menu.native.app.language",
  "app.languageSystem": "menu.native.app.languageSystem",
  "app.languageEn": "language.autonym.en",
  "app.languageZhCn": "language.autonym.zhCN",
  "app.services": "menu.native.app.services",
  "app.hide": "menu.native.app.hide",
  "app.hideOthers": "menu.native.app.hideOthers",
  "app.quit": "menu.native.app.quit",
  file: "menu.native.file",
  "file.save": "menu.native.file.save",
  "file.exportImage": "menu.native.file.exportImage",
  "file.versionHistory": "menu.native.file.versionHistory",
  "file.closeWindow": "menu.native.file.closeWindow",
  edit: "menu.native.edit",
  "edit.undo": "menu.native.edit.undo",
  "edit.redo": "menu.native.edit.redo",
  "edit.cut": "menu.native.edit.cut",
  "edit.copy": "menu.native.edit.copy",
  "edit.paste": "menu.native.edit.paste",
  "edit.selectAll": "menu.native.edit.selectAll",
  view: "menu.native.view",
  "view.appearance": "menu.native.view.appearance",
  "view.appearanceSystem": "menu.native.view.appearanceSystem",
  "view.appearanceLight": "menu.native.view.appearanceLight",
  "view.appearanceDark": "menu.native.view.appearanceDark",
  "view.toolLock": "menu.native.view.toolLock",
  "view.grid": "menu.native.view.grid",
  "view.snap": "menu.native.view.snap",
  "view.zen": "menu.native.view.zen",
  "view.viewMode": "menu.native.view.viewMode",
  "view.fullscreen": "menu.native.view.fullscreen",
  window: "menu.native.window",
  "window.minimize": "menu.native.window.minimize",
  "window.zoom": "menu.native.window.zoom",
  help: "menu.native.help",
  "help.excalidrawHelp": "menu.native.help.excalidrawHelp",
};

/** The complete localized label set the Rust menu requires. */
export function nativeMenuLabels(
  language: ResolvedLanguage,
): Record<NativeMenuLabelId, string> {
  const labels = {} as Record<NativeMenuLabelId, string>;
  for (const [id, key] of Object.entries(LABEL_KEYS) as [
    NativeMenuLabelId,
    MessageKey,
  ][]) {
    labels[id] = translate(language, key, { name: APP_NAME });
  }
  return labels;
}

/**
 * Send the native menu snapshot, skipping requests identical to the last one
 * that succeeded so ordinary canvas edits never reach the menu.
 */
export function createNativeMenuSync(invoker: CommandInvoker) {
  let lastSent: string | undefined;
  return async (
    language: ResolvedLanguage,
    state: NativeMenuSyncState,
  ): Promise<boolean> => {
    const request: NativeMenuSyncRequest = {
      labels: nativeMenuLabels(language),
      state,
    };
    const serialized = JSON.stringify(request);
    if (serialized === lastSent) return false;
    lastSent = serialized;
    try {
      await invoker.invoke("native_menu_sync", request);
      return true;
    } catch (error) {
      lastSent = undefined;
      throw error;
    }
  };
}
