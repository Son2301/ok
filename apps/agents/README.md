# Agents — hosted AI employees (`@ok/agents`, port 4100)

Customers create **agents** ("AI employees"), give them a role and job description, knowledge
and integrations, connect chat channels (Zalo OA, Telegram, a website widget), and the platform
runs each agent 24/7 in its own isolated container. LLM usage is included in the plan (fair-use
monthly token quota) and goes through the platform gateway. Positioned for Vietnamese SMBs:
Vietnamese-first prompts and defaults, Asia/Ho_Chi_Minh time, diacritic-insensitive knowledge
search, and local integrations (Zalo OA, KiotViet, Haravan, Shopee, MISA).

```
                    ┌──────────────────────────── control plane (this service) ─────────────────────────────┐
 customer API ────▶ │ /v1/*  agents · tasks · knowledge · integrations · approvals · usage   (authMiddleware) │
 web console        │                                                                                         │
 Telegram/Zalo ───▶ │ /channels/*  (secret / signature verified) ──┐                                          │
 website widget ──▶ │ /public/chat/:token  (rate limited)          ├─▶ ConversationService ─▶ RuntimeDriver   │
                    │                                              │      (context, history,    inline | docker │
                    │ ToolService ◀── tool proxy /internal/agents/:id/tools/:tool ◀──┐  persistence)           │
                    │  (credentials,  MCP server  /mcp/:agentId ◀────────────────────┤                          │
                    │   trust levels, LLM proxy   /internal/agents/:id/llm/v1 ◀──────┤                          │
                    │   traces)        LlmBroker (quota split, budget cap) ──▶ gateway (x-org-id, x-ok-product) │
                    └────────────────────────────────────────────────────────────────┼──────────────────────────┘
                                                                                     │ runtime token only
                                     ┌───────────── agent container (one per agent) ─┴────────────┐
                                     │ builtin runtime server: signed POST /turn → agent loop      │
                                     │ (or OpenClaw / Hermes behind the same front door, via MCP)  │
                                     └─────────────────────────────────────────────────────────────┘
```

## Concepts

| Concept            | What it is                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent**          | Name, avatar, role, job description (system prompt), model (default `auto` → gateway routing), runtime (`builtin` \| `openclaw` \| `hermes`), plan (`starter` \| `pro`), integrations + per-integration config and per-tool trust levels, channels, `reportsTo`, monthly budget cap, status.                                                                                      |
| **Status**         | `draft` → `deploying` → `running` ⇄ `stopped`; `error`; `suspended_billing` (daily fee failed); `paused_budget` (monthly budget cap hit).                                                                                                                                                                                                                                         |
| **Conversation**   | Keyed by (agent, channel, external user id). Channels: `api`, `web`, `telegram`, `zalo`, `internal` (scheduler wake-ups). One turn at a time per conversation.                                                                                                                                                                                                                    |
| **Turn**           | The agent loop (`src/runtime/loop.ts`): system prompt (JD + company + team + tool guidance + date/time in Asia/Ho_Chi_Minh) → LLM with tools → execute tool calls (independent calls in parallel, side-effecting calls sequentially) → repeat until a final answer, `maxSteps` (default 8), the per-turn token budget or the time budget. Messages and tool traces are persisted. |
| **Integration**    | `{ id, name, category, verified, authSchema (zod), configSchema, tools[] }`. Credentials are encrypted at rest and never leave the control plane: **tools always execute in the control plane**, whichever runtime asked.                                                                                                                                                         |
| **Trust level**    | Per tool, per agent: `off` (hidden) · `draft` (store the would-be action, don't execute) · `approve` (queue for the owner's approval) · `auto` (execute). Defaults: reads → `auto`; writes/sends/spends → `approve`; **commerce write tools → `off`** (must be enabled explicitly).                                                                                               |
| **Runtime driver** | `inline` (in-process; dev/tests/no Docker) or `docker` (one hardened container per agent). Same interface: `deploy/start/stop/remove/status/logs/send`.                                                                                                                                                                                                                           |
| **AI employees**   | Org chart via `reportsTo`, task board (`/v1/tasks`), agent tools `list_my_tasks`, `update_task`, `comment_on_task`, `create_subtask`, `delegate_task` (direct reports only), `report_to_manager`. The scheduler wakes agents with open tasks (heartbeat) and posts a daily summary report per agent.                                                                              |
| **Billing**        | Plans have a monthly price charged **daily, prorated** from the shared wallet. LLM tokens inside the plan's monthly quota are billed to the platform org; beyond it, to the customer org. Optional per-agent monthly budget cap.                                                                                                                                                  |

