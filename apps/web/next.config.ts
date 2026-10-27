import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Docker builds set NEXT_OUTPUT=standalone (see apps/web/Dockerfile); `next start` keeps the default output.
  ...(process.env.NEXT_OUTPUT === 'standalone'
    ? {
        output: 'standalone' as const,
        // Trace workspace packages from the monorepo root so the bundle is self-contained.
        outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
      }
    : {}),
  // Workspace packages ship TypeScript sources (no build step).
  transpilePackages: ['@minh/core', '@minh/shared', '@minh/db', '@minh/llm'],
  // Native/WASM database drivers must stay runtime `require`s, not bundled.
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    // Agent knowledge files and scam-report evidence go through server actions.
    serverActions: { bodySizeLimit: '8mb' },
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
