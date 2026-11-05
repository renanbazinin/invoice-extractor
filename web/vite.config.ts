import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  root: here('.'),
  // Relative asset paths: the built app works from any folder of any static host.
  base: './',
  plugins: [react()],
  resolve: {
    // The extraction pipeline in ../src reaches the platform through './nodeEnv' (Node: pdf.js
    // files on disk, @napi-rs/canvas, tessdata from node_modules). The browser gets its own.
    alias: [{ find: /^\.\/nodeEnv(\.ts)?$/, replacement: here('./src/env.browser.ts') }],
  },
  server: {
    port: 5173,
    fs: { allow: [here('..')] },
  },
  preview: { port: 4173 },
  build: {
    outDir: here('./dist'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 3000,
  },
})
