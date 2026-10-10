import React from "react";
import ReactDOM from "react-dom/client";
import { initializeBrowserThemeController } from "./app/theme/themeController";
import { initializeBrowserLocaleController } from "./i18n";
import { readSystemLanguages } from "./i18n/systemLanguages";
import {
  configureExcalidrawAssets,
  loadBundledCjkFont,
} from "./editor/fontLoader";
import "./app/theme/tokens.css";
import { STARTUP_MEASURE_EVENT } from "./startupMeasure";

initializeBrowserThemeController();
configureExcalidrawAssets();

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Application root element is missing");
}
const applicationRoot = root;

async function renderApplication() {
  void loadBundledCjkFont().catch((error: unknown) => {
    console.warn("Bundled CJK font could not be preloaded.", error);
  });
  // The UI language must be known before the first render.
  performance.mark("language-handshake:start");
  const systemLanguages = await readSystemLanguages();
  const handshake = performance.measure(
    "language-handshake",
    "language-handshake:start",
  );
  initializeBrowserLocaleController(systemLanguages);
  if (import.meta.env.DEV) {
    // The dev server prints this so cold starts can be measured from the shell.
    console.info(`language-handshake ${handshake.duration.toFixed(1)} ms`);
    import.meta.hot?.send(STARTUP_MEASURE_EVENT, {
      name: handshake.name,
      durationMs: handshake.duration,
    });
  }
  const { default: App } = await import("./App");

  ReactDOM.createRoot(applicationRoot).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void renderApplication();
