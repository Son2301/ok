import { AppError } from '@ok/shared';
import { z } from 'zod';
import { type FetchLike, requestJson } from '../lib/http';
import { defineIntegration, type ToolContext, toolBuilder } from './types';

/**
 * Shopify Admin GraphQL API. Docs: https://shopify.dev/docs/api/admin-graphql — verified: false.
 * Auth: custom-app Admin API access token in `X-Shopify-Access-Token`.
 * The shop domain is validated (`*.myshopify.com`) so config cannot redirect requests elsewhere.
 */
export const shopifyAuth = z.object({
  accessToken: z.string().min(10).describe('Admin API access token (shpat_…)'),
});
export const shopifyConfig = z.object({
  shopDomain: z
    .string()
    .transform((s) =>
      s
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, ''),
    )
    .pipe(z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/, 'must be your-store.myshopify.com')),
  apiVersion: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .default('2025-10'),
});
type Creds = z.output<typeof shopifyAuth>;
type Config = z.output<typeof shopifyConfig>;

export async function shopifyGraphql<T>(
  ctx: { fetch: FetchLike; credentials: Creds; config: unknown; signal?: AbortSignal },
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const config = shopifyConfig.safeParse(ctx.config ?? {});
  if (!config.success)
    throw new AppError(
      'bad_request',
      'Shopify integration needs config.shopDomain (your-store.myshopify.com).',
    );
  const res = await requestJson<{ data?: T; errors?: { message: string }[] | string }>(
    ctx.fetch,
    `https://${config.data.shopDomain}/admin/api/${config.data.apiVersion}/graphql.json`,
    {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': ctx.credentials.accessToken },
      body: { query, variables },
      service: 'Shopify',
      signal: ctx.signal,
    },
  );
  if (res.errors && (typeof res.errors === 'string' || res.errors.length)) {
    const msg = typeof res.errors === 'string' ? res.errors : res.errors.map((e) => e.message).join('; ');
    throw new AppError('upstream_error', `Shopify GraphQL error: ${msg}`);
  }
  if (!res.data) throw new AppError('upstream_error', 'Shopify returned no data');
  return res.data;
}

type Edges<T> = { edges: { node: T }[] };
const nodes = <T>(c: Edges<T> | undefined) => (c?.edges ?? []).map((e) => e.node);
type Money = { shopMoney: { amount: string; currencyCode: string } };

export const ORDERS_QUERY = `query FindOrders($query: String!, $first: Int!) {
  orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
    edges { node {
      id name createdAt displayFinancialStatus displayFulfillmentStatus cancelledAt note email phone
      totalPriceSet { shopMoney { amount currencyCode } }
      customer { displayName email phone }
      lineItems(first: 20) { edges { node { title quantity sku originalUnitPriceSet { shopMoney { amount currencyCode } } } } }
    } }
  }
}`;
export const PRODUCTS_QUERY = `query SearchProducts($query: String!, $first: Int!) {
  products(first: $first, query: $query) {
    edges { node {
      id title handle status vendor productType totalInventory
      variants(first: 20) { edges { node { id title sku price inventoryQuantity } } }
    } }
  }
}`;
export const CUSTOMERS_QUERY = `query FindCustomers($query: String!, $first: Int!) {
  customers(first: $first, query: $query) {
    edges { node { id displayName email phone numberOfOrders amountSpent { amount currencyCode } } }
  }
}`;
export const DRAFT_ORDER_MUTATION = `mutation CreateDraftOrder($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder { id name invoiceUrl totalPriceSet { shopMoney { amount currencyCode } } }
    userErrors { field message }
  }
}`;

interface ShopifyOrder {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus?: string;
  displayFulfillmentStatus?: string;
  cancelledAt?: string | null;
  note?: string | null;
  email?: string | null;
  phone?: string | null;
  totalPriceSet?: Money;
  customer?: { displayName?: string; email?: string; phone?: string } | null;
  lineItems?: Edges<{ title: string; quantity: number; sku?: string | null; originalUnitPriceSet?: Money }>;
}

export const mapShopifyOrder = (o: ShopifyOrder) => ({
  id: o.id,
  name: o.name,
  createdAt: o.createdAt,
  financialStatus: o.displayFinancialStatus ?? null,
  fulfillmentStatus: o.displayFulfillmentStatus ?? null,
  cancelled: Boolean(o.cancelledAt),
  total: o.totalPriceSet
    ? `${o.totalPriceSet.shopMoney.amount} ${o.totalPriceSet.shopMoney.currencyCode}`
    : null,
  customer: o.customer
    ? {
        name: o.customer.displayName ?? null,
        email: o.customer.email ?? o.email ?? null,
        phone: o.customer.phone ?? o.phone ?? null,
      }
    : null,
  note: o.note ?? null,
  items: nodes(o.lineItems).map((l) => ({
    title: l.title,
    quantity: l.quantity,
    sku: l.sku ?? null,
    unitPrice: l.originalUnitPriceSet?.shopMoney.amount ?? null,
  })),
});

