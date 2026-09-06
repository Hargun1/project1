/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Empty means same-origin: the Vite proxy (dev) or Nginx (prod) forwards to the backend. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
