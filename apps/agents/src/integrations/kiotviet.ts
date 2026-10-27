import { AppError } from '@minh/shared';
import { z } from 'zod';
import { sha256Hex } from '../lib/crypto';
import { type FetchLike, qs, requestJson } from '../lib/http';
import { defineIntegration, type ToolContext, toolBuilder } from './types';

/**
 * KiotViet Public API (retail POS popular with Vietnamese shops).
 * Docs: https://www.kiotviet.vn/huong-dan-su-dung-public-api-retail/ — verified: false.
 *
 * Auth: OAuth2 client credentials at id.kiotviet.vn, then `Authorization: Bearer`
 * plus a `Retailer: <shop name>` header on public.kiotapi.com.
 */
export const KIOTVIET_TOKEN_URL = 'https://id.kiotviet.vn/connect/token';
export const KIOTVIET_API = 'https://public.kiotapi.com';

export const kiotvietAuth = z.object({
  clientId: z.string().min(8).describe('Client ID (Thiết lập → Thiết lập kết nối API)'),
  clientSecret: z.string().min(8).describe('Mã bảo mật / client secret'),
});
export const kiotvietConfig = z.object({
  retailer: z.string().min(1).max(100).describe('Retailer (tên gian hàng) used in the Retailer header'),
});
type Creds = z.output<typeof kiotvietAuth>;
type Config = z.output<typeof kiotvietConfig>;

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
export const clearKiotVietTokenCache = () => tokenCache.clear();

export async function kiotvietToken(fetchFn: FetchLike, creds: Creds, now = Date.now()): Promise<string> {
  const key = sha256Hex(`${creds.clientId}:${creds.clientSecret}`);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > now + 60_000) return cached.token;
  const res = await requestJson<{ access_token?: string; expires_in?: number }>(fetchFn, KIOTVIET_TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({
      scopes: 'PublicApi.Access',
      grant_type: 'client_credentials',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }),
    service: 'KiotViet auth',
  });
  if (!res.access_token) throw new AppError('upstream_error', 'KiotViet did not return an access token');
  tokenCache.set(key, { token: res.access_token, expiresAt: now + (res.expires_in ?? 3600) * 1000 });
  return res.access_token;
}

async function kv<T>(
  ctx: { fetch: FetchLike; credentials: Creds; config: Config; signal?: AbortSignal },
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const config = kiotvietConfig.safeParse(ctx.config ?? {});
  if (!config.success)
    throw new AppError('bad_request', 'KiotViet integration needs config.retailer (your shop name).');
  const token = await kiotvietToken(ctx.fetch, ctx.credentials);
  return requestJson<T>(ctx.fetch, `${KIOTVIET_API}${path}`, {
    method: init.method ?? 'GET',
    headers: { Retailer: config.data.retailer, Authorization: `Bearer ${token}` },
    body: init.body,
    service: 'KiotViet',
    signal: ctx.signal,
  });
}

interface KvProduct {
  id: number;
  code: string;
  name: string;
  fullName?: string;
  categoryName?: string;
  basePrice?: number;
  unit?: string;
  inventories?: { branchId: number; branchName: string; onHand: number; reserved?: number }[];
}
interface KvOrder {
  id: number;
  code: string;
  purchaseDate?: string;
  branchName?: string;
  customerCode?: string;
  customerName?: string;
  total?: number;
  totalPayment?: number;
  statusValue?: string;
  status?: number;
  description?: string;
  orderDetails?: { productCode: string; productName: string; quantity: number; price: number }[];
}
interface KvCustomer {
  id: number;
  code: string;
  name: string;
  contactNumber?: string;
  email?: string;
  address?: string;
  debt?: number;
  totalPoint?: number;
}
interface KvList<T> {
  total?: number;
  data?: T[];
}

export const mapKvProduct = (p: KvProduct) => ({
  id: p.id,
  code: p.code,
  name: p.fullName ?? p.name,
  category: p.categoryName ?? null,
  price: p.basePrice ?? null,
  unit: p.unit ?? null,
  stock: (p.inventories ?? []).map((i) => ({
    branch: i.branchName,
    onHand: i.onHand,
    reserved: i.reserved ?? 0,
  })),
});
export const mapKvOrder = (o: KvOrder) => ({
  id: o.id,
  code: o.code,
  date: o.purchaseDate ?? null,
  branch: o.branchName ?? null,
  customer: o.customerName ? { code: o.customerCode, name: o.customerName } : null,
  total: o.total ?? null,
  paid: o.totalPayment ?? null,
  status: o.statusValue ?? o.status ?? null,
  note: o.description ?? null,
  items: (o.orderDetails ?? []).map((d) => ({
    code: d.productCode,
    name: d.productName,
    quantity: d.quantity,
    price: d.price,
  })),
});
const mapKvCustomer = (c: KvCustomer) => ({
  id: c.id,
  code: c.code,
  name: c.name,
  phone: c.contactNumber ?? null,
  email: c.email ?? null,
  address: c.address ?? null,
  debt: c.debt ?? 0,
  points: c.totalPoint ?? 0,
});

