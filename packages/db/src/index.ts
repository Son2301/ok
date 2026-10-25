import { PGlite } from '@electric-sql/pglite';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import pg from 'pg';

// biome-ignore lint/suspicious/noExplicitAny: schema-agnostic handle shared by every service
export type Db = PgDatabase<PgQueryResultHKT, any>;

export interface DbHandle {
  db: Db;
  /** Run raw (possibly multi-statement) SQL inside a single transaction. */
  execInTransaction(sql: string): Promise<void>;
  /** Run a parameterised query and return rows (used by the migrator). */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
  driver: 'pg' | 'pglite';
}

/**
 * Create a database handle from a URL.
 *   postgres://… / postgresql://…  → node-postgres pool (production)
 *   memory://                        → in-process PGlite (tests, zero-setup dev)
 *   pglite:///path/to/dir            → on-disk PGlite
 */
export async function createDb(url: string = process.env.DATABASE_URL ?? 'memory://'): Promise<DbHandle> {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const pool = new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 10) });
    return {
      driver: 'pg',
      db: drizzlePg(pool) as unknown as Db,
      async execInTransaction(sql) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
      async query(sql, params = []) {
        const res = await pool.query(sql, params);
        return res.rows;
      },
      close: () => pool.end(),
    };
  }

  const dataDir = url === 'memory://' || url === '' ? undefined : url.replace(/^pglite:\/\//, '');
  const client = new PGlite(dataDir);
  await client.waitReady;
  return {
    driver: 'pglite',
    db: drizzlePglite(client) as unknown as Db,
    async execInTransaction(sql) {
      await client.transaction(async (tx) => {
        await tx.exec(sql);
      });
    },
    async query(sql, params = []) {
      const res = await client.query(sql, params);
      return res.rows as never;
    },
    close: () => client.close(),
  };
}

export interface Migration {
  /** Stable, ordered identifier, e.g. `0001_init`. Never rename once shipped. */
  id: string;
  sql: string;
}

/**
 * Apply pending migrations for one Postgres schema. Each service owns a schema
 * (core, gateway, agents, safe, review) and tracks its own migrations, so
 * services can be deployed independently against one database.
 */
export async function migrate(handle: DbHandle, schema: string, migrations: Migration[]): Promise<string[]> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`Invalid schema name: ${schema}`);
  const ids = migrations.map((m) => m.id);
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate migration ids in ${schema}`);

  await handle.execInTransaction(
    `CREATE SCHEMA IF NOT EXISTS ${schema};
     CREATE TABLE IF NOT EXISTS ${schema}._migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());`,
  );
  const applied = new Set((await handle.query<{ id: string }>(`SELECT id FROM ${schema}._migrations`)).map((r) => r.id));
  const ran: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    const escapedId = m.id.replace(/'/g, "''");
    // The advisory lock + ON CONFLICT make concurrent boots of several replicas safe.
    await handle.execInTransaction(
      `SELECT pg_advisory_xact_lock(hashtext('${schema}'));
       DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM ${schema}._migrations WHERE id = '${escapedId}') THEN
           EXECUTE ${dollarQuote(m.sql)};
           INSERT INTO ${schema}._migrations (id) VALUES ('${escapedId}');
         END IF;
       END $$;`,
    );
    ran.push(m.id);
  }
  return ran;
}

function dollarQuote(s: string): string {
  let tag = 'mig';
  while (s.includes(`$${tag}$`)) tag += 'x';
  return `$${tag}$${s}$${tag}$`;
}

export { sql } from 'drizzle-orm';