## Running

```bash
pnpm install
pnpm --filter @ok/agents dev                       # tsx watch, port 4100, PGlite in memory, inline driver
pnpm --filter @ok/agents test                      # offline: MockLlm, PGlite, fake HTTP, mocked Docker
pnpm --filter @ok/agents build                     # dist/index.js (control plane) + dist/runtime.js (agent image)
DATABASE_URL=memory:// PORT=4998 node apps/agents/dist/index.js && curl localhost:4998/health
docker build -f apps/agents/Dockerfile.runtime -t ok/agents-runtime:latest .   # builtin runtime image
```

## Environment

| Variable                                         | Default                     | Notes                                                                                                                              |
| ------------------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                           | `4100`                      |                                                                                                                                    |
| `DATABASE_URL`                                   | `memory://`                 | `postgres://…` in production; `pglite:///path` for on-disk dev.                                                                    |
| `INTERNAL_TOKEN`                                 | dev value                   | Web console → service auth (`Bearer` + `X-Org-Id`). Also the gateway credential. **Never** given to containers.                    |
| `PUBLIC_URL`                                     | `http://localhost:4100`     | Base for webhook URLs, widget embed code, MCP URLs shown to customers.                                                             |
| `CONTROL_PLANE_URL`                              | `PUBLIC_URL`                | How containers reach the control plane (tool proxy, LLM proxy, MCP).                                                               |
| `GATEWAY_URL`                                    | `http://localhost:4000/v1`  | Platform gateway (OpenAI-compatible).                                                                                              |
| `AGENTS_ENCRYPTION_KEY`                          | –                           | 32 bytes, base64 or hex (`openssl rand -base64 32`). **Required in production**; in dev an ephemeral key is used (with a warning). |
| `AGENTS_ENCRYPTION_KEY_PREVIOUS`                 | –                           | Old key kept for decryption during rotation.                                                                                       |
| `AGENTS_PLATFORM_ORG_ID`                         | –                           | Org that pays for in-quota LLM usage. Unset → customers pay for all usage. Fund its wallet.                                        |
| `AGENTS_RUNTIME_DRIVER`                          | `auto`                      | `auto` (docker if the socket answers, else inline), `inline`, `docker`.                                                            |
| `DOCKER_SOCKET`                                  | `/var/run/docker.sock`      |                                                                                                                                    |
| `AGENTS_DOCKER_NETWORK`                          | `ok-agents`                 | Dedicated bridge network (created if missing).                                                                                     |
| `AGENTS_DOCKER_NETWORK_INTERNAL`                 | `false`                     | `true` = no egress except via other attached networks.                                                                             |
| `AGENTS_DOCKER_ICC`                              | `false`                     | Inter-container traffic on the agents network (off: agents cannot reach each other).                                               |
| `AGENTS_DOCKER_ADDRESS_MODE`                     | `ip`                        | `ip` (control plane on the host) or `name` (control plane attached to the network).                                                |
| `AGENTS_IMAGE_BUILTIN` / `_OPENCLAW` / `_HERMES` | `ok/agents-runtime*:latest` | Image per runtime.                                                                                                                 |
| `AGENTS_SCHEDULER_ENABLED`                       | `true`                      |                                                                                                                                    |
| `AGENTS_SCHEDULER_INTERVAL_MS`                   | `60000`                     | Tick interval.                                                                                                                     |
| `AGENTS_HEARTBEAT_INTERVAL_MIN`                  | `60`                        | Minimum time between wake-ups of the same agent.                                                                                   |
| `AGENTS_DAILY_SUMMARY_HOUR`                      | `18`                        | Local hour after which daily summaries are posted.                                                                                 |
| `AGENTS_TIMEZONE`                                | `Asia/Ho_Chi_Minh`          | Billing days, months, prompts.                                                                                                     |
| `AGENTS_MAX_STEPS`                               | `8`                         | Default LLM steps per turn (agent setting `maxSteps` overrides).                                                                   |
| `AGENTS_TURN_TOKEN_BUDGET`                       | `60000`                     | Max tokens per turn (all steps).                                                                                                   |
| `AGENTS_TURN_TIME_BUDGET_MS`                     | `90000`                     | Max wall time per turn.                                                                                                            |
| `AGENTS_TRUST_PROXY`                             | `false`                     | Use `X-Forwarded-For` for client IPs (behind a reverse proxy).                                                                     |
| `AGENTS_PUBLIC_CHAT_RPM`                         | `20`                        | Web-widget messages per minute per IP (and ×30 per widget).                                                                        |
| `AGENTS_PLAN_STARTER_PRICE_MICROS`               | `8000000`                   | $8/month.                                                                                                                          |
| `AGENTS_PLAN_STARTER_MONTHLY_TOKENS`             | `3000000`                   | Included tokens per agent per month.                                                                                               |
| `AGENTS_PLAN_PRO_PRICE_MICROS`                   | `20000000`                  | $20/month.                                                                                                                         |
| `AGENTS_PLAN_PRO_MONTHLY_TOKENS`                 | `10000000`                  |                                                                                                                                    |

