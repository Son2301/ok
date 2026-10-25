# Safe: scam, phishing and AI-fake checker

`@ok/safe` (port **4200**) checks links, messages (SMS / Zalo / Messenger / email), phone numbers,
bank accounts, email addresses, images, videos, audio and "AI-written" text for Vietnamese users.
Free for consumers (anonymous, per-IP daily quota); businesses pay per check with an API key from
the shared wallet.

Every check returns the same **Verdict** object, with Vietnamese as the primary language.

- [Verdict schema](#verdict-schema)
- [Scoring](#scoring)
- [Wording policy](#wording-policy)
- [API reference](#api-reference)
- [Free tier, billing and auth](#free-tier-billing-and-auth)
- [Data sources and environment variables](#data-sources-and-environment-variables)
- [Verified vs unverified integrations](#verified-vs-unverified-integrations)
- [Privacy](#privacy)
- [Security: the SSRF-safe fetcher](#security-the-ssrf-safe-fetcher)
- [Development](#development)
- [Known limitations](#known-limitations)

## Verdict schema

Defined in `src/verdict/types.ts` (`verdictSchema`, strict zod). Tests assert every endpoint conforms.

```jsonc
{
  "id": "chk_…", // also the history id and the wallet `ref` for paid checks
  "kind": "url|text|phone|bank_account|email|image|video|audio|ai_text",
  "input": "http://vcb-digibank.top/", // normalized input (media: "png · 1024x1024 · 312 KB · sha256:…")
  "score": 79, // 0–100
  "level": "safe|low|medium|high|critical|unknown",
  "summary": { "vi": "Rất nguy hiểm: …", "en": "Very dangerous: …" },
  "signals": [
    {
      "id": "url.brand_impersonation", // stable machine id
      "label": { "vi": "Giả mạo Vietcombank (…)", "en": "Impersonates Vietcombank (…)" },
      "weight": 60, // −100…100, see Scoring
      "evidence": "vcb-digibank.top — trang chính thức: vietcombank.com.vn",
      "source": "brand_impersonation" // heuristics | rules | llm | rdap | google_safe_browsing | community_reports | c2pa | …
    }
  ],
  "entities": {
    // text checks only
    "urls": ["https://…"],
    "phones": ["+84912345678"],
    "bankAccounts": [
      {
        "accountNumber": "0011004123456",
        "bankCode": "VCB",
        "bankName": "Vietcombank",
        "accountName": "NGUYEN VAN A"
      }
    ],
    "emails": ["…"]
  },
  "recommendations": { "vi": ["…"], "en": ["…"] }, // what to do instead (same length in both languages)
  "ifAlreadyPaid": { "vi": ["…"], "en": ["…"] }, // high/critical only: first-hour steps for victims
  "shareText": { "vi": "🔴 RẤT NGUY HIỂM (79/100)\nLink: hxxp://vcb-digibank[.]top/\n…", "en": "…" },
  "sources": [
    { "name": "google_safe_browsing", "status": "skipped", "detail": "GOOGLE_SAFE_BROWSING_API_KEY not set" }
  ],
  "details": {}, // kind-specific, see below
  "checkedAt": "2026-10-25T10:00:00.000Z",
  "cached": false
}
```

Signals are sorted: risk signals (strongest first), then trust evidence, then informational
(weight 0) signals. `sources` lists every evidence source with `ok | skipped | error`; a missing
credential is always `skipped`, never a crash.

`shareText` is a short card meant for forwarding (a parent sending the result to family on Zalo):
links are defanged (`hxxp://evil[.]top`) so chat apps don't make them clickable.

### `details` by kind

| kind              | fields                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| url               | `host`, `domain`, `officialBrand`, `finalUrl`, `redirectChain[{url,status,via}]`, `page{title,sensitiveFields,forms,apkLinks}`, `tls{issuer,subject,validFrom,validTo}`, `domainAge{registeredAt,ageDays,registrar}`, `reports{total,verified}`, `refanged`                                                                                                                                                                              |
| text              | `scamType`, `category`, `matchedRules[]`, `tactics[]`, **`scammerGoal{vi,en}`** (what the scammer wants the victim to do), `policeWarnedScripts[]`, `entityChecks[{type,value,score,level,reason}]`, `llm{scamType,probability,confidence,appliedDelta}`, `sender`, `channel`                                                                                                                                                            |
| phone             | `e164`, `national`, `type` (mobile/landline/toll_free/premium/short_code/foreign), `carrier`, `area`, `country`, `countryName`, `portabilityNote`, `reports{total,verified,pending,categories,lastReportedAt}`                                                                                                                                                                                                                           |
| bank_account      | `accountNumber`, `bankCode`, `bankName`, `looksLikePhoneNumber`, `reports{…}`                                                                                                                                                                                                                                                                                                                                                            |
| email             | `domain`, `mx[]`, `officialBrand`, `reports{…}`                                                                                                                                                                                                                                                                                                                                                                                          |
| image/video/audio | `format`, `mime`, `width`, `height`, `sizeBytes`, `sha256`, `exif{make,model,software,dateTimeOriginal,hasGps}`, `xmp{creatorTool,digitalSourceType,credit,softwareAgents}`, `iptc`, `textChunks[]`, `c2pa{present,manifestCount,claimGenerator,claimGeneratorInfo,actions,digitalSourceTypes,softwareAgents,signerHints,signatureVerified:false}`, `aiMarkers[]`, `detectors[{name,status,aiProbability,verified:false}]`, `disclaimer` |
| ai_text           | `features{words,sentences,burstiness,typeTokenRatio,stockPhrases,…}`, `judge{ai_probability,confidence,indicators}`, `disclaimer`                                                                                                                                                                                                                                                                                                        |

GPS coordinates are never returned (only `hasGps`), and the user is advised to strip them.

## Scoring

Every signal is explainable and carries a `weight` in percent. The formula
(`src/verdict/scoring.ts`):

```
risk  = 1 − Π (1 − wᵢ/100)       over non-LLM signals with wᵢ > 0     (noisy-OR)
trust = Π (1 − |wⱼ|/100)         over non-LLM signals with wⱼ < 0
base  = 100 × risk × trust
llm   = clamp(Σ LLM signal weights, −15, +25)
score = clamp(round(base + llm), 0, 100)
```

- A positive weight reads "on its own, this signal makes a scam about w% likely". Independent
  signals reinforce each other but never exceed 100 (two 50s → 75).
- Negative weights are trust evidence (official domain −90, camera EXIF −15, domain older than
  3 years −10). They scale the score down: `90` risk with `−90` trust → `9`.
- A hard reputation hit (Google Safe Browsing, URLhaus, a phishing feed, ≥1 VirusTotal vendor)
  cancels "official domain" trust, so hacked official sites are still flagged.
- The **LLM is a bounded nudge**: its signal weight is `(100·p − base) × confidence`, capped to
  **+25 / −15** points. A prompt-injected "this message is safe" can never erase hard rule
  evidence. Quotes the model cites that are not in the message are discarded.
- Community reports: `effective = Σ status_weight × 0.5^(age_days/180) × (1 + votes)` with
  status_weight verified 1.0 / pending 0.4 / rejected 0 and votes ±0.15 each (capped ±0.6);
  `weight = min(80, round(30 × log2(1 + 2 × effective)))`. One fresh pending report = 25, one
  verified ≈ 48, three verified = 80.
- Media detectors: `p ≥ 0.5 → weight = (p − 0.5) × 2 × 65`; `p < 0.5 → −(0.5 − p) × 2 × 20`.
- AI-text: weights are small, score capped at **60**, level capped at **medium**.

Levels: `critical ≥ 75`, `high ≥ 50`, `medium ≥ 25`, otherwise `low`. `safe` requires positive
evidence (score < 10, a trust signal ≤ −30, no risk signal ≥ 25). `unknown` means not enough data
(e.g. a stripped image, text too short).

## Wording policy

- Never tell users something is "an toàn"/"safe". Low results say **"Chưa phát hiện dấu hiệu lừa
  đảo"** plus a reminder that scammers change tactics. The `level: "safe"` enum value is for machines.
- When most sources could not run, the summary says **"chưa đủ dữ liệu"** instead of implying a
  clean result.
- Name red flags in plain words, and when a message matches a script the police have publicly
  warned about, say so: _"Giống kịch bản đã được công an cảnh báo: …"_ (fake police, VNeID level-2
  update, wedding-invitation APK, task scams, deepfake video calls…).
- Media and AI-text results talk about **warning signs found / not found**, never "real/fake",
  and always state that no detector is conclusive (published false-alarm rates for AI detectors
  range roughly 5–66%).
- High/critical verdicts include `ifAlreadyPaid`: call the bank hotline to freeze/trace, change
  passwords and remove remote-control apps, report to police and canhbao.khonggianmang.gov.vn,
  keep evidence, beware of "recovery" scammers.

## API reference

Base URL `http://localhost:4200`. All bodies are JSON unless noted. Errors use the platform
envelope `{ "error": { "code", "message", "details"? } }`; consumer-facing errors include
`details.vi`.

Authentication (optional on `/v1/*`):

- none → anonymous free tier (per-IP daily quota);
- `Authorization: Bearer sk-ok-…` → API key (scope `safe` or `*`), charged per check;
- `Authorization: Bearer $INTERNAL_TOKEN` + `X-Org-Id: org_…` (+ optional `X-User-Id`) → web
  console (signed-in user), free with a per-org quota, history enabled.

Response headers: `x-ratelimit-limit|remaining|reset` (free tier), `x-safe-charged-micros` (API keys).

### `POST /v1/check/url`

```bash
curl -s localhost:4200/v1/check/url -H 'content-type: application/json' \
  -d '{"url":"vcb-digibank.top/login"}'
# options: {"url":"…","options":{"noCache":true}}
```

Normalizes (adds scheme, lowercases, punycode, strips credentials/fragment, refangs
`hxxp://evil[.]top`), runs offline heuristics (brand impersonation with typo/homoglyph
detection, IDN/mixed scripts, raw IP, `@` trick, suspicious TLD, deep subdomains, APK
downloads, shorteners, user-content hosting), then in parallel: SSRF-safe page fetch (expands
redirects/meta-refresh, reads title/forms, TLS info), RDAP domain age, Google Safe Browsing,
VirusTotal, URLhaus, imported phishing feeds and community reports. Verdicts are cached by level
(critical/high 6h, medium 1h, low 30min, safe 12h, unknown 10min, any source error ≤10min) and
invalidated when a report about the host arrives.

### `POST /v1/check/text`

```bash
curl -s localhost:4200/v1/check/text -H 'content-type: application/json' -d '{
  "text": "Đây là Công an quận 1, anh liên quan vụ án rửa tiền, chuyển tiền vào tài khoản tạm giữ STK 0011004123456 Vietcombank",
  "channel": "zalo",
  "sender": "+84 899 123 456"
}'
```

`channel`: `sms|zalo|messenger|email|telegram|facebook|other`. `sender` (phone or SMS
brandname) is checked too; a message sent as a bank brandname but linking elsewhere is flagged
(branded SMS can be spoofed with fake base stations). `storeInput: true` opts into saving the raw
text in history.

Pipeline: entity extraction (URLs incl. bare/defanged domains, VN phones in `+84/84/0` forms,
1800/1900, foreign numbers, bank accounts with bank names and holder names, emails) → each
entity is checked (≤3 per type) → Vietnamese rule engine (≥25 scam scripts + manipulation
tactics, matching with/without diacritics, teencode, leetspeak, split letters, negation-aware)
→ LLM analysis through the gateway (strict zod schema: `scam_type`, `tactics`, `red_flags` with
verbatim quotes, `confidence`), bounded as described in [Scoring](#scoring).

### `POST /v1/check/phone`

```bash
curl -s localhost:4200/v1/check/phone -H 'content-type: application/json' -d '{"phone":"+84 98 765 4321"}'
```

Carrier by original prefix (Viettel, VinaPhone, MobiFone, Vietnamobile, Gmobile, Itel,
Reddi/Wintel; numbers can be ported), fixed-line area codes, 1800/1900, short codes, foreign
numbers (extra weight for regions with known scam compounds), community reports.

### `POST /v1/check/bank-account`

```bash
curl -s localhost:4200/v1/check/bank-account -H 'content-type: application/json' \
  -d '{"accountNumber":"1903 4567 8901 23","bankName":"Techcombank"}'
```

Community reports only. We have **no access** to bank, NAPAS or SIMO systems: account holders are
not verified, and the verdict says so in `sources`.

### `POST /v1/check/email`

```bash
curl -s localhost:4200/v1/check/email -H 'content-type: application/json' -d '{"email":"vietcombank.hotro@gmail.com"}'
```

Disposable providers, MX presence, brand lookalike domains, free webmail claiming to be a
bank/agency, official domains, community reports.

### `POST /v1/check/image` · `/v1/check/video` · `/v1/check/audio`

```bash
# upload (multipart field "file", ≤ SAFE_MAX_UPLOAD_MB, default 20MB)
curl -s localhost:4200/v1/check/image -F file=@photo.jpg
# or by URL (downloaded through the SSRF-safe fetcher)
curl -s localhost:4200/v1/check/image -H 'content-type: application/json' -d '{"url":"https://example.com/a.png"}'
```

Local forensics: EXIF (camera, `Software`), XMP (`CreatorTool`, `softwareAgent` history,
`Iptc4xmpExt:DigitalSourceType`), IPTC-IIM, **C2PA / Content Credentials** (JUMBF in JPEG APP11,
PNG `caBX`, WebP/WAV `C2PA`, MP4/HEIC `uuid` box: claim generator, AI digital-source-type actions,
certificate subject hints; **signatures are not validated**), PNG `tEXt/zTXt/iTXt` generation
parameters (Stable Diffusion, ComfyUI, NovelAI…), ID3 / MP4 encoder atoms, generator-typical
dimensions. Optional external detectors (Hive, Sightengine, Reality Defender) when keys are set.
Format is detected from magic bytes; sending a video to `/image` is a 400.

### `POST /v1/check/ai-text`

```bash
curl -s localhost:4200/v1/check/ai-text -H 'content-type: application/json' -d '{"text":"…at least 200 characters…"}'
```

Stylometry (stock phrases, sentence-length burstiness, chatbot formatting, informal markers) +
optional LLM judge. Low confidence by design: capped at score 60 / level `medium`, wording never
accusatory, texts under 200 characters → `unknown`.

### Community reports

```bash
# anonymous allowed (rate-limited per IP); deduplicated per reporter
curl -s localhost:4200/v1/reports -H 'content-type: application/json' -d '{
  "type": "phone",                     // phone | bank_account | url | email | social_profile
  "value": "0901234567",
  "category": "impersonation_authority",
  "description": "Gọi xưng công an, đòi chuyển tiền",
  "evidenceUrls": ["https://imgur.com/abc"],
  "evidenceImages": [{ "contentType": "image/png", "dataBase64": "iVBORw0…" }],   // ≤3 × 1MB, admin-only
  "amountLostVnd": 5000000,
  "bankName": "Techcombank"            // bank_account only
}'
# → 201 {id,status:"pending",deduplicated:false,message{vi,en}}  | 200 when the same reporter re-reports

curl -s localhost:4200/v1/reports/rpt_…/votes -H 'content-type: application/json' -d '{"vote":"confirm"}'   # or "dispute"
curl -s 'localhost:4200/v1/reports/stats?days=7'      # public aggregates: top categories, totals, checks run
```

Categories: `impersonation_authority, impersonation_bank, impersonation_utility,
impersonation_relative, job_task, investment, loan, prize, delivery, ecommerce, romance, charity,
emergency, credential_theft, malware, recovery, account_trade, phishing_link, gambling, spam,
other` (labels in `src/reports/categories.ts`). Stats never expose reported values.

URL reports match checks by host, except on user-content platforms and shorteners
(facebook.com, sites.google.com, bit.ly…), where the path identifies the scammer.

### History (signed-in users)

```bash
curl -s 'localhost:4200/v1/checks?limit=20&kind=text' -H "authorization: Bearer $INTERNAL_TOKEN" -H 'x-org-id: org_…' -H 'x-user-id: usr_…'
curl -s localhost:4200/v1/checks/chk_… -H "authorization: Bearer $INTERNAL_TOKEN" -H 'x-org-id: org_…'
```

Also available to API keys (org-scoped). Pagination: `before=<createdAt>` from `nextBefore`.

### Public metadata

```bash
curl -s localhost:4200/v1/brands     # protected brands and their official domains
curl -s localhost:4200/v1/pricing    # per-check prices and free-tier limits
curl -s localhost:4200/health
```

### Admin (internal token, no org needed)

```bash
H="authorization: Bearer $INTERNAL_TOKEN"
curl -s "localhost:4200/admin/reports?status=pending&type=phone&limit=50" -H "$H"
curl -s localhost:4200/admin/reports/rpt_… -H "$H"                          # report + evidence metadata + summary
curl -s localhost:4200/admin/reports/rpt_…/evidence/evd_… -H "$H" -o shot.png
curl -s localhost:4200/admin/reports/rpt_…/moderate -H "$H" -H 'content-type: application/json' -d '{"status":"verified","note":"…"}'
curl -s -X POST localhost:4200/admin/feeds/import -H "$H"                   # run the PhishTank/OpenPhish import now
curl -s localhost:4200/admin/brands -H "$H"
curl -s -X PUT localhost:4200/admin/brands/vietcombank -H "$H" -H 'content-type: application/json' \
  -d '{"officialDomains":["new-official-domain.vn"],"keywords":[{"k":"vcbneo","mode":"substring"}]}'
# new brand: {"name":"…","category":"bank","officialDomains":["…"]}; disable: {"disabled":true}
```

### Telegram bot: `POST /channels/telegram`

Users forward a suspicious message, link, phone number or screenshot caption to the bot and get a
short Vietnamese verdict (emoji level, top reasons, what the scammer wants, what to do, police
warning note). In groups the bot only answers `/check …`. Replies are returned in the webhook
response (`method: sendMessage`, HTML, link previews off, links defanged), so no outbound call
is needed. Requires `TELEGRAM_WEBHOOK_SECRET`; register the webhook with:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d url=https://safe.example.com/channels/telegram -d secret_token=$TELEGRAM_WEBHOOK_SECRET
```

## Free tier, billing and auth

| caller                        | quota                                                                                                                           | charged                                                                             | LLM billed to          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------- |
| anonymous (per IP)            | `SAFE_ANON_DAILY_CHECKS` (30) checks + `SAFE_ANON_DAILY_MEDIA` (5) media checks per day; `SAFE_ANON_DAILY_REPORTS` (10) reports | free                                                                                | `SAFE_PLATFORM_ORG_ID` |
| Telegram (per chat)           | `SAFE_TELEGRAM_DAILY_CHECKS` (30)                                                                                               | free                                                                                | `SAFE_PLATFORM_ORG_ID` |
| console user (internal token) | `SAFE_INTERNAL_DAILY_CHECKS` (500) per org                                                                                      | free                                                                                | `SAFE_PLATFORM_ORG_ID` |
| API key                       | key's own rate/spend limits                                                                                                     | per check via `core.debit(org, price, { product: 'safe', ref: checkId, apiKeyId })` | the caller's org       |

Days reset at midnight Vietnam time (UTC+7). Quotas are stored in Postgres (`safe.rate_limits`)
keyed by salted SHA-256 of the IP/chat id. `X-Forwarded-For` is used only when
`TRUST_PROXY=true`, taking the entry `TRUST_PROXY_HOPS` from the right (the one your proxy added;
the leftmost entry is client-controlled).

Default prices (micro-USD, override with `SAFE_PRICES='{"url":1500}'`): url/text/phone/bank_account/email
**1,000** ($0.001), ai_text **2,000**, image/video/audio **10,000** ($0.01). Cached results cost the
same. A check that fails on our side, or rejects its input, is refunded (`kind: refund`).
Without `SAFE_PLATFORM_ORG_ID` or `GATEWAY_URL`, free checks simply skip the LLM step.

## Data sources and environment variables

All variables are optional except where noted; `src/env.ts` is authoritative.

| variable                                                               | default                       | purpose                                                        |
| ---------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------- |
| `PORT`                                                                 | 4200                          |                                                                |
| `DATABASE_URL`                                                         | `memory://`                   | Postgres URL, `memory://` (PGlite) or `pglite:///path`         |
| `INTERNAL_TOKEN`                                                       | dev value                     | console + admin auth; also used to call the gateway            |
| `GATEWAY_URL`                                                          | –                             | e.g. `http://localhost:4000/v1`; unset → LLM `skipped`         |
| `SAFE_LLM_MODEL` / `SAFE_LLM_TIMEOUT_MS`                               | `gpt-4o-mini` / 20000         |                                                                |
| `SAFE_PLATFORM_ORG_ID`                                                 | –                             | org billed for free checks' LLM usage                          |
| `TRUST_PROXY` / `TRUST_PROXY_HOPS`                                     | false / 1                     | client IP from `X-Forwarded-For`                               |
| `SAFE_ANON_DAILY_CHECKS` / `_MEDIA` / `_REPORTS`                       | 30 / 5 / 10                   | free tier                                                      |
| `SAFE_INTERNAL_DAILY_CHECKS` / `SAFE_TELEGRAM_DAILY_CHECKS`            | 500 / 30                      |                                                                |
| `SAFE_PRICES`                                                          | –                             | JSON price overrides                                           |
| `SAFE_FETCH_ENABLED` / `_TIMEOUT_MS` / `_MAX_BYTES` / `_MAX_REDIRECTS` | true / 5000 / 524288 / 5      | landing-page fetcher                                           |
| `SAFE_MAX_UPLOAD_MB`                                                   | 20                            | media uploads and media-by-URL                                 |
| `SAFE_RDAP_ENABLED` / `SAFE_RDAP_BASE_URL`                             | true / `https://rdap.org`     | domain age (no key)                                            |
| `GOOGLE_SAFE_BROWSING_API_KEY`                                         | –                             | Safe Browsing Lookup API v4                                    |
| `VIRUSTOTAL_API_KEY`                                                   | –                             | VirusTotal v3 URL reports (read-only, no submissions)          |
| `URLHAUS_AUTH_KEY`                                                     | –                             | abuse.ch URLhaus                                               |
| `OPENPHISH_FEED_URL`                                                   | –                             | e.g. `https://openphish.com/feed.txt` (community feed, no key) |
| `PHISHTANK_APP_KEY`                                                    | –                             | PhishTank `online-valid.json`                                  |
| `SAFE_FEED_IMPORT_INTERVAL_MIN`                                        | 0                             | >0 runs the feed import job in-process                         |
| `HIVE_API_KEY`                                                         | –                             | Hive AI-generated / deepfake detection                         |
| `SIGHTENGINE_API_USER` / `SIGHTENGINE_API_SECRET`                      | –                             | Sightengine `genai` / `deepfake`                               |
| `REALITY_DEFENDER_API_KEY` / `REALITY_DEFENDER_MAX_WAIT_MS`            | – / 20000                     | Reality Defender                                               |
| `TELEGRAM_WEBHOOK_SECRET`                                              | –                             | enables `/channels/telegram`                                   |
| `SAFE_FINGERPRINT_SALT`                                                | derived from `INTERNAL_TOKEN` | salt for IP / reporter hashes                                  |
| `SAFE_CORS_ORIGINS`                                                    | –                             | comma-separated browser origins for `/v1/*`                    |

What we do **not** have: access to bank / NAPAS / SIMO account data, police databases or carrier
subscriber data. Phone and account verdicts rely on number structure plus our own community
reports.

## Verified vs unverified integrations

"Verified" = exercised end-to-end in this repo's tests or against the real thing. External
providers are implemented against public docs and fixture-tested only (`verified: false` in code).

| component                                                       | status                     | notes                                                                                                                  |
| --------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| SSRF-safe fetcher (Node transport, DNS pinning)                 | ✅ verified                | unit tests + real HTTP server on loopback (policy override in test only)                                               |
| Brand impersonation, URL heuristics, page analysis              | ✅ verified                | offline, deterministic                                                                                                 |
| Vietnamese rule engine, entity extraction, phone parsing        | ✅ verified                | 28 scam + 16 benign samples                                                                                            |
| Scoring, verdict schema, wording policy                         | ✅ verified                |                                                                                                                        |
| Community reports, moderation, votes, stats, cache invalidation | ✅ verified                | PGlite                                                                                                                 |
| Free tier limits, per-check billing via `core.debit`, refunds   | ✅ verified                | PGlite + `@ok/core`                                                                                                    |
| LLM analysis / AI-text judge                                    | ✅ verified with `MockLlm` | gateway model output quality not evaluated                                                                             |
| EXIF / XMP / IPTC / PNG chunks / ID3 / MP4 atoms                | ✅ verified                | synthetic fixtures generated in tests                                                                                  |
| C2PA manifest parsing                                           | ⚠️ partially               | parses synthetic JUMBF/CBOR; real-world manifests (Adobe, OpenAI, Google) not yet tested; signatures **not** validated |
| Telegram webhook                                                | ⚠️ partially               | update parsing + reply formatting tested; not tried with a live bot                                                    |
| RDAP                                                            | ❌ unverified              | fixture-tested; many ccTLDs (incl. `.vn`) may not publish RDAP → `skipped`                                             |
| Google Safe Browsing v4                                         | ❌ unverified              | fixture-tested                                                                                                         |
| VirusTotal v3                                                   | ❌ unverified              | fixture-tested                                                                                                         |
| URLhaus                                                         | ❌ unverified              | fixture-tested                                                                                                         |
| PhishTank / OpenPhish import                                    | ❌ unverified              | parsers fixture-tested                                                                                                 |
| Hive / Sightengine / Reality Defender                           | ❌ unverified              | request building + response parsing fixture-tested                                                                     |

## Privacy

- **History stores hashes**, not content: `safe.checks.input_hash` (SHA-256), a short
  non-sensitive preview (host only for URLs, masked numbers), and a **redacted verdict** for text /
  AI-text (no message, no quotes in evidence, no extracted entities). Raw text is stored only when
  the caller sends `storeInput: true`.
- Anonymous checks are recorded without org/user ids (aggregate stats only). IPs and Telegram chat
  ids are stored only as salted hashes, for rate limiting and report dedupe.
- URL verdicts are cached with the full URL (needed to answer). Query strings are kept because
  phishing links differ by token; cache entries expire within hours.
- User URLs are **never** sent to phishing-feed providers (feeds are imported locally).
  VirusTotal is read-only (we never submit URLs). Google Safe Browsing and URLhaus receive the URL
  only when their keys are configured.
- Media is processed in memory and not stored. It is uploaded to Hive / Sightengine / Reality
  Defender **only** when their keys are set; operators must disclose this to users.
- Report evidence images are visible only through admin routes; public stats are aggregates.
- The LLM receives the message text through the platform gateway (billed to the platform org for
  free checks), wrapped as untrusted data.

## Security: the SSRF-safe fetcher

`src/net/safe-fetch.ts` + `src/net/node-transport.ts`, used for landing pages and media-by-URL:

- only `http`/`https`, ports 80/443/8080/8443, credentials and fragments stripped, internal-looking
  hostnames (`localhost`, `*.internal`, `*.local`, single-label) refused;
- DNS resolved by us; **any** private/loopback/link-local/CGNAT/metadata/multicast/reserved
  answer blocks the request, including IPv6 (ULA, link-local, IPv4-mapped, NAT64, 6to4, Teredo);
- the socket connects to the **exact validated address** (custom `lookup`), so DNS rebinding
  between check and connect is impossible; every redirect / meta-refresh hop is re-resolved and
  re-validated (max 5);
- one 5s deadline for the whole chain, 512KB body cap (decompression capped too), no cookies sent
  or kept, TLS certificates verified (invalid certs become a signal).

## Development

```bash
pnpm --filter @ok/safe dev          # tsx watch, port 4200, in-memory PGlite
pnpm --filter @ok/safe test         # offline: PGlite, MockLlm, fake DNS/transport, strict fetch mock
pnpm --filter @ok/safe typecheck
pnpm --filter @ok/safe build        # dist/index.js (workspace packages bundled)
DATABASE_URL=memory:// PORT=4997 node apps/safe/dist/index.js
```

Layout: `src/app.ts` (routes, `createApp(deps)`), `src/service.ts` (check orchestration),
`src/verdict/*` (schema, scoring, wording), `src/net/*` (SSRF guard), `src/url/*` (brands,
heuristics, page analysis), `src/rules/*` (Vietnamese scam patterns), `src/text/entities.ts`,
`src/phone`, `src/bank`, `src/email`, `src/media/*` (containers, C2PA, forensics, detectors),
`src/aitext`, `src/llm`, `src/reports`, `src/sources/*` (reputation APIs, feeds),
`src/billing/*`, `src/store/*` (cache, history), `src/channels/telegram.ts`, `src/db/*`
(Drizzle schema + hand-written SQL migrations in `pgSchema('safe')`).

## Known limitations

- No OCR: screenshots must be accompanied by their text (the Telegram bot asks for it).
- C2PA signatures and hash bindings are not validated (claims and presence only).
- Official hotline numbers are not curated yet (avoids publishing wrong numbers); add via a
  future overrides table.
- Brand official-domain list is curated and conservative; extend it with `PUT /admin/brands/:id`.
  Legitimate businesses whose domain contains a protected brand word but are not listed (some
  subsidiaries, resellers) are rated "medium" (a bare brand word on `.vn` weighs 10 points less
  than on cheap TLDs, because `.vn` registration requires identity documents).
- The in-memory API-key rate limiter in `@ok/core` is per replica.
- Province names for landline area codes are the pre-July-2025 names.
