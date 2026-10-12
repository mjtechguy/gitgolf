import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({ plugins: [react(), tailwindcss()], build: { outDir: 'dist-native', rolldownOptions: { input: 'native.html' } },
  server: { proxy: Object.fromEntries(['/rpc', '/native'].map(path => [path, 'http://127.0.0.1:18789'])) } });
