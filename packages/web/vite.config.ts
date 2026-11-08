import { defineConfig } from 'vitest/config'
import preact from '@preact/preset-vite'

export default defineConfig({
  plugins: [preact()],
  server: { proxy: { '/sync': 'http://127.0.0.1:8787', '/healthz': 'http://127.0.0.1:8787' } },
  test: { environment: 'node' },
})
