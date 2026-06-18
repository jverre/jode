import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'

// Follows electron-vite conventions:
//   main    → src/main/index.ts
//   preload → src/preload/index.ts
//   renderer→ src/renderer/index.html
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src')
      },
      // @jode/shell is a linked workspace package that ships React — dedupe so the
      // renderer and the shell share one React instance (hooks break otherwise).
      dedupe: ['react', 'react-dom']
    },
    // The shell is consumed as TS/TSX source via the workspace symlink; let Vite
    // transform it instead of trying to pre-bundle (it imports .svg/.css).
    optimizeDeps: { exclude: ['@jode/shell'] },
    css: {
      postcss: {
        plugins: [tailwindcss(), autoprefixer()]
      }
    },
    plugins: [react()]
  }
})
