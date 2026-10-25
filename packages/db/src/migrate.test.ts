import { afterEach, describe, expect, it } from 'vitest';
import { createDb, type DbHandle, migrate } from './index';

let handle: DbHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe('migrate', () => {
  it('applies migrations once and is idempotent', async () => {
    handle = await createDb('memory://');
    const migrations = [
      { id: '0001_init', sql: 'CREATE TABLE demo.items (id text primary key, n int not null default 0);' },
      {
        id: '0002_more',
        sql: "ALTER TABLE demo.items ADD COLUMN label text; INSERT INTO demo.items (id, label) VALUES ('a', 'it''s; fine');",
      },
    ];
    expect(await migrate(handle, 'demo', migrations)).toEqual(['0001_init', '0002_more']);
    expect(await migrate(handle, 'demo', migrations)).toEqual([]);
    const rows = await handle.query<{ label: string }>('SELECT label FROM demo.items');
    expect(rows[0]?.label).toBe("it's; fine");
  });

  it('rolls back a failing migration', async () => {
    handle = await createDb('memory://');
    await expect(
      migrate(handle, 'demo2', [
        { id: '0001_bad', sql: 'CREATE TABLE demo2.t (id int); SELECT * FROM nope;' },
      ]),
    ).rejects.toThrow();
    const rows = await handle.query("SELECT to_regclass('demo2.t') AS t");
    expect(rows[0]).toEqual({ t: null });
  });
});
