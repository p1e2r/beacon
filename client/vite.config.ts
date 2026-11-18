import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  base: './',
  plugins: [nodePolyfills({ include: ['buffer', 'events', 'process', 'util', 'stream', 'zlib', 'assert', 'crypto'], globals: { Buffer: true, process: true, global: true } })],
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: { host: true }
})
