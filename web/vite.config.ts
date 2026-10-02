import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: Object.fromEntries(
      ['/rpc', '/healthz', '/readyz'].map((path) => [path, 'http://localhost:8080']),
    ),
  },
});
