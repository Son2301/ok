import { createDb } from '@minh/db';
import { describe, expect, it } from 'vitest';
import { migrateAgents } from './migrations';

describe('agents migrations', () => {
  it('apply cleanly and idempotently, with generated full-text columns', async () => {
    const db = await createDb('memory://');
    try {
      expect(await migrateAgents(db)).toEqual(['0001_init']);
      expect(await migrateAgents(db)).toEqual([]);
      await db.query(
        `INSERT INTO agents.kb_documents (id, org_id, title, mime_type, chars, chunk_count) VALUES ('d1', 'o1', 't', 'text/plain', 1, 1)`,
      );
      await db.query(
        `INSERT INTO agents.kb_chunks (id, document_id, org_id, ordinal, content, content_normalized, tokens) VALUES ('c1', 'd1', 'o1', 0, 'Đổi trả miễn phí', 'doi tra mien phi', 4)`,
      );
      const rows = await db.query<{ hit: boolean }>(
        `SELECT tsv_normalized @@ to_tsquery('simple', 'doi & tra') AS hit FROM agents.kb_chunks WHERE id = 'c1'`,
      );
      expect(rows[0]?.hit).toBe(true);
    } finally {
      await db.close();
    }
  });
});