const tool = toolBuilder<ToolContext<Creds, Config>>();

export const shopifyIntegration = defineIntegration({
  id: 'shopify',
  name: 'Shopify',
  category: 'commerce',
  description:
    'Look up Shopify orders, products and customers (Admin GraphQL API). Draft-order creation is off unless enabled.',
  verified: false,
  status: 'available',
  docsUrl: 'https://shopify.dev/docs/api/admin-graphql',
  authSchema: shopifyAuth,
  configSchema: shopifyConfig,
  tools: [
    tool({
      name: 'shopify_find_orders',
      description:
        'Find Shopify orders using Shopify search syntax, e.g. "name:#1001", "email:an@example.com", "phone:+8490…".',
      args: z.object({
        query: z.string().min(1).max(300),
        first: z.number().int().min(1).max(25).default(5),
      }),
      risk: 'read',
      handler: async (ctx, args) => {
        const data = await shopifyGraphql<{ orders: Edges<ShopifyOrder> }>(ctx, ORDERS_QUERY, args);
        return { orders: nodes(data.orders).map(mapShopifyOrder) };
      },
    }),
    tool({
      name: 'shopify_search_products',
      description:
        'Search Shopify products (e.g. "title:*áo*" or free text) with variants, prices and stock.',
      args: z.object({
        query: z.string().min(1).max(300),
        first: z.number().int().min(1).max(25).default(10),
      }),
      risk: 'read',
      handler: async (ctx, args) => {
        const data = await shopifyGraphql<{
          products: Edges<{
            id: string;
            title: string;
            handle: string;
            status: string;
            vendor: string;
            productType: string;
            totalInventory: number | null;
            variants: Edges<{
              id: string;
              title: string;
              sku: string | null;
              price: string;
              inventoryQuantity: number | null;
            }>;
          }>;
        }>(ctx, PRODUCTS_QUERY, args);
        return {
          products: nodes(data.products).map((p) => ({
            id: p.id,
            title: p.title,
            status: p.status,
            vendor: p.vendor,
            type: p.productType,
            totalInventory: p.totalInventory,
            variants: nodes(p.variants).map((v) => ({
              id: v.id,
              title: v.title,
              sku: v.sku,
              price: v.price,
              stock: v.inventoryQuantity,
            })),
          })),
        };
      },
    }),
    tool({
      name: 'shopify_find_customers',
      description:
        'Find Shopify customers by search query, e.g. "email:an@example.com" or "phone:+8490…" or a name.',
      args: z.object({
        query: z.string().min(1).max(300),
        first: z.number().int().min(1).max(25).default(5),
      }),
      risk: 'read',
      handler: async (ctx, args) => {
        const data = await shopifyGraphql<{
          customers: Edges<{
            id: string;
            displayName: string;
            email: string | null;
            phone: string | null;
            numberOfOrders: string | number;
            amountSpent?: { amount: string; currencyCode: string };
          }>;
        }>(ctx, CUSTOMERS_QUERY, args);
        return {
          customers: nodes(data.customers).map((c) => ({
            id: c.id,
            name: c.displayName,
            email: c.email,
            phone: c.phone,
            orders: Number(c.numberOfOrders),
            spent: c.amountSpent ? `${c.amountSpent.amount} ${c.amountSpent.currencyCode}` : null,
          })),
        };
      },
    }),
    tool({
      name: 'shopify_create_draft_order',
      description:
        'Create a Shopify draft order (with an invoice link) for a customer. Write tool: disabled unless the owner enables it.',
      args: z.object({
        email: z.string().email().optional(),
        note: z.string().max(1000).optional(),
        lineItems: z
          .array(
            z.object({
              variantId: z.string().startsWith('gid://shopify/ProductVariant/'),
              quantity: z.number().int().positive(),
            }),
          )
          .min(1)
          .max(50),
      }),
      risk: 'external_write',
      handler: async (ctx, args) => {
        const data = await shopifyGraphql<{
          draftOrderCreate: {
            draftOrder: { id: string; name: string; invoiceUrl: string; totalPriceSet: Money } | null;
            userErrors: { field: string[]; message: string }[];
          };
        }>(ctx, DRAFT_ORDER_MUTATION, {
          input: { email: args.email, note: args.note, lineItems: args.lineItems },
        });
        const { draftOrder, userErrors } = data.draftOrderCreate;
        if (userErrors.length || !draftOrder)
          throw new AppError(
            'upstream_error',
            `Shopify rejected the draft order: ${userErrors.map((e) => e.message).join('; ')}`,
          );
        return {
          draftOrder: {
            id: draftOrder.id,
            name: draftOrder.name,
            invoiceUrl: draftOrder.invoiceUrl,
            total: draftOrder.totalPriceSet.shopMoney.amount,
          },
        };
      },
    }),
  ],
});
