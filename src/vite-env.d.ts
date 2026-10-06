/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_E2E_HARNESS?: "1";
  readonly VITE_E2E_HISTORY_FRONTEND?: "1";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
