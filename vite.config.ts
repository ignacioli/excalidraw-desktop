import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import type { Plugin } from "vite";
import { STARTUP_MEASURE_EVENT } from "./src/startupMeasure";
const host = process.env.TAURI_DEV_HOST;

function copyExcalidrawFonts() {
  return {
    name: "copy-excalidraw-fonts",
    async configResolved() {
      const source = resolve(
        process.cwd(),
        "node_modules/@excalidraw/excalidraw/dist/prod/fonts",
      );
      const destination = resolve(process.cwd(), "public/fonts/fonts");
      await mkdir(destination, { recursive: true });
      await cp(source, destination, { recursive: true, force: true });
    },
  };
}

// Print startup measures sent by the app, so cold starts can be measured
// from the terminal that runs the dev server.
function logStartupMeasures(): Plugin {
  return {
    name: "log-startup-measures",
    apply: "serve",
    configureServer(server) {
      server.ws.on(STARTUP_MEASURE_EVENT, (data: unknown) => {
        if (typeof data !== "object" || data === null) return;
        const { name, durationMs } = data as Record<string, unknown>;
        if (typeof name !== "string" || typeof durationMs !== "number") return;
        server.config.logger.info(
          `[startup-measure] ${name} ${durationMs.toFixed(1)} ms`,
        );
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), copyExcalidrawFonts(), logStartupMeasures()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
