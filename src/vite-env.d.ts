/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_DINO_ISSUER?: string;
  readonly VITE_DINO_CLIENT_ID?: string;
  /** Address of the map server. Empty (default) means the same origin as the page. */
  readonly VITE_API_URL?: string;
}
