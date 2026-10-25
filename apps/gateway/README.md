# AI Gateway (`@ok/gateway`, port 4000)

One OpenAI-compatible API in front of many model providers (OpenAI, Azure OpenAI, Anthropic,
Google Gemini, DeepSeek, Groq, Together, Fireworks, OpenRouter, Alibaba DashScope, BytePlus
ModelArk, xAI, Mistral, plus any OpenAI-compatible server). It adds:

- **Routing** across provider endpoints by price × health, or by `latency` / `throughput` /
  `uptime`, with OpenRouter-style `provider` preferences (`order`, `only`, `ignore`,
  `allow_fallbacks`, `sort`).
- **`model: "auto"`** — a deterministic classifier (no extra LLM call) that picks a tier
  (`fast` / `balanced` / `frontier` / `reasoning`) and a concrete enabled model.
- **Fallback** on retryable errors (429, 5xx, timeouts, connection errors) across endpoints and
  across the `models[]` list — always _before_ the first byte reaches the client.
- **Health tracking + circuit breakers** per endpoint (success rate, p50/p95 latency and TTFT,
  tokens/sec).
- **Billing**: exact cost from usage, debited from the shared wallet (`core.debit`); every
  request is logged to `gateway.requests` (never the prompt or completion text).

With **no provider credentials configured, every model resolves to an in-process mock provider**,
so the whole platform (and the other products that call the gateway) works offline.

---

## Quick start (offline)

```bash
pnpm install
pnpm --filter @ok/gateway dev                      # tsx watch, DATABASE_URL defaults to memory://
# or the production bundle:
pnpm --filter @ok/gateway build
cd apps/gateway && DATABASE_URL=memory:// PORT=4999 node dist/index.js
```

In development with an in-memory database the server seeds a funded org ($10) and prints a key:

```
  DEV API KEY: sk-ok-…
```

```bash
export KEY=sk-ok-…            # from the boot log
export GW=http://localhost:4999
curl -s $GW/health
curl -s $GW/v1/chat/completions -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"mock/echo","messages":[{"role":"user","content":"hello"}]}'
```

For a persistent database (Postgres or an on-disk PGlite directory) create a dev key with
`DATABASE_URL=postgres://… pnpm --filter @ok/gateway seed`.

---

## How a request flows

```
auth (API key or INTERNAL_TOKEN + X-Org-Id)
  → validate body (zod)                     → 400
  → wallet balance > 0 ?                    → 402
  → plan: model + models[] (auto → classifier → tier → models)
          × endpoints (enabled, provider prefs, capabilities, context window, circuit state)
          ordered by provider.order, then sort / default price×health weighting
  → attempts: try endpoint 1, 2, … (retryable error → next; 400-class → stop)
        streaming: buffer upstream chunks until the first meaningful one, then commit
  → usage (upstream-reported, else ~chars/4 flagged `estimated`) → cost
  → core.debit(org, cost, { product, apiKeyId, ref: generation id, force: true })
  → insert gateway.requests row (tokens, cost, upstream cost, latency, ttft, attempts, routing)
```

### Routing details

- **Capabilities are inferred from the request**: `tools` (or tool-call history) → tool support,
  `image_url` parts → vision, `response_format` json → JSON mode, `stream` → streaming. The
  estimated prompt (~chars/4, images ≈ 765 tokens) + `max_tokens` must fit the endpoint's context
  window, and `max_tokens` must not exceed the endpoint's output limit.
- **Default order (no `sort`)**: endpoints without recent trouble are sampled without replacement
  with weight ∝ 1/price² (expected cost of _this_ request), like OpenRouter; degraded endpoints
  (success rate < 80 % over ≥ 5 samples, or ≥ 2 consecutive failures) follow, cheapest first;
  endpoints with an open circuit or an active `Retry-After` block are skipped.
- `sort: "price"` — cheapest expected cost first. `"latency"` — lowest observed p50 TTFT (p50 latency
  for non-streamed traffic). `"throughput"` — highest p50 tokens/sec. `"uptime"` — highest success
  rate. Endpoints with no data yet go last, cheapest first.
- `order: [...]` puts those providers first (in that order); `allow_fallbacks: false` then keeps
  _only_ them (or only the top choice when no `order` is given). `only` / `ignore` filter by provider
  id (`openai`, `azure`, `groq`, …) or full endpoint id (`openai/gpt-4o@azure`).

### `auto` smart router

`model: "auto" | "auto:cheap" | "auto:best"` runs a lexical classifier over the system prompt and
the latest user message (plus whole-conversation size):

