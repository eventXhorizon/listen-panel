import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 19527,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:9527',
    },
  },
})
