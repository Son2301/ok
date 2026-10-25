/** Copy-paste snippets with the customer's real base URL and a placeholder key. */

export const KEY_PLACEHOLDER = 'sk-ok-…';

export function gatewayCurl(baseUrl: string, key = KEY_PLACEHOLDER): string {
  return [
    `curl ${baseUrl}/v1/chat/completions \\`,
    `  -H "Authorization: Bearer ${key}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"model":"auto","messages":[{"role":"user","content":"Xin chào!"}]}'`,
  ].join('\n');
}

export function openaiSdkSnippet(baseUrl: string, key = KEY_PLACEHOLDER): string {
  return [
    `import OpenAI from 'openai';`,
    ``,
    `const client = new OpenAI({ baseURL: '${baseUrl}/v1', apiKey: '${key}' });`,
    `const res = await client.chat.completions.create({`,
    `  model: 'auto',`,
    `  messages: [{ role: 'user', content: 'Xin chào!' }],`,
    `});`,
    `console.log(res.choices[0].message.content, res.usage);`,
  ].join('\n');
}

export function safeCurl(baseUrl: string, key = KEY_PLACEHOLDER): string {
  return [
    `curl ${baseUrl}/v1/check/url \\`,
    `  -H "Authorization: Bearer ${key}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"url":"vcb-digibank.top/login"}'`,
  ].join('\n');
}
