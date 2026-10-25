import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  embeddedIpv4,
  hostAllowed,
  isBlockedIp,
  type LookupFn,
  resolvePublicAddress,
  safeFetch,
} from './ssrf';

describe('isBlockedIp', () => {
  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:7f00:1', // same, hex form
    '::ffff:169.254.169.254',
    '64:ff9b::a00:1', // NAT64 → 10.0.0.1
    '2002:c0a8:0101::1', // 6to4 → 192.168.1.1
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '1.1.1.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '172.32.0.1',
    '192.169.0.1',
  ])('allows public %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it('extracts embedded IPv4 addresses', () => {
    expect(embeddedIpv4('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(embeddedIpv4('64:ff9b::808:808')).toBe('8.8.8.8');
    expect(embeddedIpv4('2606:4700::1')).toBeNull();
  });
});

describe('hostAllowed', () => {
  it('supports exact, wildcard-subdomain and any', () => {
    expect(hostAllowed('api.example.com', ['api.example.com'])).toBe(true);
    expect(hostAllowed('API.Example.com.', ['api.example.com'])).toBe(true);
    expect(hostAllowed('evil.com', ['api.example.com'])).toBe(false);
    expect(hostAllowed('shop.myharavan.com', ['*.myharavan.com'])).toBe(true);
    expect(hostAllowed('myharavan.com', ['*.myharavan.com'])).toBe(false);
    expect(hostAllowed('evilmyharavan.com', ['*.myharavan.com'])).toBe(false);
    expect(hostAllowed('anything.vn', ['*'])).toBe(true);
    expect(hostAllowed('anything.vn', [])).toBe(false);
    expect(hostAllowed('anything.vn', null)).toBe(true);
  });
});

describe('resolvePublicAddress', () => {
  const lookup =
    (map: Record<string, string[]>): LookupFn =>
    async (host) => {
      const ips = map[host];
      if (!ips) throw new Error('ENOTFOUND');
      return ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    };

  it('rejects hostnames that resolve to private addresses (after DNS)', async () => {
    await expect(
      resolvePublicAddress('internal.example.com', lookup({ 'internal.example.com': ['10.0.0.8'] })),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // Any private answer poisons the result (round-robin rebinding trick).
    await expect(
      resolvePublicAddress(
        'mixed.example.com',
        lookup({ 'mixed.example.com': ['93.184.216.34', '127.0.0.1'] }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      resolvePublicAddress('v6.example.com', lookup({ 'v6.example.com': ['::ffff:192.168.0.1'] })),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects private literals and internal names, accepts public ones', async () => {
    await expect(resolvePublicAddress('127.0.0.1')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(resolvePublicAddress('[::1]')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(resolvePublicAddress('localhost')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(resolvePublicAddress('metadata.google.internal')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(resolvePublicAddress('nowhere.example', lookup({}))).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(
      await resolvePublicAddress('api.example.com', lookup({ 'api.example.com': ['93.184.216.34'] })),
    ).toEqual({ address: '93.184.216.34', family: 4 });
  });
});

describe('safeFetch', () => {
  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('x'.repeat(50_000));
      } else if (req.url === '/redirect-internal') {
        res.writeHead(302, { location: 'http://internal.test/secret' });
        res.end();
      } else if (req.url === '/redirect-ok') {
        res.writeHead(302, { location: '/echo' });
        res.end();
      } else if (req.url === '/slow') {
        setTimeout(() => res.end('late'), 2000);
      } else {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, body }));
        });
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // Test DNS: our fixture hosts resolve to the local server; internal.test resolves to a private range.
  const lookup: LookupFn = async (host) => {
    if (host === 'api.fixture.test') return [{ address: '127.0.0.1', family: 4 }];
    if (host === 'internal.test') return [{ address: '10.1.2.3', family: 4 }];
    throw new Error('ENOTFOUND');
  };
  // Policy for the fixture only: allow loopback (where the fixture listens), keep everything else default.
  const allowLoopback = (ip: string) => (ip === '127.0.0.1' ? false : isBlockedIp(ip));

  it('blocks loopback with the default policy (no override)', async () => {
    await expect(safeFetch(`http://127.0.0.1:${port}/echo`)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(safeFetch(`http://api.fixture.test:${port}/echo`, { lookup })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('connects to the validated address and sends the request', async () => {
    const res = await safeFetch(`http://api.fixture.test:${port}/echo?q=1`, {
      lookup,
      isBlocked: allowLoopback,
      method: 'POST',
      body: '{"a":1}',
      headers: { 'content-type': 'application/json', host: 'evil.com' },
    });
    expect(res.status).toBe(200);
    const echo = JSON.parse(res.body.toString());
    expect(echo).toMatchObject({ method: 'POST', url: '/echo?q=1', body: '{"a":1}' });
    expect(echo.host).toBe(`api.fixture.test:${port}`); // Host header cannot be overridden
  });

  it('enforces the allowlist and only http(s)', async () => {
    await expect(
      safeFetch(`http://api.fixture.test:${port}/echo`, {
        lookup,
        isBlocked: allowLoopback,
        allowedHosts: ['other.test'],
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(safeFetch('file:///etc/passwd')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(safeFetch('gopher://x.test/')).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('re-validates every redirect hop', async () => {
    await expect(
      safeFetch(`http://api.fixture.test:${port}/redirect-internal`, { lookup, isBlocked: allowLoopback }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const ok = await safeFetch(`http://api.fixture.test:${port}/redirect-ok`, {
      lookup,
      isBlocked: allowLoopback,
    });
    expect(ok.redirects).toBe(1);
    expect(JSON.parse(ok.body.toString()).url).toBe('/echo');
    await expect(
      safeFetch(`http://api.fixture.test:${port}/redirect-ok`, {
        lookup,
        isBlocked: allowLoopback,
        maxRedirects: 0,
      }),
    ).rejects.toThrow(/Too many redirects/);
  });

  it('limits response size and time', async () => {
    const big = await safeFetch(`http://api.fixture.test:${port}/big`, {
      lookup,
      isBlocked: allowLoopback,
      maxBytes: 1000,
    });
    expect(big.truncated).toBe(true);
    expect(big.body.length).toBe(1000);
    await expect(
      safeFetch(`http://api.fixture.test:${port}/slow`, { lookup, isBlocked: allowLoopback, timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });
});
