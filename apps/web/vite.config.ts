import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const striker = env.VITE_STRIKER_URL || 'http://localhost:7090';
  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
        manifest: {
          name: 'Striker',
          short_name: 'Striker',
          description: 'Swap BTC and USD on Arkade',
          theme_color: '#0b1020',
          background_color: '#0b1020',
          display: 'standalone',
          start_url: '/',
          icons: [
            { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // App shell only; the API is always network-only.
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/v1\//],
          runtimeCaching: [{ urlPattern: ({ url }) => url.pathname.startsWith('/v1/'), handler: 'NetworkOnly' }],
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        },
      }),
    ],
    // The Ark SDK dominates the bundle; it is precached by the service worker.
    build: { chunkSizeWarningLimit: 1600 },
    server: {
      proxy: { '/v1': { target: striker, changeOrigin: true } },
    },
    preview: {
      proxy: { '/v1': { target: striker, changeOrigin: true } },
    },
  };
});
