import type { EventName, EventPayload } from "./contracts";

export const HISTORY_CHANGED_EVENT = "history-changed" as const;
export const HISTORY_ISSUE_EVENT = "history-issue" as const;

export interface TauriEventPayload<Name extends EventName> {
  payload: EventPayload<Name>;
}

export type EventListener<Name extends EventName> = (
  eventName: Name,
  handler: (event: TauriEventPayload<Name>) => void,
) => Promise<() => void>;

/**
 * The target that limits a listener to events for this window. An event the
 * backend sends to one window still reaches every untargeted listener, so a
 * listener without this target would also hear other windows' events.
 * Events the backend broadcasts reach targeted listeners too. Without a
 * Tauri window (browser harnesses) there is one window and no target.
 */
async function currentWindowTarget(): Promise<
  { kind: "WebviewWindow"; label: string } | undefined
> {
  try {
    const { getCurrentWebviewWindow } =
      await import("@tauri-apps/api/webviewWindow");
    return { kind: "WebviewWindow", label: getCurrentWebviewWindow().label };
  } catch {
    return undefined;
  }
}

/** Listen for an event sent to this window or to every window. */
export async function defaultEventListener<Name extends EventName>(
  eventName: Name,
  handler: (event: TauriEventPayload<Name>) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  const target = await currentWindowTarget();
  return listen<EventPayload<Name>>(
    eventName,
    handler,
    target === undefined ? undefined : { target },
  );
}
