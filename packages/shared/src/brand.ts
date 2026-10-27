/**
 * Single source of truth for product naming. Rename the platform here; nothing
 * else in the codebase hard-codes the brand.
 */
export const BRAND = {
  name: process.env.BRAND_NAME ?? 'Minh AI',
  domain: process.env.BRAND_DOMAIN ?? 'minh.local',
  products: {
    gateway: 'Gateway',
    agents: 'Agents',
    safe: 'Safe',
    review: 'Review',
  },
} as const;

export type ProductId = keyof typeof BRAND.products;
export const PRODUCT_IDS = Object.keys(BRAND.products) as ProductId[];
