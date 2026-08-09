import React from "react";
import ReactDOM from "react-dom/client";
import { initializeBrowserThemeController } from "./app/theme/themeController";
import {
  configureExcalidrawAssets,
  loadBundledCjkFont,
} from "./editor/fontLoader";
import "./app/theme/tokens.css";

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
  const { default: App } = await import("./App");

  ReactDOM.createRoot(applicationRoot).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void renderApplication();
