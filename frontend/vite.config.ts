import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const defaultAllowedHosts = ['listen.wetothemoon.top']
const envAllowedHosts = (process.env.VITE_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean)
const allowedHosts = Array.from(new Set([...defaultAllowedHosts, ...envAllowedHosts]))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    allowedHosts,
    port: 19527,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:9527',
    },
  },
})
