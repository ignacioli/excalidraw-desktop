import { create } from "zustand";

interface AppStoreState {
  hasMountedWorkspace: boolean;
  setHasMountedWorkspace: (hasMountedWorkspace: boolean) => void;
}

export const useAppStore = create<AppStoreState>((set) => ({
  hasMountedWorkspace: false,
  setHasMountedWorkspace: (hasMountedWorkspace) => {
    set({ hasMountedWorkspace });
  },
}));
