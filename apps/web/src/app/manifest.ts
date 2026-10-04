import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Wren',
    short_name: 'Wren',
    description: 'Your personal AI agents — start tasks, approve actions and get results from anywhere.',
    start_url: '/app',
    scope: '/',
    display: 'standalone',
    background_color: '#121110',
    theme_color: '#121110',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
