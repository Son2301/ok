/**
 * Creates (once) the platform org that pays for free-tier usage (Safe checks,
 * Review free quota, Agents included LLM quota) and prints its id.
 *   DATABASE_URL=postgres://… pnpm tsx scripts/seed-platform.ts
 */
import { Core, coreSchema } from '@ok/core';
import { createDb } from '@ok/db';
import { eq } from 'drizzle-orm';

const handle = await createDb(process.env.DATABASE_URL);
const core = new Core(handle);
await core.migrate();
const name = process.env.PLATFORM_ORG_NAME ?? 'Platform (free tier)';
const credit = Number(process.env.PLATFORM_ORG_CREDIT_MICROS ?? 50_000_000);
const fixedId = process.env.PLATFORM_ORG_ID;
const [existing] = fixedId
  ? []
  : await handle.db.select().from(coreSchema.orgs).where(eq(coreSchema.orgs.name, name));
const org = fixedId
  ? await core.ensureOrg(fixedId, name, credit)
  : (existing ?? (await core.createOrg(name, credit)));
process.stdout.write(`${org.id}\n`);
await handle.close();
