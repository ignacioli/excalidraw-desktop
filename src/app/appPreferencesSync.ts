import type { CommandInvoker } from "../ipc/client";
import type { AppPreferencesChangedEvent } from "../ipc/contracts";
import { defaultEventListener, type EventListener } from "../ipc/events";
import type { LocaleController } from "../i18n";
import type { ThemeController } from "./theme/themeController";

/**
 * Tell the other windows about a preference changed in this window. A
 * failure is logged: this window keeps the change, and other windows pick it
 * up from storage when they next start.
 */
export async function broadcastAppPreferences(
  invoker: Pick<CommandInvoker, "invoke">,
  change: AppPreferencesChangedEvent,
): Promise<void> {
  try {
    await invoker.invoke("app_preferences_broadcast", change);
  } catch (error) {
    console.error("Could not share the preference with other windows.", error);
  }
}

export interface FollowAppPreferencesOptions {
  themeController: Pick<ThemeController, "applyExternalModePreference">;
  localeController: Pick<LocaleController, "applyExternalPreference">;
  listen?: EventListener<"app-preferences-changed">;
}

/** Apply preferences changed in other windows. Returns the unlisten call. */
export function followAppPreferences({
  themeController,
  localeController,
  listen = defaultEventListener,
}: FollowAppPreferencesOptions): Promise<() => void> {
  return listen("app-preferences-changed", ({ payload }) => {
    if (payload.appearance !== undefined) {
      themeController.applyExternalModePreference(payload.appearance);
    }
    if (payload.language !== undefined) {
      localeController.applyExternalPreference(payload.language);
    }
  });
}
