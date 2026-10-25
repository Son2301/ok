import { AppError } from '@ok/shared';
import { z } from 'zod';
import { type LlmClient, responseText } from './client';
import type { ChatMessage, ChatRequest, Usage } from './types';

/** Extract the first JSON object/array from model output (tolerates ``` fences and prose). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {}
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error('No JSON found in model output');
  const open = candidate[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return JSON.parse(candidate.slice(start, i + 1));
  }
  throw new Error('Unterminated JSON in model output');
}

/**
 * Ask for JSON and validate it with zod. On a parse/validation failure the
 * error is fed back to the model once (configurable) so it can correct itself.
 */
export async function chatJson<S extends z.ZodType>(
  client: LlmClient,
  req: Omit<ChatRequest, 'response_format' | 'stream'>,
  schema: S,
  opts: { retries?: number; signal?: AbortSignal } = {},
): Promise<{ data: z.infer<S>; usage: Usage; raw: string }> {
  const retries = opts.retries ?? 1;
  const messages: ChatMessage[] = [...req.messages];
  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_micros: 0 };
  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await client.chat(
      { ...req, messages, response_format: { type: 'json_object' } },
      { signal: opts.signal },
    );
    if (res.usage) {
      usage.prompt_tokens += res.usage.prompt_tokens;
      usage.completion_tokens += res.usage.completion_tokens;
      usage.total_tokens += res.usage.total_tokens;
      usage.cost_micros = (usage.cost_micros ?? 0) + (res.usage.cost_micros ?? 0);
    }
    const raw = responseText(res);
    try {
      const data = schema.parse(extractJson(raw));
      return { data, usage, raw };
    } catch (err) {
      lastError = err instanceof z.ZodError ? JSON.stringify(err.issues.slice(0, 5)) : (err as Error).message;
      messages.push({ role: 'assistant', content: raw });
      messages.push({
        role: 'user',
        content: `Your previous reply was not valid JSON for the required schema: ${lastError}. Reply again with ONLY the corrected JSON.`,
      });
    }
  }
  throw new AppError('upstream_error', `Model did not return valid JSON: ${lastError}`);
}
