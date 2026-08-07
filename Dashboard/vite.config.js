import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // The Python backend (Dashboard/backend) builds and dispatches
      // communities. Proxying keeps the frontend on relative URLs, so there is
      // no CORS to configure and nothing to change when it moves to a host.
      //   cd backend && python -m uvicorn app.main:app --reload --port 8000
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
