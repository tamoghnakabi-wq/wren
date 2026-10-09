import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@wren/core'],
  serverExternalPackages: ['web-push'],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Only the origin, even within the site: a private page's address (task and file ids, pairing
          // codes) never becomes the next page's referrer, which analytics on public pages could see (W-141).
          { key: 'Referrer-Policy', value: 'strict-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }, { key: 'Service-Worker-Allowed', value: '/' }] },
    ];
  },
};

export default nextConfig;
