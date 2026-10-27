import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadEnv } from './env';

describe('loadEnv', () => {
  const schema = z.object({ PORT: z.coerce.number().default(4000), API_KEY: z.string().min(1).optional() });

  it('treats empty values as unset so `KEY=` in .env falls back to defaults', () => {
    expect(loadEnv(schema, { PORT: '', API_KEY: '' })).toEqual({ PORT: 4000 });
  });

  it('reports every invalid field', () => {
    expect(() => loadEnv(schema, { PORT: 'abc' })).toThrow(/PORT/);
  });
});
