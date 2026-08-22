/// <reference types="vite/client" />

/**
 * Application version, substituted at build time by electron.vite.config.ts
 * from package.json. Declared here as well as in the preload types because the
 * renderer is a separate TypeScript project and does not see that file.
 */
declare const __APP_VERSION__: string
