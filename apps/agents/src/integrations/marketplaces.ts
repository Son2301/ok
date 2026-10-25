import { z } from 'zod';
import { hmacSha256Hex } from '../lib/crypto';
import { defineIntegration, IntegrationUnavailableError, type ToolContext, toolBuilder } from './types';

/**
 * Listed-but-not-yet-available integrations. Their tools exist so owners can
 * see what is coming and so agents get a clear, actionable error instead of
 * hallucinating results. Write tools default to `off` (commerce rule).
 */

// ---------------------------------------------------------------- Shopee

export const SHOPEE_HOSTS = {
  live: 'https://partner.shopeemobile.com',
  test: 'https://partner.test-stable.shopeemobile.com',
} as const;

export interface ShopeeSignInput {
  partnerId: number | string;
  partnerKey: string;
  /** API path including the version prefix, e.g. `/api/v2/order/get_order_detail`. */
  path: string;
  /** Unix seconds. */
  timestamp: number;
  accessToken?: string;
  shopId?: number | string;
  merchantId?: number | string;
}

/**
 * Shopee Open Platform v2 request signature (pure function).
 * base string = partner_id + api_path + timestamp [+ access_token + shop_id | merchant_id];
 * sign = hex(HMAC-SHA256(partner_key, base string)).
 * Public APIs (e.g. auth) use only the first three parts.
 */
export function shopeeSign(input: ShopeeSignInput): string {
  if (!input.path.startsWith('/api/v2/')) throw new Error('Shopee path must start with /api/v2/');
  if (input.shopId !== undefined && input.merchantId !== undefined)
    throw new Error('Use either shopId or merchantId, not both');
  let base = `${input.partnerId}${input.path}${input.timestamp}`;
  if (input.shopId !== undefined || input.merchantId !== undefined) {
    if (!input.accessToken) throw new Error('Shop/merchant-level Shopee APIs require an access token');
    base += `${input.accessToken}${input.shopId ?? input.merchantId}`;
  }
  return hmacSha256Hex(input.partnerKey, base);
}

/** Full signed request URL with the common query parameters. */
export function buildShopeeUrl(
  input: ShopeeSignInput & { host?: string; params?: Record<string, string | number | boolean> },
): string {
  const url = new URL(input.path, input.host ?? SHOPEE_HOSTS.live);
  url.searchParams.set('partner_id', String(input.partnerId));
  url.searchParams.set('timestamp', String(input.timestamp));
  if (input.accessToken) url.searchParams.set('access_token', input.accessToken);
  if (input.shopId !== undefined) url.searchParams.set('shop_id', String(input.shopId));
  if (input.merchantId !== undefined) url.searchParams.set('merchant_id', String(input.merchantId));
  url.searchParams.set('sign', shopeeSign(input));
  for (const [k, v] of Object.entries(input.params ?? {})) url.searchParams.set(k, String(v));
  return url.toString();
}

const shopeeAuth = z.object({
  partnerId: z.string().regex(/^\d+$/).optional(),
  partnerKey: z.string().min(8).optional(),
  shopId: z.string().regex(/^\d+$/).optional(),
  accessToken: z.string().min(8).optional(),
});
const shopeeTool = toolBuilder<ToolContext<z.output<typeof shopeeAuth>, Record<string, never>>>();
const SHOPEE_REASON =
  'Shopee Open Platform requires an approved partner app and shop authorization. Request signing is implemented; order/product endpoints will be enabled after partner approval. Ask the business to share order details directly for now.';

