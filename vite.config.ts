import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
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

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), copyExcalidrawFonts()],

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