const tool = toolBuilder<ToolContext<Creds, Config>>();

export const kiotvietIntegration = defineIntegration({
  id: 'kiotviet',
  name: 'KiotViet',
  category: 'commerce',
  description:
    'Look up products, stock, orders and customers in KiotViet. Order creation is off unless you enable it.',
  verified: false,
  status: 'available',
  docsUrl: 'https://www.kiotviet.vn/huong-dan-su-dung-public-api-retail/',
  authSchema: kiotvietAuth,
  configSchema: kiotvietConfig,
  tools: [
    tool({
      name: 'kiotviet_search_products',
      description:
        'Search KiotViet products by name (or exact product code) with price and stock per branch.',
      args: z.object({
        query: z.string().max(200).optional().describe('Product name to search'),
        code: z.string().max(100).optional().describe('Exact product code (mã hàng)'),
        pageSize: z.number().int().min(1).max(50).default(10),
      }),
      risk: 'read',
      handler: async (ctx, args) => {
        if (args.code)
          return {
            products: [
              mapKvProduct(await kv<KvProduct>(ctx, `/products/code/${encodeURIComponent(args.code)}`)),
            ],
          };
        const res = await kv<KvList<KvProduct>>(
          ctx,
          `/products${qs({ name: args.query, pageSize: args.pageSize, includeInventory: true, orderBy: 'name' })}`,
        );
        return { total: res.total ?? res.data?.length ?? 0, products: (res.data ?? []).map(mapKvProduct) };
      },
    }),
    tool({
      name: 'kiotviet_get_order',
      description: 'Get a KiotViet order by its code (mã đặt hàng), including items and status.',
      args: z.object({ code: z.string().min(1).max(100) }),
      risk: 'read',
      handler: async (ctx, args) => ({
        order: mapKvOrder(await kv<KvOrder>(ctx, `/orders/code/${encodeURIComponent(args.code)}`)),
      }),
    }),
    tool({
      name: 'kiotviet_list_orders',
      description: 'List recent KiotViet orders, optionally for one customer code.',
      args: z.object({
        customerCode: z.string().max(100).optional(),
        pageSize: z.number().int().min(1).max(50).default(10),
      }),
      risk: 'read',
      handler: async (ctx, args) => {
        const res = await kv<KvList<KvOrder>>(
          ctx,
          `/orders${qs({ customerCode: args.customerCode, pageSize: args.pageSize, orderBy: 'createdDate', orderDirection: 'Desc' })}`,
        );
        return { total: res.total ?? 0, orders: (res.data ?? []).map(mapKvOrder) };
      },
    }),
    tool({
      name: 'kiotviet_find_customers',
      description: 'Find KiotViet customers by phone number, name or customer code.',
      args: z.object({
        phone: z.string().max(20).optional(),
        name: z.string().max(100).optional(),
        code: z.string().max(100).optional(),
        pageSize: z.number().int().min(1).max(20).default(5),
      }),
      risk: 'read',
      handler: async (ctx, args) => {
        if (!args.phone && !args.name && !args.code)
          throw new AppError('bad_request', 'Provide phone, name or code');
        const res = await kv<KvList<KvCustomer>>(
          ctx,
          `/customers${qs({ contactNumber: args.phone, name: args.name, code: args.code, pageSize: args.pageSize })}`,
        );
        return { total: res.total ?? 0, customers: (res.data ?? []).map(mapKvCustomer) };
      },
    }),
    tool({
      name: 'kiotviet_create_order',
      description:
        'Create a KiotViet order (đặt hàng) for a customer. Write tool: disabled unless the owner enables it.',
      args: z.object({
        branchId: z.number().int(),
        customerId: z.number().int().optional(),
        customer: z.object({ name: z.string().max(200), contactNumber: z.string().max(20) }).optional(),
        items: z
          .array(
            z.object({
              productId: z.number().int(),
              productCode: z.string().optional(),
              quantity: z.number().positive(),
              price: z.number().nonnegative().optional(),
            }),
          )
          .min(1)
          .max(50),
        description: z.string().max(1000).optional(),
      }),
      risk: 'external_write',
      handler: async (ctx, args) => {
        const order = await kv<KvOrder>(ctx, '/orders', {
          method: 'POST',
          body: {
            branchId: args.branchId,
            ...(args.customerId ? { customerId: args.customerId } : {}),
            ...(args.customer ? { customer: args.customer } : {}),
            description: args.description,
            orderDetails: args.items.map((i) => ({
              productId: i.productId,
              productCode: i.productCode,
              quantity: i.quantity,
              price: i.price,
            })),
          },
        });
        return { order: mapKvOrder(order) };
      },
    }),
  ],
});
