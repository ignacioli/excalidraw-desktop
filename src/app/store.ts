import { create } from "zustand";

export interface DocumentTab {
  id: string;
  title: string;
  path: string | null;
  isDirty: boolean;
}

interface AppStoreState {
  tabsById: Record<string, DocumentTab>;
  tabOrder: string[];
  activeTabId: string | null;
  hasMountedWorkspace: boolean;
  registerTab: (
    tab: Omit<DocumentTab, "isDirty"> & { isDirty?: boolean },
  ) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  setDocumentDirty: (tabId: string, isDirty: boolean) => void;
  setHasMountedWorkspace: (hasMountedWorkspace: boolean) => void;
}

export const useAppStore = create<AppStoreState>((set) => ({
  tabsById: {},
  tabOrder: [],
  activeTabId: null,
  hasMountedWorkspace: false,

  registerTab: (tab) => {
    set((state) => {
      const exists = tab.id in state.tabsById;
      return {
        tabsById: {
          ...state.tabsById,
          [tab.id]: { ...tab, isDirty: tab.isDirty ?? false },
        },
        tabOrder: exists ? state.tabOrder : [...state.tabOrder, tab.id],
        activeTabId: tab.id,
      };
    });
  },

  closeTab: (tabId) => {
    set((state) => {
      if (!(tabId in state.tabsById)) {
        return state;
      }

      const closedIndex = state.tabOrder.indexOf(tabId);
      const tabOrder = state.tabOrder.filter((id) => id !== tabId);
      const tabsById = { ...state.tabsById };
      delete tabsById[tabId];
      const fallbackIndex = Math.min(closedIndex, tabOrder.length - 1);

      return {
        tabsById,
        tabOrder,
        activeTabId:
          state.activeTabId === tabId
            ? (tabOrder[fallbackIndex] ?? null)
            : state.activeTabId,
      };
    });
  },

  setActiveTab: (tabId) => {
    set((state) => (tabId in state.tabsById ? { activeTabId: tabId } : state));
  },

  setDocumentDirty: (tabId, isDirty) => {
    set((state) => {
      const tab = state.tabsById[tabId];
      if (tab === undefined || tab.isDirty === isDirty) {
        return state;
      }

      return {
        tabsById: {
          ...state.tabsById,
          [tabId]: { ...tab, isDirty },
        },
      };
    });
  },

  setHasMountedWorkspace: (hasMountedWorkspace) => {
    set({ hasMountedWorkspace });
  },
}));
