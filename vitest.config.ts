import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.{ts,tsx}", "e2e/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
    restoreMocks: true,
  },
});
