import type { DbHandle } from '@ok/db';
import { AppError, newId } from '@ok/shared';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { kbChunks, kbDocuments } from '../db/schema';
import { chunkText, detectKind, extractText, normalizeVi } from '../lib/text';
import type { Clock } from '../lib/time';

export interface KnowledgeHit {
  chunkId: string;
  documentId: string;
  title: string;
  source: string | null;
  ordinal: number;
  content: string;
  score: number;
}

const MAX_DOCUMENT_CHARS = 2_000_000;
const MAX_QUERY_TERMS = 16;

/**
 * Very common Vietnamese/English function words (diacritics stripped). Kept
 * deliberately short: many syllables are ambiguous without diacritics
 * (ban = bạn/bán, ma = mà/mã, vay = vậy/váy), so those stay searchable.
 */
const STOPWORDS = new Set([
  'la',
  'cua',
  'va',
  'cac',
  'nhung',
  'cho',
  'voi',
  'thi',
  'nao',
  'gi',
  'duoc',
  'minh',
  'oi',
  'nhe',
  'nha',
  'khong',
  'is',
  'are',
  'of',
  'to',
  'in',
  'and',
  'or',
  'for',
  'what',
  'how',
  'do',
  'does',
  'you',
  'me',
  'my',
]);

/** Search terms of a query: words of 2+ chars (or digits), stop words removed, deduplicated. */
export function queryTerms(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 || /^\d+$/.test(w));
  const unique = [...new Set(words)];
  const filtered = unique.filter((w) => !STOPWORDS.has(normalizeVi(w)));
  return (filtered.length ? filtered : unique).slice(0, MAX_QUERY_TERMS);
}

/**
 * Knowledge base: documents are chunked (~800 tokens, overlapping) and stored
 * in Postgres with two `tsvector` columns using the dictionary-free `simple`
 * config — one over the original text, one over a diacritics-stripped copy —
 * so "chinh sach doi tra" finds "Chính sách đổi trả". Matching uses the
 * normalised column (OR of terms, ranked by cover density); exact-diacritic
 * matches get a ranking bonus.
 */
export class KnowledgeService {
  constructor(
    private readonly handle: DbHandle,
    private readonly clock: Clock,
  ) {}

  private get db() {
    return this.handle.db;
  }

