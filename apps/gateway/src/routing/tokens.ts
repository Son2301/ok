import type { ChatCompletionRequest, ChatMessage } from '../schemas';

/** Rough, tokenizer-free estimate used when an upstream reports no usage, and for routing. */
export const CHARS_PER_TOKEN = 4;
/** Per-message framing overhead (role markers etc.). */
const MESSAGE_OVERHEAD = 4;
/** Typical cost of one image at "auto/high" detail (OpenAI's 512px-tile model); 85 at low detail. */
const IMAGE_TOKENS = { low: 85, high: 765 } as const;

export function estimateTextTokens(text: string): number {
  return text ? Math.ceil(text.length / CHARS_PER_TOKEN) : 0;
}

/** Text of a message: string content, text parts, and tool call names/arguments. */
export function messageText(m: Pick<ChatMessage, 'content' | 'tool_calls'>): string {
  let out = '';
  if (typeof m.content === 'string') out = m.content;
  else if (Array.isArray(m.content)) out = m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  for (const tc of m.tool_calls ?? []) out += `\n${tc.function.name}(${tc.function.arguments})`;
  return out;
}

export function countImages(messages: ChatMessage[]): { low: number; high: number } {
  const n = { low: 0, high: 0 };
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content) if (p.type === 'image_url') n[p.image_url.detail === 'low' ? 'low' : 'high']++;
  }
  return n;
}

/** Estimated prompt tokens for a chat request (messages, images and tool schemas). */
export function estimatePromptTokens(req: Pick<ChatCompletionRequest, 'messages' | 'tools'>): number {
  let tokens = 0;
  for (const m of req.messages) tokens += estimateTextTokens(messageText(m)) + MESSAGE_OVERHEAD;
  const imgs = countImages(req.messages);
  tokens += imgs.low * IMAGE_TOKENS.low + imgs.high * IMAGE_TOKENS.high;
  if (req.tools?.length) tokens += estimateTextTokens(JSON.stringify(req.tools));
  return tokens;
}
