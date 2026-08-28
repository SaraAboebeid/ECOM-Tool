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
      // The MR Studio projection table (MR-Table/, served statically).
      //   cd MR-Table && python -m http.server 8090
      //
      // Proxied rather than linked so the table and this dashboard share an
      // origin. They talk over BroadcastChannel, which is same-origin only -
      // opening the table on :8090 directly would put it in a different origin
      // and no message would ever arrive.
      '/mr': {
        target: 'http://localhost:8090',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/mr/, ''),
      },
    },
  },
})