Container limits per plan: starter 0.5 CPU / 512 MB / 256 pids, pro 1 CPU / 1 GB / 512 pids (`src/config.ts`).

## Security model — where credentials live

| Secret                                                       | Where it lives                                                                                                                                                 | Who can use it                                                                                                                                                                  |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integration credentials (bot tokens, OAuth tokens, API keys) | `agents.integration_credentials`, AES-256-GCM (`v1.<keyId>.<iv>.<tag>.<ct>`), AAD = `org:agent:integration` so a row copied to another agent fails to decrypt. | Only `ToolService` in the control plane, while a tool runs. API responses return masked previews (`••••abcd`), computed at write time. Refreshed OAuth tokens are re-encrypted. |
| `INTERNAL_TOKEN` (gateway + console)                         | Control-plane env only.                                                                                                                                        | Never injected into containers.                                                                                                                                                 |
| Runtime token `agrt_…` (per agent)                           | Plaintext only in that agent's container env (or shown once for `external` tokens). DB stores **sha256** only. Rotated on every deploy.                        | Authorises, for that one agent: the tool proxy, the LLM proxy and the MCP endpoint. Revocable.                                                                                  |
| Control plane → container requests                           | Signed `HMAC-SHA256(key = sha256(runtimeToken), "<ts>.<body>")`, 5-minute window.                                                                              | A database leak cannot be turned into tool-proxy access (needs the plaintext token).                                                                                            |
| Telegram webhook secret                                      | sha256 in `agents.channels`; plaintext shown once.                                                                                                             | Verified on every webhook (`X-Telegram-Bot-Api-Secret-Token`).                                                                                                                  |
| Zalo OA secret key                                           | Encrypted with the Zalo credentials.                                                                                                                           | Verifies `X-ZEvent-Signature: mac=sha256(appId + body + timestamp + oaSecretKey)`.                                                                                              |

Container hardening (docker driver): one container per agent named `ok-agent-<id>`, labelled
`ok.managed-by/ok.agent-id/ok.org-id/ok.runtime/ok.plan`; plan CPU/memory/pids limits, swap off;
`ReadonlyRootfs` (builtin), `noexec` `/tmp` tmpfs, `CapDrop: ALL`, `no-new-privileges`, never
privileged, non-root user (builtin `10001`), no published ports, dedicated network with ICC off,
`unless-stopped` restart policy, bounded json-file logs. **Env injection is exactly**
`OK_AGENT_ID`, `OK_RUNTIME_TOKEN`, `OK_CONTROL_PLANE_URL`, `OK_GATEWAY_URL` (the per-agent LLM proxy).

Other guards: SSRF-safe `http_request`/`send_webhook` (http/https only, per-agent host allowlist,
every DNS answer must be public — loopback, RFC 1918, link-local/metadata, CGNAT, multicast,
reserved, ULA, IPv4-mapped/NAT64/6to4-embedded private addresses are blocked — the socket is pinned
to the validated address, redirects re-validated, size/time limits); zod validation on every body;
per-IP rate limit on the public widget; prompts treat tool/document/customer content as data.

## Trust & safety

- **Per-tool trust levels** `off | draft | approve | auto`, set per agent:
  `PUT /v1/agents/:id/integrations/:integrationId { "tools": { "gmail_send": "auto" } }`.
  Defaults: read-only lookups `auto`; anything that sends/writes/spends externally (`telegram_send_message`,
  `zalo_send_message`, `gmail_send`, `gcal_create_event`, `send_webhook`, `http_request` with a non-GET method)
  `approve`; **commerce write tools** (`kiotviet_create_order`, `haravan_add_order_note`,
  `shopify_create_draft_order`, Shopee/TikTok/MISA writes) `off` until enabled. Platform-internal tools
  (tasks, reports) are `auto`. Approval-level tools are labelled in the tool description, and the model is
  told that a `pending_approval` result means "queued — don't claim it's done".
