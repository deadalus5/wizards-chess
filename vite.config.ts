import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig(({ command }) => ({
  // GitHub Pages serves the site from /wizards-chess/; dev stays at the root.
  base: command === 'build' ? '/wizards-chess/' : '/',
  // The three.js devtools proxy serves this app from another port; keep HMR on Vite's own port
  // so its websocket never lands on the proxy's bridge socket.
  server: { port: 5173, strictPort: true, hmr: { clientPort: 5173 } },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
    rollupOptions: { input: { main: at('./index.html'), lab: at('./clip-lab.html') } },
  },
}));