| Signal                | Examples                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------- |
| prompt length         | > 1.5k tokens → balanced, > 24k → frontier                                               |
| code                  | fenced blocks, code syntax (`def f(`, `const x =`, stack traces), "refactor", "viết hàm" |
| math / reasoning      | "prove", "theorem", "chứng minh", LaTeX, integrals, "step by step"                       |
| complexity            | "architecture", "trade-offs", "analyze", "phân tích", "so sánh"                          |
| tools / images / JSON | request fields                                                                           |
| Vietnamese            | Vietnamese-only letters (U+1EA0–1EF9, ă đ ơ ư) ≥ 2 % of letters                          |

Tier → candidates: enabled chat models tagged with that tier in the catalog that satisfy the
request's hard requirements, ranked by catalog `quality` + a bonus for matching strengths (`code`,
`math`, `multilingual` for Vietnamese, `vision`, `tools`, `long_context`). `auto:cheap` moves one
tier down and ranks by price; `auto:best` moves one tier up. The top 3 become the fallback chain;
if a tier has no enabled model, neighbouring tiers are used and the reason says so. The response
carries `routing: { variant, tier, model, reason }`, e.g.
`"balanced: code, Vietnamese → anthropic/claude-haiku-5.5"`.

### Fallback & failure semantics

| Upstream outcome                                                          | Retry next endpoint/model?                                                                     | Counts against endpoint health? |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------- |
| 429 (honours `Retry-After`, capped at 60 s)                               | yes                                                                                            | yes                             |
| 408, 5xx (incl. Anthropic 529), timeout, connection error, malformed JSON | yes                                                                                            | yes                             |
| 401 / 403 / 404 from the upstream                                         | yes — _our_ credential/slug is wrong for that provider, another provider may serve the request | yes                             |
| other 4xx (400, 413, 422, …)                                              | **no** — returned to the caller as-is                                                          | no                              |
| client disconnected                                                       | no (upstream call is aborted)                                                                  | no                              |
- **Streaming**: chunks are buffered until the first _meaningful_ chunk (content, tool call,
  reasoning, finish reason or usage). Any failure before that falls back transparently. After it,
  a mid-stream upstream failure produces an SSE chunk with `finish_reason: "error"` and an
  `error: { code: "upstream_error", message }` field, then the usage chunk and `data: [DONE]`; the
  partial output is billed (estimated) and the request is logged as `partial`.
- **Timeouts**: non-streaming calls get `UPSTREAM_TIMEOUT_MS`. Streams get `FIRST_BYTE_TIMEOUT_MS`
  for the first upstream event, then `STREAM_IDLE_TIMEOUT_MS` between events. Anthropic `ping` /
  thinking events and Gemini thought parts count as activity (internal heartbeats, never forwarded),
  so long reasoning phases don't trip the timeout.
- **Circuit breaker**: `CIRCUIT_FAILURE_THRESHOLD` consecutive endpoint failures open the circuit;
  after `CIRCUIT_COOLDOWN_MS` one half-open probe is allowed; success closes it, failure re-opens.
- At most `MAX_ATTEMPTS` endpoint attempts per request across all models.

### Billing

