import { AppError } from '@ok/shared';
import { z } from 'zod';
import { type FetchLike, qs, requestJson } from '../lib/http';
import { defineIntegration, type ToolContext, toolBuilder } from './types';

/**
 * Haravan (Vietnamese e-commerce platform; Shopify-like REST API).
 * Docs: https://docs.haravan.com/ — verified: false.
 * Auth: private-app / OAuth access token as `Authorization: Bearer`.
 */
export const HARAVAN_API = 'https://apis.haravan.com/com';

export const haravanAuth = z.object({
  accessToken: z.string().min(10).describe('Private app or OAuth access token'),
});
type Creds = z.output<typeof haravanAuth>;

async function hrv<T>(
  ctx: { fetch: FetchLike; credentials: Creds; signal?: AbortSignal },
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  return requestJson<T>(ctx.fetch, `${HARAVAN_API}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` },
    body: init.body,
    service: 'Haravan',
    signal: ctx.signal,
  });
}

interface HrvOrder {
  id: number;
  name?: string;
  order_number?: number;
  email?: string;
  created_at?: string;
  total_price?: number | string;
  currency?: string;
  financial_status?: string;
  fulfillment_status?: string | null;
  cancelled_status?: string;
  note?: string | null;
  customer?: { first_name?: string; last_name?: string; phone?: string; email?: string } | null;
  shipping_address?: { phone?: string; address1?: string; province?: string } | null;
  line_items?: {
    title: string;
    variant_title?: string;
    quantity: number;
    price: number | string;
    sku?: string;
  }[];
}
interface HrvProduct {
  id: number;
  title: string;
  handle?: string;
  vendor?: string;
  product_type?: string;
  variants?: {
    id: number;
    title: string;
    sku?: string;
    price: number | string;
    inventory_quantity?: number;
  }[];
}
interface HrvCustomer {
  id: number;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  orders_count?: number;
  total_spent?: number | string;
}

export const mapHrvOrder = (o: HrvOrder) => ({
  id: o.id,
  name: o.name ?? (o.order_number ? `#${o.order_number}` : null),
  createdAt: o.created_at ?? null,
  total: o.total_price !== undefined ? Number(o.total_price) : null,
  currency: o.currency ?? 'VND',
  financialStatus: o.financial_status ?? null,
  fulfillmentStatus: o.fulfillment_status ?? null,
  cancelled: o.cancelled_status === 'cancelled',
  customer: o.customer
    ? {
        name: [o.customer.last_name, o.customer.first_name].filter(Boolean).join(' '),
        phone: o.customer.phone ?? o.shipping_address?.phone ?? null,
        email: o.customer.email ?? o.email ?? null,
      }
    : null,
  note: o.note ?? null,
  items: (o.line_items ?? []).map((l) => ({
    title: l.variant_title ? `${l.title} - ${l.variant_title}` : l.title,
    sku: l.sku ?? null,
    quantity: l.quantity,
    price: Number(l.price),
  })),
});
const mapHrvProduct = (p: HrvProduct) => ({
  id: p.id,
  title: p.title,
  vendor: p.vendor ?? null,
  type: p.product_type ?? null,
  variants: (p.variants ?? []).map((v) => ({
    id: v.id,
    title: v.title,
    sku: v.sku ?? null,
    price: Number(v.price),
    stock: v.inventory_quantity ?? null,
  })),
});
const mapHrvCustomer = (c: HrvCustomer) => ({
  id: c.id,
  name: [c.last_name, c.first_name].filter(Boolean).join(' '),
  email: c.email ?? null,
  phone: c.phone ?? null,
  ordersCount: c.orders_count ?? 0,
  totalSpent: c.total_spent !== undefined ? Number(c.total_spent) : 0,
});

const normPhone = (s: string) => s.replace(/\D/g, '').replace(/^84/, '0');

const tool = toolBuilder<ToolContext<Creds, Record<string, never>>>();

export const haravanIntegration = defineIntegration({
  id: 'haravan',
  name: 'Haravan',
  category: 'commerce',
  description: 'Look up Haravan orders, products and customers. Write tools are off unless you enable them.',
  verified: false,
  status: 'available',
  docsUrl: 'https://docs.haravan.com/',
  authSchema: haravanAuth,
  tools: [
    tool({
      name: 'haravan_get_order',
      description: 'Get a Haravan order by its numeric id.',
      args: z.object({ orderId: z.number().int() }),
      risk: 'read',
      handler: async (ctx, args) => ({
        order: mapHrvOrder((await hrv<{ order: HrvOrder }>(ctx, `/orders/${args.orderId}.json`)).order),
      }),
    }),
    tool({
      name: 'haravan_find_orders',
      description:
        'List recent Haravan orders, optionally filtered by order number (e.g. #1001), customer phone or email.',
      args: z.object({
        orderNumber: z.string().max(50).optional(),
        phone: z.string().max(20).optional(),
        email: z.string().max(200).optional(),
        status: z.enum(['open', 'closed', 'cancelled', 'any']).default('any'),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      risk: 'read',
      handler: async (ctx, args) => {
        // The list endpoint has no free-text filter; fetch recent orders and filter locally.
        const res = await hrv<{ orders: HrvOrder[] }>(
          ctx,
          `/orders.json${qs({ status: args.status, limit: args.orderNumber || args.phone || args.email ? 250 : args.limit })}`,
        );
        const want = args.orderNumber?.replace(/^#/, '');
        const phone = args.phone ? normPhone(args.phone) : null;
        const orders = (res.orders ?? []).filter((o) => {
          if (want && String(o.order_number ?? '') !== want && o.name?.replace(/^#/, '') !== want)
            return false;
          if (
            phone &&
            ![o.customer?.phone, o.shipping_address?.phone].some((p) => p && normPhone(p) === phone)
          )
            return false;
          if (
            args.email &&
            ![o.email, o.customer?.email].some((e) => e?.toLowerCase() === args.email!.toLowerCase())
          )
            return false;
          return true;
        });
        return { orders: orders.slice(0, args.limit).map(mapHrvOrder) };
      },
    }),
    tool({
      name: 'haravan_search_products',
      description: 'Search Haravan products by title, with variants, prices and stock.',
      args: z.object({
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      risk: 'read',
      handler: async (ctx, args) => {
        const res = await hrv<{ products: HrvProduct[] }>(
          ctx,
          `/products.json${qs({ title: args.query, limit: args.limit })}`,
        );
        return { products: (res.products ?? []).map(mapHrvProduct) };
      },
    }),
    tool({
      name: 'haravan_search_customers',
      description: 'Search Haravan customers by name, phone or email.',
      args: z.object({
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(20).default(5),
      }),
      risk: 'read',
      handler: async (ctx, args) => {
        const res = await hrv<{ customers: HrvCustomer[] }>(
          ctx,
          `/customers/search.json${qs({ query: args.query, limit: args.limit })}`,
        );
        return { customers: (res.customers ?? []).map(mapHrvCustomer) };
      },
    }),
    tool({
      name: 'haravan_add_order_note',
      description:
        'Set the internal note on a Haravan order. Write tool: disabled unless the owner enables it.',
      args: z.object({ orderId: z.number().int(), note: z.string().min(1).max(2000) }),
      risk: 'external_write',
      handler: async (ctx, args) => {
        const res = await hrv<{ order: HrvOrder }>(ctx, `/orders/${args.orderId}.json`, {
          method: 'PUT',
          body: { order: { id: args.orderId, note: args.note } },
        });
        if (!res?.order) throw new AppError('upstream_error', 'Haravan did not return the updated order');
        return { order: mapHrvOrder(res.order) };
      },
    }),
  ],
});
