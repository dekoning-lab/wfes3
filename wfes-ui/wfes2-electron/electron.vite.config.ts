import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'

// Baked in at build time so an exported figure can name the version that made
// it. Read from package.json rather than repeated by hand, because a
// provenance stamp carrying a stale version is worse than one carrying none.
const APP_VERSION = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf8')
).version as string

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer'),
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION)
    },
    publicDir: resolve(__dirname, 'public'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})