- Cost = `ceil(prompt_tokens × price.input) + ceil(completion_tokens × price.output)` micro-USD
  (prices are USD per 1M tokens). `upstream_cost_micros` (from the endpoint's `cost`) is stored for
  margin analytics and **never returned to customers**.
- If the upstream reports no usage, tokens are estimated (~4 chars/token) and `usage.estimated: true`.
- Usage is post-paid: the gateway requires a positive balance before calling upstream, then debits
  with `force: true` (the balance may go slightly negative on the last request).
- `product` is `gateway`, unless the caller used the internal token and sent a valid
  `X-OK-Product` (`agents`, `safe`, `review`) — that is how other products bill their LLM usage.

---

## Configuration

All variables are optional. Provider endpoints are routable only when their credentials exist.

| Variable                                | Default                | Purpose                                                                                                                   |
| --------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                  | `4000`                 | HTTP port                                                                                                                 |
| `DATABASE_URL`                          | `memory://`            | `postgres://…`, `memory://` (PGlite) or `pglite:///dir`                                                                   |
| `INTERNAL_TOKEN`                        | dev value              | Shared secret for platform-internal calls (must be changed in production — boot fails otherwise)                          |
| `NODE_ENV` / `LOG_LEVEL`                | `development` / `info` |                                                                                                                           |
| `CATALOG_PATH`                          | –                      | JSON file overriding/extending the model catalog (see below)                                                              |
| `MOCK_PROVIDER`                         | `auto`                 | `auto`: mock endpoints only when no real credentials; `always`: add mock endpoints to every model; `never`                |
| `MOCK_LATENCY_MS` / `MOCK_FAILURE_RATE` | `0` / `0`              | Mock provider latency and failure probability (0–1)                                                                       |
| `MAX_ATTEMPTS`                          | `6`                    | Max endpoint attempts per request                                                                                         |
| `UPSTREAM_TIMEOUT_MS`                   | `300000`               | Non-streaming upstream timeout                                                                                            |
| `FIRST_BYTE_TIMEOUT_MS`                 | `120000`               | Streaming: wait for the first upstream event                                                                              |
| `STREAM_IDLE_TIMEOUT_MS`                | `120000`               | Streaming: max silence between upstream events                                                                            |
| `CIRCUIT_FAILURE_THRESHOLD`             | `5`                    | Consecutive failures that open a circuit                                                                                  |
| `CIRCUIT_COOLDOWN_MS`                   | `30000`                | Open-circuit cooldown before a half-open probe                                                                            |
| `HEALTH_WINDOW_MS`                      | `300000`               | Rolling window for health statistics                                                                                      |
| `MAX_BODY_BYTES`                        | `20971520`             | Request body limit (base64 images!)                                                                                       |
| `ANTHROPIC_DEFAULT_MAX_TOKENS`          | `16000`                | `max_tokens` sent to Anthropic when the caller sets none (capped by the model's limit)                                    |
| `DEV_SEED_API_KEY`                      | –                      | `1`: seed an org + key on boot (development only); `0`: never. Default: seed when `DATABASE_URL=memory://` in development |
| `DEV_SEED_CREDIT_USD`                   | `10`                   | Credit for the seeded org                                                                                                 |

Provider credentials (each provider also accepts `<PROVIDER>_BASE_URL` to point at a proxy or a
regional endpoint, e.g. `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GEMINI_BASE_URL`, `DEEPSEEK_BASE_URL`):

| Provider id  | Adapter                | Credentials                                                                                                                                                                                                       | Default base URL                                         |
| ------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `openai`     | openai-compatible      | `OPENAI_API_KEY`                                                                                                                                                                                                  | `https://api.openai.com/v1`                              |
| `azure`      | azure-openai           | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` (`https://<res>.openai.azure.com`), optional `AZURE_OPENAI_API_VERSION` (default `2024-10-21`), `AZURE_OPENAI_DEPLOYMENTS` (`{"openai/gpt-4o":"my-deployment"}`) | –                                                        |
| `anthropic`  | anthropic              | `ANTHROPIC_API_KEY`, optional `ANTHROPIC_VERSION` (default `2023-06-01`)                                                                                                                                          | `https://api.anthropic.com`                              |
| `google`     | google (native Gemini) | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`)                                                                                                                                                                            | `https://generativelanguage.googleapis.com/v1beta`       |
| `deepseek`   | openai-compatible      | `DEEPSEEK_API_KEY`                                                                                                                                                                                                | `https://api.deepseek.com/v1`                            |
| `groq`       | openai-compatible      | `GROQ_API_KEY`                                                                                                                                                                                                    | `https://api.groq.com/openai/v1`                         |
| `together`   | openai-compatible      | `TOGETHER_API_KEY`                                                                                                                                                                                                | `https://api.together.xyz/v1`                            |
| `fireworks`  | openai-compatible      | `FIREWORKS_API_KEY`                                                                                                                                                                                               | `https://api.fireworks.ai/inference/v1`                  |
| `openrouter` | openai-compatible      | `OPENROUTER_API_KEY`                                                                                                                                                                                              | `https://openrouter.ai/api/v1`                           |
| `dashscope`  | openai-compatible      | `DASHSCOPE_API_KEY`                                                                                                                                                                                               | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| `byteplus`   | openai-compatible      | `BYTEPLUS_API_KEY` (or `ARK_API_KEY`)                                                                                                                                                                             | `https://ark.ap-southeast.bytepluses.com/api/v3`         |
| `xai`        | openai-compatible      | `XAI_API_KEY`                                                                                                                                                                                                     | `https://api.x.ai/v1`                                    |
| `mistral`    | openai-compatible      | `MISTRAL_API_KEY`                                                                                                                                                                                                 | `https://api.mistral.ai/v1`                              |
| `mock`       | mock                   | always on                                                                                                                                                                                                         | in-process                                               |

---

## API reference

All `/v1/*` routes except `GET /v1/models` require auth:

- `Authorization: Bearer sk-ok-…` — a customer API key whose scopes include `gateway` (or `*`), or
- `Authorization: Bearer $INTERNAL_TOKEN` + `X-Org-Id: org_…` (+ optional `X-OK-Product`) for
  platform services. `X-API-Key` is accepted as an alternative header.

Errors use the platform envelope `{ "error": { "code", "message", "details"? } }`.

| Status    | `code`                       | When                                                                                                                                        |
| --------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 400       | `bad_request`                | invalid body, upstream rejected the request (message included), no endpoint satisfies the requirements (`details.routing.skipped` says why) |
| 401 / 403 | `unauthorized` / `forbidden` | missing/invalid key / key not scoped to gateway                                                                                             |
| 402       | `payment_required`           | wallet balance ≤ 0 or key spend limit reached                                                                                               |
| 404       | `not_found`                  | unknown model / generation                                                                                                                  |
| 413       | `bad_request`                | body larger than `MAX_BODY_BYTES`                                                                                                           |
| 429       | `rate_limited`               | key RPM limit, or every provider rate-limited us                                                                                            |
| 502       | `upstream_error`             | all attempts failed (`details.attempts` lists each one)                                                                                     |
| 503       | `upstream_error`             | no provider configured for the model / every endpoint's circuit is open                                                                     |
| 504       | `timeout`                    | every attempt timed out                                                                                                                     |

Successful chat/embedding responses carry `x-generation-id`, `x-gateway-model` and
`x-gateway-provider`; failed ones include `details.generation_id`. Every response has `x-request-id`.

### `GET /health`

```bash
curl -s $GW/health
# {"status":"ok","service":"gateway","mock_fallback":true,"providers_enabled":[]}
```

### `GET /v1/models` (public)

```bash
curl -s "$GW/v1/models"                       # available chat + embedding models, plus auto variants
curl -s "$GW/v1/models?type=embedding"
curl -s "$GW/v1/models?include_disabled=true" # also models whose providers have no credentials
```

```json
{
  "object": "list",
  "data": [
    { "id": "auto", "object": "model", "name": "Auto router", "type": "chat", "pricing": null, "…": "…" },
    {
      "id": "openai/gpt-4o-mini",
      "object": "model",
      "name": "GPT-4o mini",
      "type": "chat",
      "owned_by": "openai",
      "context_length": 128000,
      "pricing": { "prompt": 0.1575, "completion": 0.63, "unit": "USD per 1M tokens" },
      "capabilities": { "tools": true, "vision": true, "json": true, "streaming": true },
      "available": true,
      "tiers": ["fast"],
      "providers": [
        {
          "provider": "openai",
          "context_length": 128000,
          "max_output_tokens": 16384,
          "pricing": { "prompt": 0.1575, "completion": 0.63 },
          "capabilities": { "…": "…" },
          "enabled": true,
          "verified": false
        }
      ]
    }
  ]
}
```

Model ids are `vendor/model`; bare names (`gpt-4o-mini`) and catalog aliases (`claude-sonnet-4-6`)
resolve too.

### `POST /v1/chat/completions`

OpenAI Chat Completions: `messages` (text, `image_url` parts, tool calls/results), `tools`,
`tool_choice`, `response_format` (`json_object` / `json_schema`), `temperature`, `top_p`,
`max_tokens` / `max_completion_tokens`, `stop`, `stream`, `stream_options`, `user`, and any other
OpenAI parameter (passed through untouched to OpenAI-compatible upstreams). `n > 1` is rejected.

Gateway extensions: `models: string[]` (fallback models), `provider: { order, only, ignore,
allow_fallbacks, sort }`, `model: "auto" | "auto:cheap" | "auto:best"`. `metadata` is accepted but
neither forwarded nor stored.

**Basic**

```bash
curl -s $GW/v1/chat/completions -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "model": "openai/gpt-4o-mini",
  "messages": [{"role":"system","content":"Be brief."},{"role":"user","content":"Capital of Vietnam?"}]
}'
```

```json
{
  "id": "gen_k3j…",
  "object": "chat.completion",
  "created": 1792951126,
  "model": "openai/gpt-4o-mini",
  "provider": "openai",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "Hanoi." }, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 21, "completion_tokens": 3, "total_tokens": 24, "cost_micros": 6 }
}
```

`usage.cost_micros` is what this call cost the caller (micro-USD); `usage.estimated: true` appears
when the upstream reported no usage.

**Streaming** (SSE `data: {...}\n\n`, terminated by `data: [DONE]`)

```bash
curl -N $GW/v1/chat/completions -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "model": "anthropic/claude-sonnet-4.6", "stream": true,
  "messages": [{"role":"user","content":"Write a haiku about Hội An"}]
}'
```

```
data: {"id":"gen_…","object":"chat.completion.chunk","model":"anthropic/claude-sonnet-4.6","provider":"anthropic","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}
data: {"id":"gen_…","object":"chat.completion.chunk",…,"choices":[{"index":0,"delta":{"content":"Lanterns"},"finish_reason":null}]}
…
data: {"id":"gen_…","object":"chat.completion.chunk",…,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
data: {"id":"gen_…","object":"chat.completion.chunk",…,"choices":[],"usage":{"prompt_tokens":14,"completion_tokens":19,"total_tokens":33,"cost_micros":338}}
data: [DONE]
```

The final usage chunk is sent unless `stream_options.include_usage` is explicitly `false`; cost is
computed and billed either way.

**Provider preferences**

```bash
# Prefer Azure, then OpenAI; nothing else.
curl -s $GW/v1/chat/completions -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "model": "openai/gpt-4o",
  "provider": { "order": ["azure", "openai"], "allow_fallbacks": false },
  "messages": [{"role":"user","content":"hi"}]
}'

# Fastest observed time-to-first-token among endpoints that are not Together.
curl -s $GW/v1/chat/completions -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "model": "meta-llama/llama-3.3-70b-instruct",
  "provider": { "sort": "latency", "ignore": ["together"] },
  "messages": [{"role":"user","content":"hi"}]
}'
```

**Model fallbacks**

```bash
curl -s $GW/v1/chat/completions -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "model": "anthropic/claude-sonnet-4.6",
  "models": ["openai/gpt-4.1", "google/gemini-2.5-pro"],
  "messages": [{"role":"user","content":"Summarize the CAP theorem."}]
}'
```

Every endpoint of the first model is tried, then the next model's, on retryable errors only.
`GET /v1/generation/:id` shows each attempt.

**Auto routing**

```bash
curl -s $GW/v1/chat/completions -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "model": "auto",
  "messages": [{"role":"user","content":"Chứng minh rằng √2 là số vô tỉ."}]
}'
# … "model": "anthropic/claude-opus-5.5",
#     "routing": {"variant":"default","tier":"reasoning","model":"anthropic/claude-opus-5.5",
#                 "reason":"reasoning: math/reasoning cues, Vietnamese → anthropic/claude-opus-5.5"}
```

`auto:cheap` / `auto:best` shift one tier down/up. For streams, `routing` is on the final usage chunk.

**Tools, images, JSON**

```bash
curl -s $GW/v1/chat/completions -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "model": "google/gemini-2.5-flash",
  "tools": [{"type":"function","function":{"name":"get_weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],
  "messages": [{"role":"user","content":[
     {"type":"text","text":"What city is this, and what is the weather there?"},
     {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,/9j/4AAQ…"}}]}]
}'

curl -s $GW/v1/chat/completions -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "model": "deepseek/deepseek-chat", "response_format": {"type":"json_object"},
  "messages": [{"role":"user","content":"Three Vietnamese dishes as JSON {\"dishes\": [...]}"}]
}'
```

**Platform-internal call** (how Agents / Safe / Review bill usage to their product)

```bash
curl -s $GW/v1/chat/completions -H "authorization: Bearer $INTERNAL_TOKEN" \
  -H "x-org-id: org_…" -H "x-ok-product: agents" -H 'content-type: application/json' \
  -d '{"model":"auto:cheap","messages":[{"role":"user","content":"hi"}]}'
```

### `POST /v1/embeddings`

OpenAI-compatible; routed across OpenAI-compatible and Azure endpoints (plus `mock/embed` offline).

```bash
curl -s $GW/v1/embeddings -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"openai/text-embedding-3-small","input":["xin chào","hello"]}'
# {"object":"list","id":"gen_…","model":"openai/text-embedding-3-small","provider":"openai",
#  "data":[{"object":"embedding","index":0,"embedding":[…]},…],
#  "usage":{"prompt_tokens":6,"total_tokens":6,"cost_micros":1}}
```

### `GET /v1/generation/:id`

Details of a past request of the caller's org (also `GET /v1/generation?id=…`). Rows are written
when a request completes; an in-flight stream returns 404 until it ends.

```bash
curl -s $GW/v1/generation/gen_k3j… -H "authorization: Bearer $KEY"
```

```json
{
  "data": {
    "id": "gen_k3j…",
    "object": "generation",
    "created_at": "2026-10-25T17:58:46.217Z",
    "kind": "chat",
    "product": "gateway",
    "api_key_id": "key_…",
    "requested_model": "auto",
    "model": "openai/gpt-5-mini",
    "provider": "azure",
    "status": "success",
    "error": null,
    "finish_reason": "stop",
    "stream": true,
    "usage": { "prompt_tokens": 812, "completion_tokens": 240, "total_tokens": 1052, "estimated": false },
    "cost_micros": 717,
    "cost_usd": 0.000717,
    "latency_ms": 2140,
    "ttft_ms": 380,
    "attempt_count": 2,
    "fallback_count": 1,
    "attempts": [
      {
        "model": "openai/gpt-5-mini",
        "provider": "openai",
        "endpoint": "openai/gpt-5-mini@openai",
        "upstream_model": "gpt-5-mini",
        "status": "error",
        "error_kind": "rate_limit",
        "http_status": 429,
        "error": "Rate limit reached",
        "latency_ms": 95
      },
      {
        "model": "openai/gpt-5-mini",
        "provider": "azure",
        "endpoint": "openai/gpt-5-mini@azure",
        "upstream_model": "gpt-5-mini",
        "status": "success",
        "latency_ms": 2010,
        "ttft_ms": 290
      }
    ],
    "routing": {
      "requested_model": "auto",
      "models": ["openai/gpt-5-mini", "…"],
      "sort": "default",
      "skipped": [],
      "auto": { "variant": "default", "tier": "balanced", "reason": "balanced: code → openai/gpt-5-mini" }
    }
  }
}
```

Status values: `success`, `error`, `partial` (upstream failed mid-stream), `aborted` (client left).

### `GET /v1/usage?from&to&group_by`

Aggregates for the caller's org. `from` / `to` are `YYYY-MM-DD` (UTC days, `to` inclusive) or
ISO-8601 timestamps; default is the last 30 days; max range 366 days. `group_by` is
`day` (default, zero-filled), `model`, `provider`, `key` (API key id, `internal` for internal
calls) or `product`.

```bash
curl -s "$GW/v1/usage?from=2026-10-01&to=2026-10-25&group_by=model" -H "authorization: Bearer $KEY"
```

```json
{
  "object": "usage",
  "from": "2026-10-01T00:00:00.000Z",
  "to": "2026-10-26T00:00:00.000Z",
  "group_by": "model",
  "data": [
    {
      "key": "openai/gpt-5-mini",
      "requests": 120,
      "errors": 2,
      "prompt_tokens": 91000,
      "completion_tokens": 30500,
      "cost_micros": 84000,
      "avg_latency_ms": 1830,
      "cost_usd": 0.084
    }
  ],
  "totals": {
    "requests": 120,
    "errors": 2,
    "prompt_tokens": 91000,
    "completion_tokens": 30500,
    "cost_micros": 84000,
    "cost_usd": 0.084
  }
}
```

### `GET /v1/requests?limit&cursor`

The org's request log, newest first; `limit` 1–200 (default 50); pass `next_cursor` back as
`cursor`. Optional filters: `status`, `model`.

```bash
curl -s "$GW/v1/requests?limit=20" -H "authorization: Bearer $KEY"
curl -s "$GW/v1/requests?limit=20&cursor=eyJ0Ijoi…" -H "authorization: Bearer $KEY"
```

```json
{
  "object": "list",
  "data": [
    {
      "id": "gen_…",
      "model": "…",
      "status": "success",
      "usage": { "…": "…" },
      "cost_micros": 717,
      "attempt_count": 1,
      "…": "…"
    }
  ],
  "next_cursor": "eyJ0IjoiMjAyNi0xMC0yNVQxNzo1ODo0Ni4yMTdaIiwiaWQiOiJnZW5f…"
}
```

### `GET /v1/providers/health`

Live, per-process health of every enabled endpoint (optional `?provider=openai`).

```bash
curl -s $GW/v1/providers/health -H "authorization: Bearer $KEY"
```

```json
{
  "object": "list",
  "data": [
    {
      "endpoint": "openai/gpt-4o@azure",
      "model": "openai/gpt-4o",
      "provider": "azure",
      "upstream_model": "gpt-4o",
      "verified": false,
      "circuit": "closed",
      "available": true,
      "degraded": false,
      "requests": 214,
      "successes": 212,
      "failures": 2,
      "success_rate": 0.99,
      "p50_latency_ms": 1210,
      "p95_latency_ms": 3900,
      "p50_ttft_ms": 340,
      "p95_ttft_ms": 910,
      "tokens_per_sec": 88.4,
      "consecutive_failures": 0,
      "opened_at": null,
      "blocked_until": null,
      "last_error": { "at": "2026-10-25T17:40:02.000Z", "kind": "rate_limit" },
      "last_success_at": "2026-10-25T17:58:46.000Z"
    }
  ],
  "providers": [
    { "id": "azure", "name": "Azure OpenAI", "kind": "azure-openai", "enabled": true, "verified": false }
  ]
}
```

---

## Catalog

`src/catalog/default.ts` is a typed catalog of ~40 models. Each model maps to provider
**endpoints** `{ provider, upstreamModel, price, cost, contextLength, maxOutputTokens, capabilities,
quirks? }`, where `price` is what we charge and `cost` what the upstream charges us (USD / 1M tokens).
**All prices are placeholders to be verified** (cost from public list prices at the time of writing;
price = cost × 1.05). Models also carry an `auto` profile (`tiers`, `quality`, `strengths`).

`quirks` describe upstream API differences the adapters apply: `dropParams` (e.g. sampling
parameters rejected by OpenAI reasoning models and newer Claude models) and `noForcedToolChoice`
(newer Claude models reject forced tool use; `required` is downgraded to `auto`).

**Overrides** — point `CATALOG_PATH` at a JSON file:

```json
{
  "providers": {
    "vllm": { "kind": "openai-compatible", "baseUrl": "http://vllm:8000/v1", "apiKeyEnv": "VLLM_KEY" }
  },
  "models": [
    {
      "id": "openai/gpt-4o",
      "endpoints": [
        { "provider": "azure", "upstreamModel": "prod-gpt4o", "price": { "input": 2.4, "output": 9.6 } }
      ]
    },
    { "id": "openai/gpt-4o-mini", "endpoints": [{ "provider": "openrouter", "remove": true }] },
    {
      "id": "local/llama-3.1-8b",
      "name": "Llama 3.1 8B (on-prem)",
      "auto": { "tiers": ["fast"], "quality": 45 },
      "endpoints": [
        {
          "provider": "vllm",
          "upstreamModel": "meta-llama/Llama-3.1-8B-Instruct",
          "price": { "input": 0.05, "output": 0.05 },
          "cost": { "input": 0, "output": 0 },
          "contextLength": 131072,
          "capabilities": { "tools": true, "json": true }
        }
      ]
    }
  ],
  "remove": ["x-ai/grok-3-mini"]
}
```

Existing models are merged field by field and endpoints by `provider` (`replaceEndpoints: true`
replaces the list); new endpoints need `upstreamModel`, `price` and `contextLength`. Keys never
live in the file — custom providers name the env var holding theirs (`apiKeyEnv`, or
`keyless: true` for local servers). The file is validated at boot; mistakes fail fast.

---

## Provider adapter notes

- **openai-compatible** — strips gateway-only fields, sets the upstream model, adds
  `stream_options.include_usage` (except Mistral, which reports usage by default), applies quirks,
  passes every other OpenAI parameter through, reads Groq's `x_groq.usage`, and maps in-stream
  `{"error": …}` events to errors.
- **azure-openai** — `POST {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=…`
  with the `api-key` header; the catalog's `upstreamModel` is the deployment name.
- **anthropic** — Messages API. System/developer messages → `system`; images (data URLs → base64,
  https → URL source); assistant `tool_calls` ⇄ `tool_use`; `tool` messages → `tool_result` blocks
  (consecutive same-role turns merged); `tool_choice` `auto/none/required/{function}` →
  `auto/none/any/tool`; `parallel_tool_calls:false` → `disable_parallel_tool_use`; `stop` →
  `stop_sequences`; `user` → `metadata.user_id`; temperature clamped to Anthropic's 0–1;
  `max_tokens` defaulted (mandatory upstream). `response_format` is implemented by a system-prompt
  instruction (works on every model; native structured outputs are a follow-up). Stop reasons map
  `end_turn/stop_sequence → stop`, `max_tokens → length`, `tool_use → tool_calls`,
  `refusal → content_filter`. Usage counts cache reads/writes as prompt tokens. Sends
  `anthropic-version: 2023-06-01` by default; with `ANTHROPIC_VERSION ≥ 2026-10-21` sampling
  parameters are always stripped (that version rejects them).
- **google** — **why native Gemini instead of Google's OpenAI-compatible endpoint**: the native
  `generateContent` / `streamGenerateContent?alt=sse` API is the stable, first-documented surface;
  it returns exact `usageMetadata` (including thinking tokens, billed as output) on streams,
  explicit safety/block reasons, and lets us round-trip Gemini 3 `thoughtSignature`s on function
  calls (exposed as `tool_calls[].extra_content.google.thought_signature`, the convention Google's
  own compatibility layer uses). The OpenAI-compatible endpoint is a beta translation layer with
  partial parameter support. Translation: `system` → `systemInstruction`, roles `user`/`model`,
  images → `inlineData` (data URLs) / `fileData` (URLs), tools → `functionDeclarations` (schemas
  sanitized to Gemini's OpenAPI subset), `tool_choice` → `functionCallingConfig`, JSON modes →
  `responseMimeType` (+ `responseSchema`).
- **mock** — echoes the last user message (`Echo: …`), returns JSON when `response_format` asks
  for it, calls a tool when `tool_choice` forces one or the user names it; deterministic embeddings.

## Unverified against live APIs

Nothing in this service has been exercised against a real provider yet; all adapters were built
from public API documentation and are tested only with fixtures and local mock HTTP servers.
Everything below is marked `verified: false` in code and in `GET /v1/models` until tested live:

- **All provider adapters**: openai-compatible (OpenAI, DeepSeek, Groq, Together, Fireworks,
  OpenRouter, DashScope intl compatible-mode, BytePlus ModelArk, xAI, Mistral), azure-openai,
  anthropic, google.
- **Every catalog endpoint**: upstream model slugs (especially BytePlus `seed-*` dated ids,
  Fireworks/Together paths, DashScope names, Gemini 3 preview id), context windows, output limits,
  capability flags, and **all prices/costs**.
- Specific behaviours: `stream_options.include_usage` support per provider; Groq `x_groq.usage`;
  Azure `api-version=2024-10-21` streaming usage; Anthropic tool streaming, `tool_choice: none`,
  image URL sources, thinking/ping heartbeats, and the 2026-10-21 version rule; Gemini
  `responseSchema` acceptance of sanitized schemas, `fileData` with plain https image URLs,
  thought-signature round-tripping, and function-response role handling; quirk lists
  (`dropParams`, `noForcedToolChoice`) per model.

## Known gaps

- Health and circuit state are **in-memory per replica** (no shared store); rate limiting of API
  keys (in `@ok/core`) is per replica too.
- Tiered/long-context upstream pricing (e.g. Gemini > 200K tokens, Claude Haiku 5.5 > 100K) and
  discounted cached-input pricing are not modelled: we bill full input price on cached tokens.
- No pre-authorization of worst-case cost; a single large request can take a low balance negative.
- Request rows are written at completion (a crash mid-request loses the row and the charge).
- `n > 1`, the Responses API, audio, PDFs/files, logprobs translation for non-OpenAI providers,
  and native Anthropic structured outputs are not supported.
- The auto classifier is lexical; tune `auto` profiles in the catalog with real traffic.
- Customers can't see `upstream_cost_micros`; an internal admin view of margins doesn't exist yet.

---

## Development

```bash
pnpm --filter @ok/gateway typecheck
pnpm --filter @ok/gateway test        # offline: PGlite + local mock upstream HTTP servers
pnpm --filter @ok/gateway build       # dist/index.js (workspace packages bundled, npm deps external)
```

```
src/
  index.ts            boot: env → db → migrations → runtime → (dev seed) → serve
  app.ts              createApp(deps): routes (pure, all deps injected)
  env.ts              zod env schema
  runtime.ts          catalog + adapters + health from env
  catalog/            types, default catalog, CATALOG_PATH merge, Catalog (credentials, mock fallback, aliases)
  providers/          adapter interface, errors/classification, SSE reader, openai-compatible, azure, anthropic, google, mock
  routing/            token estimates, health tracker + circuit breaker, endpoint selection, auto classifier, plan
  services/           gateway (attempts, fallback, streaming, billing, logging), billing helpers, request log + usage SQL
  db/                 Drizzle schema (pgSchema 'gateway') + SQL migrations
  views.ts            public response serializers
  test/helpers.ts     mock upstream servers, SSE helpers, app harness
```
