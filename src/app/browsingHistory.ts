export interface BrowsingLocation {
  workspaceId: string;
  directoryRelativePath: string;
  drawingPath?: string;
}

export type BrowsingLocationValidator = (location: BrowsingLocation) => boolean;

export class BrowsingHistory {
  private stack: BrowsingLocation[];

  constructor(initial: readonly BrowsingLocation[] = []) {
    this.stack = [...initial];
  }

  getSnapshot(): BrowsingLocation[] {
    return this.stack.map((location) => ({ ...location }));
  }

  push(location: BrowsingLocation): void {
    this.stack.push({ ...location });
  }

  canGoBack(isValid: BrowsingLocationValidator = () => true): boolean {
    return this.stack.some(isValid);
  }

  pop(
    isValid: BrowsingLocationValidator = () => true,
  ): BrowsingLocation | null {
    while (this.stack.length > 0) {
      const location = this.stack.pop();
      if (location !== undefined && isValid(location)) {
        return { ...location };
      }
    }
    return null;
  }
}
