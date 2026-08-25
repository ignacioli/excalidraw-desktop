export interface WheelIngestInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  tabCount: number;
  activeIndex: number;
}

const WHEEL_COOLDOWN_MS = 80;

export let inFlightTargetId: string | null = null;
export let pendingLatestId: string | null = null;

let lastWheelAt = Number.NEGATIVE_INFINITY;
let lastWheelDirection = 0;
let activateRunner: ((documentId: string) => Promise<void>) | null = null;
let drain: Promise<void> | null = null;

export function bindActivateRunner(
  runner: ((documentId: string) => Promise<void>) | null,
): void {
  activateRunner = runner;
}

export function resetTabActivationQueue(): void {
  inFlightTargetId = null;
  pendingLatestId = null;
  lastWheelAt = Number.NEGATIVE_INFINITY;
  lastWheelDirection = 0;
  drain = null;
}

export function ingestWheel(input: WheelIngestInput): number | null {
  if (input.tabCount < 2 || input.activeIndex < 0) {
    return null;
  }
  if (input.shiftKey || input.altKey || input.ctrlKey || input.metaKey) {
    return null;
  }
  if (Math.abs(input.deltaX) > Math.abs(input.deltaY)) {
    return null;
  }
  if (input.deltaY === 0) {
    return null;
  }

  const now = Date.now();
  if (now < lastWheelAt) {
    lastWheelAt = Number.NEGATIVE_INFINITY;
  }
  const direction = input.deltaY > 0 ? 1 : -1;
  const previousDirection = lastWheelDirection;
  if (previousDirection !== 0 && previousDirection !== direction) {
    lastWheelAt = Number.NEGATIVE_INFINITY;
  }
  if (now - lastWheelAt < WHEEL_COOLDOWN_MS) {
    return null;
  }
  lastWheelAt = now;
  lastWheelDirection = direction;
  const next =
    (input.activeIndex + direction + input.tabCount) % input.tabCount;
  return next;
}

export async function requestActivate(documentId: string): Promise<void> {
  if (inFlightTargetId !== null) {
    pendingLatestId = documentId;
    await (drain ?? Promise.resolve());
    return;
  }

  inFlightTargetId = documentId;
  pendingLatestId = null;
  drain = runActivation(documentId).finally(() => {
    drain = null;
  });
  await drain;
}

async function runActivation(documentId: string): Promise<void> {
  const runner = activateRunner;
  if (runner === null) {
    // Queue unit tests assert in-flight state without binding a runner.
    await new Promise<void>(() => {
      /* remain in-flight */
    });
    return;
  }
  try {
    await runner(documentId);
  } finally {
    const nextId = pendingLatestId;
    inFlightTargetId = null;
    pendingLatestId = null;
    if (nextId !== null && nextId !== documentId) {
      await requestActivate(nextId);
    }
  }
}
