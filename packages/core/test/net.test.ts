import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { guardedFetch, isPrivateAddress, publicOnlyLookup } from '../src/net';

describe('isPrivateAddress', () => {
  it('sees through IPv6 forms of private IPv4 addresses', () => {
    // The URL parser rewrites [::ffff:127.0.0.1] to [::ffff:7f00:1], so the hex form must be caught.
    for (const ip of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:127.0.0.1', '::127.0.0.1', '64:ff9b::a00:1', '2002:7f00:1::', '2002:a9fe:a9fe::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
  it('blocks special IPv6 ranges and unparseable input', () => {
    for (const ip of ['::', '::1', 'fe80::1', 'fd12:3456::1', 'fec0::1', 'ff02::1', '2001::1', '2001:db8::1', '100::1', 'not-an-ip']) expect(isPrivateAddress(ip), ip).toBe(true);
  });
  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '2001:4860:4860::8888', '64:ff9b::808:808', '2002:808:808::1']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe('connect-time guard', () => {
  it('refuses names that resolve to private addresses', async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((r) => publicOnlyLookup('localhost', {}, (e) => r(e)));
    expect(err?.code).toBe('EPRIVATE');
  });
  it('refuses to connect to a local server even without the URL pre-check', async () => {
    const server = createServer((_q, s) => s.end('secret'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const e = await guardedFetch(`http://localhost:${port}/`).then(() => null, (x: Error & { cause?: { code?: string } }) => x);
      expect(e?.cause?.code).toBe('EPRIVATE');
    } finally {
      server.close();
    }
  });
});
