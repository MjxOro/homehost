/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Commit the prod image was built from; unset in dev builds. */
  readonly VITE_BUILD_SHA?: string;
}
