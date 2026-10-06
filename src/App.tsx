import { lazy, Suspense } from "react";
import { AppShell } from "./app/AppShell";
import "./App.css";

const HistoryPanelHarness =
  import.meta.env.DEV && import.meta.env.VITE_E2E_HARNESS === "1"
    ? lazy(async () => {
        const module = await import("./e2e/HistoryPanelHarness");
        return { default: module.HistoryPanelHarness };
      })
    : null;

function historyHarnessEnabled(): boolean {
  const testWindow = globalThis as typeof globalThis & {
    __EXCALIDRAW_HISTORY_E2E__?: boolean;
  };
  return (
    HistoryPanelHarness !== null &&
    import.meta.env.DEV &&
    import.meta.env.VITE_E2E_HARNESS === "1" &&
    testWindow.__EXCALIDRAW_HISTORY_E2E__ === true
  );
}

function App() {
  if (historyHarnessEnabled()) {
    const Harness = HistoryPanelHarness;
    if (Harness !== null) {
      return (
        <Suspense fallback={null}>
          <Harness />
        </Suspense>
      );
    }
  }
  return <AppShell />;
}

export default App;
