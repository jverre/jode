import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'

// Builds the shell SPA to ./dist, which the Worker serves via the ASSETS binding.
export default defineConfig({
  resolve: {
    // @jode/shell ships React; dedupe so the app and the shell share one copy.
    dedupe: ['react', 'react-dom']
  },
  // The shell is consumed as TS/TSX source via the workspace symlink (it imports
  // .svg/.css); let Vite transform it rather than pre-bundle it.
  optimizeDeps: { exclude: ['@jode/shell'] },
  css: {
    postcss: {
      plugins: [tailwindcss(), autoprefixer()]
    }
  },
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true }
})
