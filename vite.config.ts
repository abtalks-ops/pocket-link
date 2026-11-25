import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

// BASE_PATH lets you host under a sub-path, e.g. GitHub Pages: BASE_PATH=/pocket-link/
const base = process.env.BASE_PATH ?? '/';
// Phones only allow the camera on HTTPS, so the dev server uses a self-signed cert.
// Set NO_HTTPS=1 to turn that off (e.g. for automated tests on localhost).
const https = !process.env.NO_HTTPS;

export default defineConfig({
  base,
  plugins: [
    react(),
    ...(https ? [basicSsl()] : []),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Pocket Link',
        short_name: 'Pocket Link',
        description: 'Chat and share files with friends nearby. Phone to phone, no server.',
        theme_color: '#0f766e',
        background_color: '#0b1214',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        navigateFallback: 'index.html',
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
