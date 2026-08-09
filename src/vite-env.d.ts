/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_E2E_HARNESS?: "1";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
