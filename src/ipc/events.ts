import type { EventName, EventPayload } from "./contracts";

export interface TauriEventPayload<Name extends EventName> {
  payload: EventPayload<Name>;
}

export type EventListener<Name extends EventName> = (
  eventName: Name,
  handler: (event: TauriEventPayload<Name>) => void,
) => Promise<() => void>;

export async function defaultEventListener<Name extends EventName>(
  eventName: Name,
  handler: (event: TauriEventPayload<Name>) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<EventPayload<Name>>(eventName, handler);
}
