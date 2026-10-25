import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // relative asset paths, so the build works under any path (GitHub Pages serves it at /meshcore-console/)
  base: './',
  plugins: [react()],
  test: {
    include: ['test/**/*.test.ts'],
  },
})