- **Approvals** — `approve` creates a pending approval (tool, args, agent, conversation); `draft` stores a
  drafted one without executing. The owner approves (the tool runs then, with the stored arguments) or
  rejects; a note is appended to the conversation so the agent knows on its next turn.
- **Budget cap** — `budgetMonthlyMicros` per agent caps the LLM spend billed to the customer each month.
  Checked **before every customer-billed LLM call** (calls inside the included quota are never blocked;
  `0` therefore means "only what the plan includes"): warning event at 80%, `paused_budget` at 100% (LLM calls refused,
  runtime stopped). The scheduler resumes the agent when it is under budget again (new month or raised cap).
- **Inbound policy** — `settings.inbound = { policy: 'open' | 'allowlist', allowlist: ['telegram:12345', 'zalo:678'] }`
  for messaging channels; unknown senders are ignored and logged (`inbound_blocked`). The web widget is public
  by design and controlled with `allowedOrigins` + rate limits.
- **AI disclosure** (Vietnam AI law) — on by default: the first reply of every Telegram/Zalo/web conversation
  starts with a disclosure (default Vietnamese/English text, customisable via
  `settings.aiDisclosure = { enabled, text }`).

## Billing

- **Subscriptions**: `monthly price / days in the local month`, charged once per local day per running agent
  via `core.debit(orgId, amount, { product: 'agents', kind: 'subscription', ref: 'agent:<id>:<day>' })`.
  Charged on deploy/start (402 if the wallet can't pay) and by the scheduler each day; idempotent across
  replicas (partial unique index on `(agent_id, day)`). A failed daily charge suspends the agent
  (`suspended_billing`); top up and `POST /start` to resume. Stopped agents are not charged.
- **LLM**: every call goes through `LlmBroker` → gateway with `x-org-id` + `x-ok-product: agents`.
  While the agent's platform-paid tokens this month are below the plan quota, `x-org-id` is the platform
  org; afterwards it is the customer org (the gateway bills that wallet). A call that crosses the
  boundary is billed entirely to the platform (small, bounded overshoot). Per-agent monthly usage
  (`agents.usage_monthly`) tracks total/platform/customer tokens and cost.

## API reference

Auth for `/v1/*`: `Authorization: Bearer sk-ok-…` (API key with scope `agents` or `*`), or
`Authorization: Bearer $INTERNAL_TOKEN` + `X-Org-Id: org_…` (web console). Errors:
`{ "error": { "code", "message", "details"? } }`. Money is integer micro-USD.

```bash
API=http://localhost:4100; KEY=sk-ok-...; H=(-H "authorization: Bearer $KEY" -H 'content-type: application/json')
```

### Agents

| Method   | Path                                                      |                                                                         |
| -------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| `GET`    | `/v1/agents`                                              | List.                                                                   |
| `POST`   | `/v1/agents`                                              | Create (status `draft`).                                                |
| `GET`    | `/v1/agents/:id`                                          | Detail + integration status (masked) + channels + month usage.          |
| `PATCH`  | `/v1/agents/:id`                                          | Update; returns `requiresRedeploy` when runtime/plan changed on docker. |
| `DELETE` | `/v1/agents/:id`                                          | Remove runtime, revoke tokens, delete data.                             |
| `POST`   | `/v1/agents/:id/deploy` \| `start` \| `stop` \| `restart` | Lifecycle (deploy/start charge today's fee if not yet charged).         |
| `GET`    | `/v1/agents/:id/status?tail=100`                          | Status, runtime state, usage vs quota/budget, recent logs, events.      |
| `GET`    | `/v1/agents/:id/logs?tail=200`                            | Runtime logs.                                                           |
| `POST`   | `/v1/agents/:id/wake`                                     | Run a heartbeat now (if the agent has open tasks).                      |

```bash
curl -s "${H[@]}" -X POST $API/v1/agents -d '{
  "name": "Lan", "role": "Nhân viên chăm sóc khách hàng",
  "jobDescription": "Trả lời khách về sản phẩm, giá, tình trạng đơn hàng. Lịch sự, ngắn gọn.",
  "plan": "starter", "budgetMonthlyMicros": 5000000,
  "integrations": { "kiotviet": { "enabled": true, "config": { "retailer": "cuahangan" } } },
  "settings": { "language": "vi", "inbound": { "policy": "open", "allowlist": [] } }
}'
curl -s "${H[@]}" -X POST $API/v1/agents/agt_xxx/deploy
curl -s "${H[@]}" $API/v1/agents/agt_xxx/status
```

### Conversations

| Method | Path                                                             |                                                                                                                   |
| ------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/agents/:id/messages`                                        | `{ message, userId? }` → `{ conversationId, messageId, reply, disclosure, toolCalls, usage, steps, stopReason }`. |
| `POST` | `/v1/agents/:id/messages/stream`                                 | Same, as SSE: `start`, `step`, `delta`, `tool_call`, `tool_result`, `done` (or `error`).                          |
| `GET`  | `/v1/agents/:id/conversations?channel=&limit=`                   | List.                                                                                                             |
| `GET`  | `/v1/agents/:id/conversations/:cid/messages?limit=&before=<seq>` | History (user/assistant/tool/system).                                                                             |
| `GET`  | `/v1/agents/:id/tool-calls`                                      | Tool traces (args, result, outcome, source, duration).                                                            |

```bash
curl -s "${H[@]}" -X POST $API/v1/agents/agt_xxx/messages -d '{"message":"Đơn DH001 của tôi tới đâu rồi?","userId":"khach-42"}'
curl -N "${H[@]}" -X POST $API/v1/agents/agt_xxx/messages/stream -d '{"message":"Shop mở cửa mấy giờ?"}'
```

### Integrations & credentials

| Method   | Path                                         |                                                                                                                                                 |
| -------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/v1/integrations` \| `/v1/integrations/:id` | Catalog: id, name, category, verified, status, auth/config JSON schemas, tools (parameters, risk, default trust).                               |
| `GET`    | `/v1/agents/:id/integrations`                | Per-agent state: enabled, ready, config, per-tool trust, masked credentials.                                                                    |
| `PUT`    | `/v1/agents/:id/integrations/:integrationId` | `{ enabled?, config?, credentials?, tools? }`. Credentials merge (send `null` to clear a field), are validated, encrypted, and returned masked. |
| `DELETE` | `/v1/agents/:id/integrations/:integrationId` | Disable and delete credentials.                                                                                                                 |

```bash
curl -s "${H[@]}" -X PUT $API/v1/agents/agt_xxx/integrations/kiotviet \
  -d '{"credentials":{"clientId":"…","clientSecret":"…"},"config":{"retailer":"cuahangan"},"tools":{"kiotviet_create_order":"approve"}}'
curl -s "${H[@]}" -X PUT $API/v1/agents/agt_xxx/integrations/http \
  -d '{"config":{"allowedHosts":["api.mycompany.vn"],"allowedMethods":["GET"]}}'
```

### Approvals

| Method | Path                                                                               |                                                                                   |
| ------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `GET`  | `/v1/approvals?status=pending\|drafted\|open\|executed\|failed\|rejected&agentId=` |                                                                                   |
| `GET`  | `/v1/approvals/:id`                                                                |                                                                                   |
| `POST` | `/v1/approvals/:id/approve`                                                        | `{ note? }` → executes the tool; status `executed` or `failed` with result/error. |
| `POST` | `/v1/approvals/:id/reject`                                                         | `{ note? }`                                                                       |

```bash
curl -s "${H[@]}" "$API/v1/approvals?status=open"
curl -s "${H[@]}" -X POST $API/v1/approvals/apr_xxx/approve -d '{"note":"OK gửi đi"}'
```

### Knowledge base

| Method       | Path                                                   |                                                                                                     |
| ------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `POST`       | `/v1/agents/:id/knowledge`                             | JSON `{ content, filename?, title?, mimeType? }` or multipart `file` (.txt .md .csv .html, ≤ 5 MB). |
| `GET`        | `/v1/agents/:id/knowledge` \| `/:docId`                | List / document with chunks.                                                                        |
| `DELETE`     | `/v1/agents/:id/knowledge/:docId`                      |                                                                                                     |
| `GET`        | `/v1/agents/:id/knowledge/search?q=&limit=`            | Same search the `search_knowledge` tool uses.                                                       |
| `POST` `GET` | `/v1/knowledge`, `GET`/`DELETE` `/v1/knowledge/:docId` | Org-wide documents shared by all agents.                                                            |

Documents are converted to text (HTML stripped, CSV rows → `header: value; …`), chunked to ~800 tokens
with ~100 tokens overlap (markdown headings carried into each chunk), and indexed with two
`tsvector`s using the dictionary-free `simple` config: one on the original text and one on a
lowercased, diacritics-stripped copy — so `gia ao so mi` finds `Giá áo sơ mi`. Search ORs the query
terms against the normalised column and ranks by cover density with a bonus for exact-diacritic matches.

```bash
curl -s -H "authorization: Bearer $KEY" -X POST $API/v1/agents/agt_xxx/knowledge -F file=@bang-gia.csv
curl -s "${H[@]}" "$API/v1/agents/agt_xxx/knowledge/search?q=chinh%20sach%20doi%20tra"
```

### Channels

| Method                 | Path                               |                                                                                                                                              |
| ---------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`                  | `/v1/agents/:id/channels`          |                                                                                                                                              |
| `PUT`                  | `/v1/agents/:id/channels/telegram` | `{ registerWebhook?: true }` → `webhookUrl`, `secrets.secretToken` (once); calls `setWebhook` if asked. Requires the `telegram` integration. |
| `PUT`                  | `/v1/agents/:id/channels/zalo`     | Requires `zalo_oa` credentials incl. `appId` + `oaSecretKey`; returns the webhook URL to paste in the Zalo app settings.                     |
| `PUT`                  | `/v1/agents/:id/channels/web`      | `{ config: { title?, greeting?, color?, allowedOrigins? } }` → `publicToken`, embed snippet.                                                 |
| `DELETE`               | `/v1/agents/:id/channels/:type`    |                                                                                                                                              |
| `POST`                 | `/channels/telegram/:agentId`      | Telegram webhook (verified by secret token; deduplicated by `update_id`).                                                                    |
| `POST`                 | `/channels/zalo/:agentId`          | Zalo OA webhook (verified by `X-ZEvent-Signature`; deduplicated by `msg_id`; `user_send_text`).                                              |
| `GET` `POST` `OPTIONS` | `/public/chat/:publicToken`        | Widget config / send `{ message, sessionId }` → `{ reply, disclosure }`. CORS per `allowedOrigins`, per-IP rate limit.                       |
| `GET`                  | `/widget.js`                       | Embeddable widget: `<script src="$PUBLIC_URL/widget.js" data-token="pub_…" async></script>`                                                  |

Webhooks are acknowledged immediately and processed in the background; replies go back through the
channel's send API (Telegram `sendMessage`, Zalo OA v3 `message/cs`, split to each platform's length limit).

```bash
curl -s "${H[@]}" -X PUT $API/v1/agents/agt_xxx/integrations/telegram -d '{"credentials":{"botToken":"123456:ABC…"}}'
curl -s "${H[@]}" -X PUT $API/v1/agents/agt_xxx/channels/telegram -d '{"registerWebhook":true}'
curl -s "${H[@]}" -X PUT $API/v1/agents/agt_xxx/channels/web -d '{"config":{"title":"Hỗ trợ","greeting":"Chào bạn!","allowedOrigins":["https://shop.vn"]}}'
```

### AI employees: tasks, reports, org chart

| Method                 | Path                                                                                     |                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GET`                  | `/v1/tasks?assigneeAgentId=&status=todo\|in_progress\|blocked\|done\|open&parentTaskId=` |                                                                                                                    |
| `POST`                 | `/v1/tasks`                                                                              | `{ title, description?, assigneeAgentId?, status?, priority? (low\|medium\|high\|urgent), dueAt?, parentTaskId? }` |
| `GET` `PATCH` `DELETE` | `/v1/tasks/:id`                                                                          | Detail includes comments and subtasks.                                                                             |
| `POST`                 | `/v1/tasks/:id/comments`                                                                 | `{ body }`                                                                                                         |
| `GET`                  | `/v1/reports?agentId=&managerAgentId=<id>\|owner&kind=report\|daily_summary`             | The owner sees all reports.                                                                                        |
| `GET`                  | `/v1/org-chart`                                                                          | Forest of agents by `reportsTo`.                                                                                   |

Agent tool rules: agents update tasks assigned to them (or that they delegated), comment on their
tasks / tasks they delegated / tasks of direct reports, create subtasks under their own tasks,
**delegate only to direct reports**, and `report_to_manager` goes to their manager agent (shown in
the manager's prompt for 48 h) or to the owner.

```bash
curl -s "${H[@]}" -X POST $API/v1/tasks -d '{"title":"Gọi lại khách VIP","assigneeAgentId":"agt_xxx","priority":"urgent"}'
curl -s "${H[@]}" "$API/v1/reports?kind=daily_summary"
```

### Company, plans, usage, billing, runtime tokens

| Method       | Path                                     |                                                                                                   |
| ------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET` `PUT`  | `/v1/company`                            | `{ companyName, companyDescription, language (vi\|en), timezone }` — company context for prompts. |
| `GET`        | `/v1/plans`                              | Prices (monthly + today's daily), included tokens, limits.                                        |
| `GET`        | `/v1/usage?month=YYYY-MM`                | Per agent: tokens (platform/customer), customer cost, remaining included tokens, budget.          |
| `GET`        | `/v1/billing/charges?agentId=`           | Daily subscription charges (charged/failed).                                                      |
| `GET` `POST` | `/v1/agents/:id/runtime-tokens`          | `POST { label? }` issues an `external` token (shown once) + `mcpUrl` + `llmBaseUrl`.              |
| `DELETE`     | `/v1/agents/:id/runtime-tokens/:tokenId` | Revoke.                                                                                           |

### Runtime-facing endpoints (Bearer = per-agent runtime token)

| Method | Path                                           |                                                                                                             |
| ------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `POST` | `/internal/agents/:id/tools/:tool`             | Tool proxy: `{ arguments, conversationId?, toolCallId? }` → `{ ok, outcome, result?, error?, durationMs }`. |
| `GET`  | `/internal/agents/:id/tools`                   | Tool definitions (OpenAI format).                                                                           |
| `POST` | `/internal/agents/:id/llm/v1/chat/completions` | OpenAI-compatible LLM proxy (stream or not). The agent's model always wins; status, budget and quota apply. |
| `GET`  | `/internal/agents/:id/llm/v1/models`           |                                                                                                             |
| `POST` | `/mcp/:agentId`                                | MCP server (Streamable HTTP, stateless, JSON responses): `tools/list`, `tools/call`.                        |
| `GET`  | `/health`                                      |                                                                                                             |

```bash
# Connect any MCP client (e.g. a self-hosted OpenClaw) to an agent's tools:
TOKEN=$(curl -s "${H[@]}" -X POST $API/v1/agents/agt_xxx/runtime-tokens -d '{"label":"my-openclaw"}' | jq -r .token)
curl -s -X POST $API/mcp/agt_xxx -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Runtimes and drivers

- **Protocol** (`src/runtime/types.ts`): the control plane builds the whole turn (`TurnRequest`: system +
  history + user message, tool definitions, `sequentialTools`, `maxSteps`, budget) and calls
  `driver.send()`; the runtime returns a `TurnResult` (reply, new messages, tool traces, usage, stop reason)
  or streams `event`/`result` SSE events. Runtimes are stateless; the control plane persists everything.
- **inline driver**: runs the shared loop in-process, LLM via `LlmBroker`, tools via `ToolService`.
  No isolation — development, tests and hosts without Docker. On boot, `reconcile()` re-creates
  agents that were running.
- **docker driver** (Docker Engine API over the unix socket, no dependency): ensures the network, pulls
  missing images, replaces only containers it manages (label check), creates/starts the container, maps
  inspect state to `running/stopped/starting/error/missing`, demuxes logs, and sends signed turns to
  `http://<container-ip>:8080/turn`.
- **builtin image** (`Dockerfile.runtime`, `dist/runtime.js` built by tsup with every dependency inlined):
  verifies the signature, runs the same `runAgentLoop`, calls the LLM at `OK_GATEWAY_URL` (the control
  plane's per-agent LLM proxy, runtime token as API key) and executes tools via the tool proxy.
- **OpenClaw / Hermes** — _unverified templates_ in `runtimes/openclaw/` and `runtimes/hermes/`. The image
  runs the third-party runtime on loopback with its model endpoint set to `OK_GATEWAY_URL` (key
  `OK_RUNTIME_TOKEN`) and the agent's tools attached as an MCP server
  (`$OK_CONTROL_PLANE_URL/mcp/$OK_AGENT_ID`, `Authorization: Bearer $OK_RUNTIME_TOKEN`); the same
  `runtime.js` runs in `OK_RUNTIME_MODE=upstream` as the front door and forwards each turn to the runtime's
  local OpenAI-compatible endpoint (OpenClaw `:18789/v1`, Hermes API server `:8642/v1`) with a per-container
  secret. Config keys follow each project's public docs at the time of writing and must be validated
  against a pinned version before production. In upstream mode the control plane still sends the full
  history; tool calls are traced by the control plane (MCP), not returned in the turn result.
  The inline driver falls back to the builtin loop for these runtimes.

## Integration verification

`verified: true` only for our own platform code. Everything else is implemented from public docs with thin
adapters and fixture tests for request building and response parsing (`src/integrations/integrations.test.ts`).

| Integration             | Id                | Tools (default trust)                                                                                                                           | Status               | Verified      |
| ----------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------- |
| Core                    | `core`            | `search_knowledge`, `get_current_time` (auto)                                                                                                   | available, always on | ✅            |
| Team & tasks            | `team`            | `list_my_tasks`, `update_task`, `comment_on_task`, `create_subtask`, `delegate_task`, `report_to_manager` (auto)                                | available, always on | ✅            |
| HTTP requests           | `http`            | `http_request` (GET auto, other methods approve; allowlist required)                                                                            | available            | ✅            |
| Webhook                 | `webhook`         | `send_webhook` (approve; HMAC-signed, owner-set URL)                                                                                            | available            | ✅            |
| Zalo Official Account   | `zalo_oa`         | `zalo_send_message` (approve) + inbound channel, token refresh                                                                                  | available            | ❌ unverified |
| Telegram Bot            | `telegram`        | `telegram_send_message` (approve) + inbound channel, `setWebhook`                                                                               | available            | ❌ unverified |
| KiotViet                | `kiotviet`        | `kiotviet_search_products`, `kiotviet_get_order`, `kiotviet_list_orders`, `kiotviet_find_customers` (auto); `kiotviet_create_order` (off)       | available            | ❌ unverified |
| Haravan                 | `haravan`         | `haravan_get_order`, `haravan_find_orders`, `haravan_search_products`, `haravan_search_customers` (auto); `haravan_add_order_note` (off)        | available            | ❌ unverified |
| Shopify                 | `shopify`         | `shopify_find_orders`, `shopify_search_products`, `shopify_find_customers` (auto); `shopify_create_draft_order` (off) — Admin GraphQL `2025-10` | available            | ❌ unverified |
| Google Calendar         | `google_calendar` | `gcal_list_events` (auto), `gcal_create_event` (approve); OAuth refresh                                                                         | available            | ❌ unverified |
| Gmail                   | `gmail`           | `gmail_search` (auto), `gmail_send` (approve); OAuth refresh                                                                                    | available            | ❌ unverified |
| Shopee                  | `shopee`          | stubs with clear errors; **Open Platform v2 HMAC signing implemented + tested** (`shopeeSign`, `buildShopeeUrl`)                                | coming soon          | ❌            |
| TikTok Shop             | `tiktok_shop`     | stubs with clear errors                                                                                                                         | coming soon          | ❌            |
| MISA (AMIS / meInvoice) | `misa`            | stubs with clear errors                                                                                                                         | coming soon          | ❌            |

## Data model (`pgSchema('agents')`, hand-written SQL in `src/db/migrations.ts`)

`org_profiles`, `agents`, `integration_credentials`, `kb_documents`, `kb_chunks` (generated `tsv`,
`tsv_normalized` + GIN), `conversations`, `messages` (ordered by `seq`), `tool_calls`, `approvals`, `tasks`,
`task_comments`, `reports`, `usage_monthly`, `billing_charges`, `channels`, `runtime_tokens` (sha256),
`agent_events`, `inbound_events` (webhook dedupe).

## Tests

All offline (`pnpm --filter @ok/agents test`): agent loop (multi-step, parallel/sequential tools, budgets,
streaming tool-call reassembly), CRUD + auth + org isolation, lifecycle and billing, KB chunking and
Vietnamese search without diacritics, credential encryption/masking/rotation, SSRF guard (incl. a local
server and redirect re-validation), Shopee signing vectors, integration fixtures, Telegram/Zalo webhooks →
replies, web widget + rate limit, delegation rules, scheduler heartbeat + daily prorated billing +
suspension, quota split, budget cap, Docker container spec + lifecycle with a mocked Engine API, an
end-to-end container path (docker driver → signed turn → runtime server → LLM proxy + tool proxy), and
MCP listing/calls with the official SDK client.

## Known gaps

- Third-party integrations and the OpenClaw/Hermes templates are unverified against the real services.
- The web-widget rate limiter is in-process (per replica); use a shared store (e.g. Redis) when running
  several replicas. Webhook deduplication is already in Postgres.
- Knowledge upload accepts text formats only (no PDF/DOCX extraction yet); no embeddings (full-text only).
- The docker driver needs the control plane to reach container IPs (host networking) or
  `AGENTS_DOCKER_ADDRESS_MODE=name` with the control plane attached to the agents network (enable ICC then).
