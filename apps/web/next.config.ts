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
          // No other site may show Wren in a frame (clickjacking: an invisible Approve or Link button under
          // its own). Wren frames none of its own pages either, except agents' pages (below). The session cookies
          // are SameSite=Lax, so a framed copy loads signed out today; this doesn't depend on that.
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
      // Wren's pages frame only Wren: the one frame they have shows a page an agent made (/api/pages), and
      // nothing it does can take that frame anywhere else.
      { source: '/((?!api/).*)', headers: [{ key: 'Content-Security-Policy', value: "frame-src 'self'" }] },
      // Agents' pages are the exception to DENY: Wren frames them itself (the route also sends this, with
      // frame-ancestors 'self' in their policy). Later rules win for the same header.
      { source: '/api/pages/:id', headers: [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }] },
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }, { key: 'Service-Worker-Allowed', value: '/' }] },
    ];
  },
};

export default nextConfig;