  async addDocument(input: {
    orgId: string;
    agentId: string | null;
    title?: string;
    filename?: string;
    mimeType?: string;
    content: string;
  }) {
    const kind = detectKind(input.filename, input.mimeType);
    if (!kind)
      throw new AppError(
        'bad_request',
        'Unsupported file type. Upload .txt, .md, .csv or .html (plain text).',
      );
    if (input.content.length > MAX_DOCUMENT_CHARS)
      throw new AppError(
        'bad_request',
        `Document too large (max ${MAX_DOCUMENT_CHARS.toLocaleString()} characters)`,
      );
    if (input.content.includes('\u0000'))
      throw new AppError('bad_request', 'Binary files are not supported; upload plain text');
    const text = extractText(input.content, kind);
    if (!text.trim()) throw new AppError('bad_request', 'Document has no text content');
    const chunks = chunkText(text);
    const mimeType = { text: 'text/plain', markdown: 'text/markdown', csv: 'text/csv', html: 'text/html' }[
      kind
    ];
    const title =
      (input.title || input.filename || text.split('\n', 1)[0]!.replace(/^#+\s*/, '')).slice(0, 200) ||
      'Untitled';
    const docId = newId('doc');
    await this.db.transaction(async (tx) => {
      await tx.insert(kbDocuments).values({
        id: docId,
        orgId: input.orgId,
        agentId: input.agentId,
        title,
        source: input.filename ?? null,
        mimeType,
        chars: text.length,
        chunkCount: chunks.length,
        createdAt: this.clock.now(),
      });
      for (let i = 0; i < chunks.length; i += 100) {
        await tx.insert(kbChunks).values(
          chunks.slice(i, i + 100).map((c) => ({
            id: newId('chk'),
            documentId: docId,
            orgId: input.orgId,
            agentId: input.agentId,
            ordinal: c.ordinal,
            content: c.content,
            contentNormalized: normalizeVi(c.content),
            tokens: c.tokens,
          })),
        );
      }
    });
    return {
      id: docId,
      title,
      source: input.filename ?? null,
      mimeType,
      chars: text.length,
      chunkCount: chunks.length,
      agentId: input.agentId,
    };
  }

  /** Documents of one agent (`agentId`) or the org-wide ones (`null`). */
  list(orgId: string, agentId: string | null) {
    return this.db
      .select()
      .from(kbDocuments)
      .where(
        and(
          eq(kbDocuments.orgId, orgId),
          agentId ? eq(kbDocuments.agentId, agentId) : isNull(kbDocuments.agentId),
        ),
      )
      .orderBy(desc(kbDocuments.createdAt));
  }

  async getDocument(orgId: string, docId: string) {
    const [doc] = await this.db
      .select()
      .from(kbDocuments)
      .where(and(eq(kbDocuments.orgId, orgId), eq(kbDocuments.id, docId)));
    if (!doc) throw new AppError('not_found', 'Document not found');
    const chunks = await this.db
      .select({ ordinal: kbChunks.ordinal, content: kbChunks.content, tokens: kbChunks.tokens })
      .from(kbChunks)
      .where(eq(kbChunks.documentId, docId))
      .orderBy(kbChunks.ordinal);
    return { ...doc, chunks };
  }

  async delete(orgId: string, docId: string, agentId?: string | null) {
    const conds = [eq(kbDocuments.orgId, orgId), eq(kbDocuments.id, docId)];
    if (agentId !== undefined)
      conds.push(agentId ? eq(kbDocuments.agentId, agentId) : isNull(kbDocuments.agentId));
    const res = await this.db
      .delete(kbDocuments)
      .where(and(...conds))
      .returning({ id: kbDocuments.id });
    if (!res.length) throw new AppError('not_found', 'Document not found');
  }

  /** Top chunks for a query from the agent's documents and the org-wide ones. */
  async search(input: {
    orgId: string;
    agentId: string;
    query: string;
    limit?: number;
  }): Promise<KnowledgeHit[]> {
    const normTerms = [...new Set(queryTerms(input.query).map(normalizeVi))].filter(Boolean);
    if (!normTerms.length) return [];
    const rawTerms = queryTerms(input.query);
    const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
    const rows = await this.handle.query<{
      id: string;
      document_id: string;
      ordinal: number;
      content: string;
      title: string;
      source: string | null;
      score: number;
    }>(
      `WITH q AS (SELECT to_tsquery('simple', $3) AS qn, to_tsquery('simple', $4) AS qr)
       SELECT c.id, c.document_id, c.ordinal, c.content, d.title, d.source,
              (ts_rank_cd(c.tsv_normalized, q.qn, 1) + 0.5 * ts_rank_cd(c.tsv, q.qr, 1))::float8 AS score
         FROM agents.kb_chunks c
         JOIN agents.kb_documents d ON d.id = c.document_id
         CROSS JOIN q
        WHERE c.org_id = $1
          AND (c.agent_id = $2 OR c.agent_id IS NULL)
          AND c.tsv_normalized @@ q.qn
        ORDER BY score DESC, c.ordinal ASC
        LIMIT $5`,
      [input.orgId, input.agentId, normTerms.join(' | '), rawTerms.join(' | '), limit],
    );
    return rows.map((r) => ({
      chunkId: r.id,
      documentId: r.document_id,
      title: r.title,
      source: r.source,
      ordinal: r.ordinal,
      content: r.content,
      score: Number(r.score),
    }));
  }

  /** Whether the agent has any knowledge (used to tailor tool guidance). */
  async hasDocuments(orgId: string, agentId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: kbDocuments.id })
      .from(kbDocuments)
      .where(
        and(eq(kbDocuments.orgId, orgId), or(eq(kbDocuments.agentId, agentId), isNull(kbDocuments.agentId))),
      )
      .limit(1);
    return rows.length > 0;
  }
}
