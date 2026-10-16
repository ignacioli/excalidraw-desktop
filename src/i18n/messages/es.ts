// Spanish catalog. Keep this file to TypeScript
// syntax that Node can strip directly: scripts/native-menu-check.mjs imports it.
import { documentsEs } from "./documents.ts";
import type { MessageKey } from "./en.ts";
import { historyEs } from "./history.ts";
import { shellEs } from "./shell.ts";

export const es: Record<MessageKey, string> = {
  ...shellEs,
  ...documentsEs,
  ...historyEs,

  "language.autonym.en": "English",
  "language.autonym.zhCN": "简体中文",
  "language.autonym.es": "Español",
  "language.autonym.ja": "日本語",
  "menu.canvas.preferences": "Preferencias",
  "menu.canvas.toolLock": "Bloquear herramienta",
  "menu.canvas.toggleGrid": "Mostrar u ocultar cuadrícula",
  "menu.canvas.snapToObjects": "Ajustar a los objetos",
  "menu.canvas.zenMode": "Modo Zen",
  "menu.canvas.viewMode": "Modo presentación",
  "menu.canvas.language": "Idioma",
  "menu.canvas.languageSystem": "Según el sistema",
  "menu.native.app.about": "Acerca de {name}",
  "menu.native.app.language": "Idioma",
  "menu.native.app.languageSystem": "Según el sistema",
  "menu.native.app.services": "Servicios",
  "menu.native.app.hide": "Ocultar {name}",
  "menu.native.app.hideOthers": "Ocultar otros",
  "menu.native.app.quit": "Salir de {name}",
  "menu.native.file": "Archivo",
  "menu.native.file.newWindow": "Nueva ventana",
  "menu.native.file.openWorkspace": "Abrir espacio de trabajo…",
  "menu.native.file.save": "Guardar",
  "menu.native.file.exportImage": "Exportar imagen",
  "menu.native.file.versionHistory": "Historial de versiones…",
  "menu.native.file.closeWindow": "Cerrar ventana",
  "menu.native.edit": "Edición",
  "menu.native.edit.undo": "Deshacer",
  "menu.native.edit.redo": "Rehacer",
  "menu.native.edit.cut": "Cortar",
  "menu.native.edit.copy": "Copiar",
  "menu.native.edit.paste": "Pegar",
  "menu.native.edit.selectAll": "Seleccionar todo",
  "menu.native.view": "Visualización",
  "menu.native.view.appearance": "Apariencia",
  "menu.native.view.appearanceSystem": "Sistema",
  "menu.native.view.appearanceLight": "Claro",
  "menu.native.view.appearanceDark": "Oscuro",
  "menu.native.view.toolLock": "Bloquear herramienta",
  "menu.native.view.grid": "Mostrar u ocultar cuadrícula",
  "menu.native.view.snap": "Ajustar a los objetos",
  "menu.native.view.zen": "Modo Zen",
  "menu.native.view.viewMode": "Modo presentación",
  "menu.native.view.fullscreen": "Entrar en pantalla completa",
  "menu.native.window": "Ventana",
  "menu.native.window.minimize": "Minimizar",
  "menu.native.window.zoom": "Zoom",
  "menu.native.help": "Ayuda",
  "menu.native.help.excalidrawHelp": "Ayuda de Excalidraw",
  "error.PATH_ACCESS_DENIED":
    "Excalidraw no tiene permiso para acceder a esta ubicación.",
  "error.WORKSPACE_NOT_FOUND": "No se encontró este espacio de trabajo.",
  "error.WORKSPACE_MOUNTED":
    "Esta carpeta ya está abierta como espacio de trabajo.",
  "error.WORKSPACE_OVERLAP":
    "Esta carpeta se superpone con un espacio de trabajo que ya está abierto.",
  "error.WORKSPACE_NOT_OWNED":
    "Esta ventana no tiene ningún espacio de trabajo abierto.",
  "error.DOCUMENT_NOT_OWNED": "Este dibujo está abierto en otra ventana.",
  "error.WINDOW_OWNERSHIP_CHANGED":
    "El espacio de trabajo se abrió o se cerró en otra ventana. Inténtelo de nuevo.",
  "error.QUIT_CHECKPOINT_FAILED":
    "No se pudo guardar un dibujo de esta ventana, así que Excalidraw no salió.",
  "error.INVALID_NAME": "Este nombre no es válido.",
  "error.NAME_CONFLICT": "Ya existe un elemento con este nombre.",
  "error.ENTRY_PROTECTED":
    "Este elemento está protegido y no se puede cambiar.",
  "error.DIRECTORY_NOT_EMPTY": "La carpeta no está vacía.",
  "error.ENTRY_CHANGED":
    "Este elemento cambió en el disco. Actualice e inténtelo de nuevo.",
  "error.FILE_NOT_FOUND": "No se encontró el archivo.",
  "error.FILE_CORRUPTED": "El archivo está dañado y no se pudo leer.",
  "error.FILE_TOO_LARGE": "El archivo es demasiado grande para abrirlo.",
  "error.INVALID_SCENE":
    "El archivo no contiene un dibujo válido de Excalidraw.",
  "error.CONFLICT_PENDING": "Resuelva primero el conflicto del archivo.",
  "error.DISK_FULL":
    "El disco está lleno. El borrador de recuperación sigue disponible.",
  "error.IO_ERROR": "No se pudo completar la operación de archivo.",
  "error.DB_ERROR":
    "No se pudieron leer o guardar los datos locales de la aplicación.",
  "error.HISTORY_UNAVAILABLE":
    "El historial de versiones no está disponible para este dibujo.",
  "error.HISTORY_RESOURCE_MISSING": "Faltan los datos de esta versión.",
  "error.HISTORY_STALE_DOCUMENT":
    "El dibujo cambió. Vuelva a abrir el historial de versiones e inténtelo de nuevo.",
  "error.HISTORY_OPERATION_PENDING":
    "Otra operación del historial de versiones sigue en curso.",
  "error.HISTORY_BUSY":
    "El historial de versiones está ocupado. Inténtelo de nuevo en un momento.",
  "error.INTERNAL": "Se produjo un error dentro de Excalidraw.",
  "error.unknown": "Se produjo un error (error {code}).",
  "error.saveLocationRequired": "Elija dónde guardar el dibujo.",
  "error.generic": "No se pudo completar la operación solicitada.",
  "error.fileOperationFailed":
    "No se pudo completar la operación de archivo solicitada.",
  "error.saveFailed": "No se pudo guardar el dibujo.",
  "error.recoveryFailed": "No se pudo completar la acción de recuperación.",
  "error.conflictFailed": "No se pudo resolver el conflicto.",
  "error.importMultipleDrawings": "Solo se puede importar un dibujo a la vez.",
  "error.closeBeforeWorkspaceSwitch":
    "Cierre o guarde los dibujos abiertos antes de cambiar de espacio de trabajo.",
  "history.error.notReady": "El historial de versiones aún no está listo.",
  "history.error.drawingClosed": "El dibujo se cerró.",
  "history.error.drawingNotReady": "El dibujo actual aún no está listo.",
  "history.error.replacementUnverified":
    "El reemplazo todavía debe confirmarse. La edición de este dibujo está en pausa.",
  "history.error.replacementStillUnverified":
    "El reemplazo todavía no se puede confirmar. Inténtelo de nuevo en un momento.",
  "history.error.drawingSwitchedDuringImage":
    "El dibujo cambió antes de que la imagen terminara de cargarse.",
  "history.error.imageHasNoDrawing":
    "Esta imagen no contiene un dibujo de Excalidraw.",
  "recovery.error.snapshotUnavailable":
    "La instantánea de recuperación seleccionada ya no está disponible.",
};