export const shopeeIntegration = defineIntegration({
  id: 'shopee',
  name: 'Shopee',
  category: 'commerce',
  description:
    'Shopee Open Platform v2 (coming soon). Request signing is implemented; endpoints await partner approval.',
  verified: false,
  status: 'coming_soon',
  docsUrl: 'https://open.shopee.com/documents',
  authSchema: shopeeAuth,
  tools: [
    shopeeTool({
      name: 'shopee_get_order',
      description: 'Look up a Shopee order by order SN (not available yet).',
      args: z.object({ orderSn: z.string().min(1).max(64) }),
      risk: 'read',
      handler: async () => {
        throw new IntegrationUnavailableError('Shopee', SHOPEE_REASON);
      },
    }),
    shopeeTool({
      name: 'shopee_update_order',
      description: 'Update a Shopee order (not available yet; write tool, off by default).',
      args: z.object({ orderSn: z.string().min(1).max(64), note: z.string().max(500).optional() }),
      risk: 'external_write',
      handler: async () => {
        throw new IntegrationUnavailableError('Shopee', SHOPEE_REASON);
      },
    }),
  ],
});

// ---------------------------------------------------------------- TikTok Shop

const tiktokTool = toolBuilder<ToolContext<Record<string, unknown>, Record<string, never>>>();
const TIKTOK_REASON =
  'TikTok Shop Partner API access requires an approved app and seller authorization, which is not set up yet. Ask the business to check the order in TikTok Shop Seller Center.';

export const tiktokShopIntegration = defineIntegration({
  id: 'tiktok_shop',
  name: 'TikTok Shop',
  category: 'commerce',
  description: 'TikTok Shop orders and products (coming soon).',
  verified: false,
  status: 'coming_soon',
  docsUrl: 'https://partner.tiktokshop.com/docv2',
  authSchema: z.object({
    appKey: z.string().optional(),
    appSecret: z.string().optional(),
    accessToken: z.string().optional(),
  }),
  tools: [
    tiktokTool({
      name: 'tiktok_shop_get_order',
      description: 'Look up a TikTok Shop order (not available yet).',
      args: z.object({ orderId: z.string().min(1).max(64) }),
      risk: 'read',
      handler: async () => {
        throw new IntegrationUnavailableError('TikTok Shop', TIKTOK_REASON);
      },
    }),
    tiktokTool({
      name: 'tiktok_shop_update_order',
      description: 'Update a TikTok Shop order (not available yet; write tool, off by default).',
      args: z.object({ orderId: z.string().min(1).max(64) }),
      risk: 'external_write',
      handler: async () => {
        throw new IntegrationUnavailableError('TikTok Shop', TIKTOK_REASON);
      },
    }),
  ],
});

// ---------------------------------------------------------------- MISA

const misaTool = toolBuilder<ToolContext<Record<string, unknown>, Record<string, never>>>();
const MISA_REASON =
  'MISA (AMIS / meInvoice) integration requires a partner agreement and app credentials issued by MISA, which are not set up yet. Tell the customer an accountant will follow up on invoices.';

export const misaIntegration = defineIntegration({
  id: 'misa',
  name: 'MISA (AMIS / meInvoice)',
  category: 'accounting',
  description: 'Accounting and e-invoices with MISA (coming soon).',
  verified: false,
  status: 'coming_soon',
  docsUrl: 'https://www.misa.vn/',
  authSchema: z.object({ appId: z.string().optional(), accessCode: z.string().optional() }),
  tools: [
    misaTool({
      name: 'misa_lookup_invoice',
      description: 'Look up an e-invoice in MISA meInvoice (not available yet).',
      args: z.object({ invoiceNo: z.string().min(1).max(64) }),
      risk: 'read',
      handler: async () => {
        throw new IntegrationUnavailableError('MISA', MISA_REASON);
      },
    }),
    misaTool({
      name: 'misa_create_invoice',
      description:
        'Issue an e-invoice in MISA meInvoice (not available yet; write tool, needs explicit enabling).',
      args: z.object({ customerName: z.string().max(200), amount: z.number().nonnegative() }),
      risk: 'external_write',
      defaultTrust: 'off',
      handler: async () => {
        throw new IntegrationUnavailableError('MISA', MISA_REASON);
      },
    }),
  ],
});
