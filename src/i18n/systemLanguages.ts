import { hasNativeWindowRuntime } from "../app/exitCheckpoint";
import { createTauriCommandInvoker, type CommandInvoker } from "../ipc/client";

const MAX_PREFERRED_LANGUAGES = 16;

/**
 * Read the system language list once, before the first render. Outside the
 * desktop shell, or if the handshake fails, the list is empty and the UI
 * falls back to English.
 */
export async function readSystemLanguages(
  invoker?: CommandInvoker,
): Promise<string[]> {
  if (invoker === undefined && !hasNativeWindowRuntime()) return [];
  try {
    const response = await (invoker ?? createTauriCommandInvoker()).invoke(
      "app_handshake",
      {},
    );
    const languages: unknown = response.preferredLanguages;
    if (!Array.isArray(languages)) return [];
    return languages
      .filter((tag): tag is string => typeof tag === "string")
      .slice(0, MAX_PREFERRED_LANGUAGES);
  } catch (error) {
    console.warn("System languages could not be read.", error);
    return [];
  }
}
