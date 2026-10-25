# AI/LLM Gateway Market (OpenRouter-style unified APIs): Competitors, Pain Points and Micro-Differentiators (state as of late Oct 2026)

> Method note for the report writer: research was done on 2026-10-25 through a web-search tool that returns summarized results. Direct page fetches (WebFetch/curl) were blocked by the session's egress proxy for every target host (openrouter.ai, truefoundry.com, llmgateway.io, etc.), and the shared web-search budget ran out after about 30 queries. So: (a) most citations below point to the page the search engine summarized. They were not re-read in full. (b) Reddit, Discord, VOZ, Viblo and J2TEAM threads did not surface in search, so community sentiment comes mainly from Hacker News, Trustpilot, LessWrong, X and Chinese and Vietnamese blogs. (c) Many 2026 comparison articles come from competing gateway vendors (TrueFoundry, OrcaRouter, Maxim/Bifrost, FutureAGI, Zuplo, standardcompute). Those are flagged where it matters.

## 1. Who the main players are in 2026, how each positions itself, and how each charges (fees on credits, BYOK fees, markups, minimums, expiry, refunds)

### Takeaway
The market has split into three groups:
- **Hosted pay-as-you-go marketplaces** that charge a fee on credit purchases: OpenRouter (5.5%), Cloudflare Unified Billing (5%) and Requesty (5% on usage).
- **"Zero-markup" platform gateways** that make their money elsewhere: Vercel and Helicone.
- **Enterprise control planes** that have been, or are being, absorbed by security, infrastructure or docs companies: Portkey went to Palo Alto Networks and Helicone to Mintlify. Kong prices per request and per model, and LiteLLM is open source with an enterprise paywall.

Several "smart router" startups have died or pivoted (Unify, OpenPipe, Roo Code Router, TensorZero; Martian and Glama moved on). In Asia, the low end is a long tail of new-api/one-api-based "relay stations" (中转站). Vietnamese resellers clone that model, selling in VND through VietQR and MoMo at large discounts. Some of them advertise VAT invoices.

### Cited Findings

**OpenRouter (the reference player)**
- **Fee on credits:** 5.5% on credit purchases with a $0.80 minimum on the Standard tier. This structure came from OpenRouter's June 2025 post, which also removed the old fixed $0.35 Stripe fee. Third-party 2026 pricing indexes report the same numbers. — [OpenRouter blog: Simplifying our platform fee](https://openrouter.ai/blog/simplifying-our-platform-fee); [flexprice.io OpenRouter pricing index](https://flexprice.io/pricing-index/openrouter)
- **Crypto:** reported as a flat 5% fee. — [flexprice.io](https://flexprice.io/pricing-index/openrouter)
- **Business tier (new, about week 38 / mid-Sept 2026):**
  - The fee is 8%, charged on credit purchases. Inference is still billed at provider rates.
  - It includes EU and US in-region routing, zero data retention, a signed DPA on request, and a limit of 1,000 workspaces.
  - Post-paid invoicing is "No" for Business and "Yes" only for Enterprise, which buys through a sales contract. Non-Enterprise plans pay by "credit card, crypto & more".
  - SSO and SCIM are Enterprise-only. Business gets email support; Enterprise gets a dedicated support team.
  - Sources: [OpenRouter Business page](https://openrouter.ai/business); [OpenRouter pricing.md](https://openrouter.ai/pricing.md); [PricingSaaS diff 2026W38: "OpenRouter adds Business tier: 8% fee, 1,000-workspace limit, signed DPA"](https://pricingsaas.com/companies/openrouter/diffs/2026W38)
- **BYOK, sources conflict:**
  - TrueFoundry (published Oct 9, 2026) and flexprice say BYOK costs 5% of list-price usage, with the first $25,000 per month free on Standard and Business. TrueFoundry adds that the fee is deducted from OpenRouter credits, so you need a credit balance even when using BYOK.
  - TrueFoundry also says the old "first 1M BYOK requests/month free" offer was retired on July 14, 2026, and that some OpenRouter docs pages still show it.
  - OpenRouter's own 2025 post said the 5% BYOK fee would eventually be replaced by a fixed monthly subscription.
  - I found no official 2026 OpenRouter page confirming the $25k allowance.
  - Sources: [TrueFoundry: OpenRouter BYOK explained](https://www.truefoundry.com/blog/openrouter-byok-explained-cheaper-often-faster-and-changing); [OpenRouter blog](https://openrouter.ai/blog/simplifying-our-platform-fee)
- **Credit expiry:** the ToS says OpenRouter "reserves the right to expire unused credits 365 days after purchase". Analysts note that the "reserves the right" wording leaves it unclear whether expiry is automatic. Unused credits are lost when an account is deleted. — [ConductAtlas ToS provision: credits expire after 365 days](https://conductatlas.com/platform/openrouter/openrouter-terms-of-service/credits-expire-after-365-days/); [QCode: Do AI API credits expire?](https://qcode.cc/en/ai-api-credits-expiry)
- **Refunds:**
  - Unused credits can be refunded only if requested within 24 hours of purchase. Promotional credits are never refundable.
  - If an account is terminated for a ToS violation, remaining credits are forfeited. Other terminations are refunded to the original payment method within 30 days.
  - Runaway loops or code that made many API calls do not qualify for a refund.
  - Sources: [OpenRouter Terms](https://openrouter.ai/terms); [ConductAtlas: 24-hour refund window](https://conductatlas.com/platform/openrouter/openrouter-terms-of-service/provision/CA-P-064012/24-hour-refund-window-for-unused-credits/); [OpenRouter Zendesk: Payment Issues](https://openrouter.zendesk.com/hc/en-us/articles/41976886293403-Payment-Issues-Common-Fixes)
- **Minimum purchase:** reported as $5. — [Pinggy: free AI model APIs on OpenRouter](https://pinggy.io/blog/free_ai_model_apis_unlimited_tokens_openrouter/)
- **Free models (`:free`):**
  - Capped at 20 requests per minute.
  - Accounts that have bought fewer than 10 credits get 50 requests per day. Accounts that have bought at least 10 credits get 1,000 per day.
  - The threshold counts lifetime purchases, not current balance, and it persists after the balance hits zero. Two $5 purchases appear to count the same as one $10 purchase.
  - A negative balance can cause 402 errors, even on free models.
  - Sources: [OpenRouter docs: Limits](https://openrouter.ai/docs/api-reference/limits); [TrueFoundry: OpenRouter rate limits, your free tier depends on what you've already paid](https://www.truefoundry.com/de/blog/openrouter-rate-limits-your-free-tier-depends-on-what-youve-already-paid)
- **Funding (unverified, secondhand):** OpenRouter was reportedly in talks to raise $120M at a $1.3B valuation with Google as lead, per Inc. Martian was reportedly "nearing the same number". — [bestaiweb: $3B LLM Router Race](https://www.bestaiweb.ai/openrouter-martian-and-not-diamond-the-2026-llm-router-race-and-where-agent-cost-optimization-is-heading/)

**Vercel AI Gateway**
- **Pricing:** zero markup on tokens at provider list price, including BYOK, on both the free and paid tiers. — [Vercel docs: AI Gateway pricing](https://vercel.com/docs/ai-gateway/pricing); [Vercel AI Gateway FAQ](https://vercel.com/docs/ai-gateway/faq)
- **Free credits:**
  - Every team gets $5 of AI Gateway credits every 30 days, starting from its first request.
  - The free allowance stops once you buy paid credits.
  - Purchased credits expire one year after purchase, and the user bears payment-processing fees.
  - Vercel's pages disagree on whether free credits cover the whole catalog or only a subset of models with lower rate limits.
  - Sources: [Vercel docs: usage and pricing](https://vercel.com/docs/ai-gateway/usage-and-pricing); [Vercel Academy: AI Gateway pricing](https://vercel.com/academy/ai-gateway/ai-gateway-pricing)
- **ZDR surcharge (unverified on Vercel's own pages):** a third-party blog (Aug 2026) flags $0.10 per 1,000 requests for team-wide Zero Data Retention. — [MintMCP: Vercel AI Gateway pricing](https://www.mintmcp.com/blog/vercel-ai-gateway-pricing)

**Cloudflare AI Gateway**
- **Unified Billing:** one prepaid credit balance with a 5% fee on credit purchases (a $100 top-up bills $105). As of Aug 7, 2026 the same balance also pays for Workers AI. — [Cloudflare changelog 2026-08-07: Workers AI unified billing](https://developers.cloudflare.com/changelog/post/2026-08-07-workers-ai-unified-billing/); [flowith: Cloudflare AI Gateway unified billing credits & rate limits (Aug 12, 2026)](https://flowith.io/blog/cloudflare-ai-gateway-unified-billing-credits-rate-limits/)
- **Rate limits:** frontier Workers AI models paid with credits get 50 requests per minute per account per model, versus 20 under standard Workers AI billing. — [releases.sh summary of Cloudflare release](https://releases.sh/release/rel_yV4w4XuoHG9mCgipvw5Wb-cloudflare-unifies-workers-ai-and-ai-gateway-access-billing-and-rate-limits)
- **Spend caps:** an infrastructure-as-code tool's June 2026 release notes are titled "AI Gateway Spend Caps", which suggests Cloudflare exposes spend caps. I did not read the details. — [Alchemy 2.0.0-beta.55](https://alchemy.run/blog/2026-06-11-beta-55/)

**Requesty**
- **Pricing:**
  - Free tier of 200 requests per day with no card.
  - Paid usage carries a 5% fee on top of model cost, with "no seats, no tiers, no minimum".
  - BYOK is on the pay-as-you-go plan. Whether BYOK traffic pays the 5% is not stated anywhere I could find.
  - Enterprise has custom volume discounts and committed spend.
  - Sources: [Requesty pricing](https://www.requesty.ai/pricing-new); [Developers Digest: Requesty](https://www.developersdigest.tech/llm-gateways/requesty)

**Portkey**
- **Acquisition:** Palo Alto Networks announced it would acquire Portkey around Apr 30, 2026 and closed on May 29, 2026. Portkey becomes the AI gateway inside Prisma AIRS, positioned as a "control plane for autonomous enterprise agents". Existing customers will continue to be supported. Portkey had raised a $15M Series A (Elevation, Lightspeed). — [Pulse 2.0](https://pulse2.com/palo-alto-networks-to-acquire-portkey-to-establish-ai-gateway-as-control-plane-for-autonomous-enterprise-agents/amp/); [NAND Research](https://nand-research.com/palo-alto-networks-portkey-acquisition-anchors-its-agentic-security-stack/); [Entrepreneur India](https://india.entrepreneur.com/business-news/palo-alto-networks-to-acquire-portkey-to-boost-ai-security)
- **Pricing (third-party, competitor-authored):**
  - Developer tier is free for about 10k logs per month with 30-day retention.
  - Pro starts at 100k logs and scales to 3M, at $9 per extra 100k logs.
  - Enterprise starts at 10M+ logs and is quote-based.
  - When you hit the log limit, the gateway keeps routing but stops recording new requests in observability.
  - The gateway core is open source and can be self-hosted.
  - Sources: [TrueFoundry: Portkey pricing guide](https://www.truefoundry.com/blog/portkey-pricing-guide); [Braintrust: Portkey alternatives 2026](https://www.braintrust.dev/articles/portkey-alternatives-2026)

**LiteLLM**
- **Model:** the open-source proxy is free. An Enterprise license adds SSO, SAML, audit logs and SLAs. Reviewers say SSO, RBAC and team-level budget enforcement sit behind that paywall. The proxy needs Postgres for virtual keys and spend tracking, plus Redis for multi-instance rate limits. — [TrueFoundry LiteLLM review 2026](https://www.truefoundry.com/blog/a-detailed-litellm-review-features-pricing-pros-and-cons-2026); [Wavect: Self-host LiteLLM 2026](https://wavect.io/blog/self-host-litellm-production-2026/)

**Helicone**
- **Acquisition:** acquired by Mintlify in March 2026. The hosted product is now in maintenance mode: security fixes, new model support and bug fixes continue, but no major new features are planned. — [devtune.ai Helicone profile](https://devtune.ai/verticals/llm-observability-evals-gateways/helicone); [vantaige.io](https://vantaige.io/ai-tool/helicone)
- **Pricing:**
  - Hobby is free: 10k requests per month, 1 GB, 7-day retention.
  - Pro is $79 per month and Team is $799 per month.
  - One source lists the gateway at 0% markup; I could not verify that.
  - The Rust AI Gateway is GPL-3.0 and labeled "Public Beta".
  - Sources: [PricingSaaS: Helicone](https://pricingsaas.com/companies/helicone); [Developers Digest: Helicone](https://www.developersdigest.tech/llm-gateways/helicone)

**Kong AI Gateway**
- **Pricing (third-party figures conflict):**
  - Konnect is quoted at about $34.25 per 1M requests on consumption billing in one set of sources, and about $200 per extra 1M after the first 1M in another.
  - The AI Gateway part is about $100 per model-month (up to 5 models), or about $105 per month per "Gateway Service".
  - Typical Konnect deployments are estimated at $500–2,500 per month.
  - Kong's rate card has changed several times.
  - Sources: [Zuplo: true cost of Kong](https://zuplo.com/learning-center/the-true-cost-of-kong-tco-analysis.md); [TrueFoundry: Kong pricing 2026](https://truefoundry.com/blog/kong-gateway-pricing-architecture-an-analysis-for-ai-teams-2026-edition); [guptadeepak: top 5 AI gateways 2026](https://guptadeepak.com/tools/top-5-ai-gateways-2026/)

**Smart routers: Martian, Not Diamond, Unify (consolidation and churn)**
- **Discontinued and pivoted gateways (one third-party tracker, checked Oct 13, 2026):**
  - Unify's router is gone. Dated Oct 7, 2026, Unify "now sells continual learning for agents", and its old repos are archived.
  - OpenPipe's inference and Roo Code Router are gone.
  - TensorZero is "no longer maintained".
  - Glama's and Martian's gateways "still answer while both companies have moved on to other products".
  - I found no press coverage confirming these changes.
  - Source: [standardcompute: What happened to Unify, TensorZero, OpenPipe, Glama, Martian and Roo Code Router?](https://standardcompute.com/alternatives/discontinued-ai-gateways)
- **Martian:** Accenture invested in 2024 and Martian raised $9M. A 2026 guide still describes it as offering a Model Router and Gateway with integrations for agent coding tools. That conflicts with the tracker above. — [Accenture newsroom](https://newsroom.accenture.com/news/2024/accenture-invests-in-martian-to-bring-dynamic-routing-of-large-language-queries-and-more-effective-ai-systems-to-clients); [qveris: Martian alternatives 2026](https://qveris.ai/guides/martian-llm-router-alternatives)
- **Not Diamond:** raised $2.3M (seed closed July 2024) and was the earliest router to list on OpenRouter. A vendor-critical 2026 post says it ranks 12th of 12 on RouterArena; I could not verify that. — [VentureBeat](https://venturebeat.com/ai/not-diamond-automatically-routes-your-query-to-the-best-llm); [Substack: NotDiamond meta-model bet](https://henrymichaelson1.substack.com/p/notdiamond-the-meta-model-bet-on); [OrcaRouter: Not Diamond vs Martian](https://www.orcarouter.ai/blog/not-diamond-vs-martian)

**Asian and Chinese relays**
- **AIHubMix:**
  - Gives a permanent free testing quota and charges pay-as-you-go with tiered volume discounts and no monthly fee.
  - A competitor claims AIHubMix adds no markup.
  - Reported model counts range from 500+ to 849, and it advertises 99.93% availability.
  - The effective price varies by which upstream it picks.
  - Sources: [eggstriker AiHubMix review](https://www.eggstriker.com/en/ai-api/aihubmix); [OrcaRouter: AIHubMix alternatives](https://www.orcarouter.ai/blog/aihubmix-alternatives); [AIHubMix](https://aihubmix.com/)
- **OhMyGPT:**
  - Minimum pay-as-you-go deposit is $4, and new users get free credits.
  - Cost is set by a pricing multiplier that can vary by model and time of day.
  - Reviewers note that model-authenticity checks, refund policy and invoicing are undocumented.
  - Sources: [HowToken: OhMyGPT review](https://howtoken.net/station/www-ohmygpt-com); [apinav OhMyGPT](https://www.apinav.net/sites/ohmygpt)
- **SiliconFlow:** Artificial Analysis lists 36 models. Small open models start around $0.04–0.10 per M input tokens. Its listings show precision explicitly, for example "Kimi K2.6 (FP8)". I found no information on international payment methods. — [Artificial Analysis: SiliconFlow](https://artificialanalysis.ai/providers/siliconflow); [pricepertoken SiliconFlow](https://pricepertoken.com/endpoints/siliconflow)
- **Relay architecture, the template VN resellers copy:**
  - Most Chinese relays run new-api (AGPLv3), a fork of one-api (MIT).
  - Operators load upstream keys as "channels" and issue their own tokens to users.
  - Billing is roughly (input + output × completion ratio) × model ratio × group ratio, so the price shown is whatever multiplier (倍率) the operator sets.
  - Some sites inflate the base price to make a low multiplier look like a deal.
  - Built-in features include multi-channel load balancing (auto-switching when a key is rate-limited) and model mapping, which can route a request for an expensive model to a cheaper one.
  - Sources: [SSD Nodes: one-api billing multipliers & quota math](https://www.ssdnodes.com/learn/lang/zh-hans/one-api-billing-multipliers-and-quota-math); [80aj: API proxy mechanism (Jun 2026)](https://www.80aj.com/2026/06/07/api-proxy-mechanism/); [V2EX thread](https://www.v2ex.com/t/1201876); [deepseek.csdn.net](https://deepseek.csdn.net/6a7a7435662f9a54cb9b00a2.html)
- **Black market:** commentary describes Claude offered at 70–93% below official prices, pooled Claude Max accounts and payment fraud. This is secondhand. — [explainx: AI Token Black Market](https://explainx.ai/blog/ai-token-black-market-claude-resellers-distillation-2026)

**Vietnamese resellers (claims are self-published by the sellers)**
- **apigiare.vn:** advertises 30–60% savings versus buying direct, VietQR top-up with no international card needed, 40+ providers and one key for many models. — [apigiare.vn](https://apigiare.vn/?lng=vi)
- **FRIDAY AI:** accepts MoMo, bank transfer, USDT and international cards. Its page lists "Claude Opus 4.6" at $10 per M input tokens, which it presents as below official price. — [fridayaix.com](https://fridayaix.com/)
- **9Flare:** "Claude API at Vietnam prices, US speed". Takes VND through VietQR, advertises rates "from 1,709đ per $1" and mentions "Xuất VAT doanh nghiệp" (corporate VAT invoices). — [9flare.com](https://9flare.com/)
- **Stali:** 69 models, "from about 1,500đ per 1M tokens", VietQR top-up, and its page mentions "xuất hóa đơn VAT". — [api.stali.vn](https://api.stali.vn/)
- **APIZ:** minimum top-up 26,000₫ with no monthly fee. — [api.apiz.vn](https://api.apiz.vn/)
- **LIT:** credit "from 1,536đ per $1". — [apilit.dev](https://apilit.dev/)
- **Others:** APIVN, ShopAIKey (sells Claude Code keys), ApiHub247, RevidAPI. A Taphoammo (MMO marketplace) listing sells "OpenAI/Anthropic keys via intermediary server" for Claude Code, Cursor, n8n and Roo Code. — [apivn.tech](https://apivn.tech/); [shopaikey.com](https://shopaikey.com/en); [apihub247.com](https://www.apihub247.com/?type=gpt); [revidapi.com](https://revidapi.com/); [Taphoammo listing](https://taphoammo.net/gian-hang/key-openai-api-server-trung-gian-v98store-dung-uoc-cho-gpt-grok-gemini-claude_183039)
- **Uptech:** sells licensed API access to businesses with invoices and VAT, and explicitly does not sell "floating keys or proxies of unknown origin". — [Uptech: Mua Claude API key cho doanh nghiệp có VAT](https://uptech.vn/ai-store/huong-dan/mua-claude-api-key-cho-doanh-nghiep)

### Inferences
- **The fee benchmark to beat is about 5% on top-ups:** OpenRouter 5.5% (minimum $0.80), Cloudflare 5%, Requesty 5%. Vercel's "0% markup" sets the expectation at the premium end. A VN gateway that shows "0% top-up fee, VND at a published rate" directly undercuts the most visible fee line. Its discounts from direct provider deals then become the real margin, so it does not need a visible surcharge.
- **Vendor longevity is now a selling point.** Portkey became part of Palo Alto, Helicone is in maintenance mode, and Unify, OpenPipe, Roo Code Router and TensorZero are gone. Public commitments about continuity and data portability (log export, key migration) and a local legal entity can be marketed as "we will still be here".
- **VN reseller pricing implies a huge discount.** "1,536–1,709đ per $1 of credit" is about a 93–94% discount if the VND/USD market rate is about 26,000. That FX rate is my assumption and was not sourced in this session. The discount matches the "70–93% off" black-market range, which suggests those sellers use pooled subscriptions, model substitution or fraud rather than real provider deals. A legitimate gateway cannot match that price and should compete on authenticity and invoices instead.

### Gaps
- I could not read OpenRouter's official pricing or FAQ pages directly (fetch blocked), so the 2026 BYOK terms ($25k free plus 5%, versus the old 1M free requests) rest on third-party sources.
- I found no published fee schedules for Martian, Not Diamond, SiliconFlow (international payments) or Requesty BYOK.
- I could not confirm Unify's shutdown or Martian's pivot beyond one tracker.
- I could not reach the reseller sites to check their exchange rates, real model lineups or VAT terms.
- The VND/USD market rate was not sourced.

## 2. The most common user complaints (HN, Reddit, X, GitHub, Trustpilot, Chinese and VN communities)

### Takeaway
The top complaints, in order:
1. **"Same model, different results":** provider variance and suspected quantization behind a unified API. This is serious enough that researchers now say not pinning a provider can invalidate results.
2. **Billing and support friction:** top-up fees, a 24-hour refund window, credit expiry, missing credits, and no refunds for runaway loops.
3. **Caching and ZDR side effects:** cache hit rates that are lower than going direct, and ZDR settings that block some models.
4. **Key security:** October 2026 saw a wave of breaches where stored provider keys were drained.
5. **In the relay and reseller tier, model fakery:** cheap "Claude" that is really another model, and billing manipulation.

For self-hosted gateways (LiteLLM), the complaints are supply-chain and security CVEs, performance under load, and an enterprise paywall on budgets and SSO.

### Cited Findings

**Provider variance and quantization**
- HN thread "So you want to use OpenRouter?" (item 49621546, about mid-Sept 2026):
  - The top comment says providers behind OpenRouter are not interchangeable, so you must pin providers to get consistent quality, speed and reliability.
  - Commenters say some providers "are clearly running heavily quantized versions of the model because their eval performance is terrible", that providers likely serve quantized versions without disclosure, and that no per-provider benchmark data is shown.
  - They also report caching failures and unreliable providers.
  - A rebuttal: the unified interface is the point, and differences come from providers running different weights.
  - Sources: [HN 49621546](https://news.ycombinator.com/item?id=49621546); [zeli.app summary: "same model, wildly different results"](https://zeli.app/story/49621546)
- LessWrong, "Not Pinning Your OpenRouter Provider Might Invalidate Your Research":
  - OpenRouter sends requests to any available provider unless one is pinned, and provider quality varies.
  - The post cites an AI-safety paper accepted to NeurIPS whose core results were "entirely overturned" by this.
  - It says the current provider selection is "insufficient for ideal scientific reliability".
  - A July 28, 2026 update followed a response from OpenRouter staff.
  - A commenter disputes one number in the post as "~totally made up by Claude".
  - Sources: [GreaterWrong mirror](https://www.greaterwrong.com/posts/KsyoSAyBRXtwzSugg/not-pinning-your-openrouter-provider-might-invalidate-your); [LessWrong](https://www.lesswrong.com/posts/KsyoSAyBRXtwzSugg/)
- **Pinning can backfire.** A practitioner write-up describes setting `provider.order` to 2–3 "reliable" providers with `allow_fallbacks: false`, which "is exactly the setup that caused a real production outage". — [Pinggy: OpenRouter in production, provider routing pitfalls](https://pinggy.io/blog/openrouter_production_provider_routing_pitfalls/)
- **Precision labels are a weak proxy.** Providers declaring fp4 scored competitively with fp8 providers on the same model. — summarized from [Pinggy](https://pinggy.io/blog/openrouter_production_provider_routing_pitfalls/) / [devtoollab: OpenRouter provider routing](https://devtoollab.com/blog/openrouter-provider-routing)
- **OpenRouter's position:** it hasn't seen measurable tool-call quality loss from quantization alone. It attributes most variance to tool-call parsers in inference engines, "not a provider cutting corners". — [OpenRouter: Auto Exacto announcement](https://openrouter.ai/blog/announcements/auto-exacto/)

**Caching, privacy and terms**
- A 2026 HN PSA: "Don't use OpenRouter for DeepSeek V4 as it messes up your caching". Prompt caching was much lower than through the DeepSeek API. An OpenRouter representative said their testing didn't reproduce this. — [HN 48319827](https://news.ycombinator.com/item?id=48319827)
- Turning on zero-data-retention can block some models, such as DeepSeek V4 at the time. Some users object to adding another third party to their data path. — [HN 48006617](https://news.ycombinator.com/item?id=48006617)
- ToS confusion: one user said OpenRouter's terms forbid exposing access to end users. An OpenRouter representative replied that apps with end users are allowed. — [HN 47702048](https://news.ycombinator.com/item?id=47702048)
- Fee complaint (2024, older): OpenRouter passes through OpenAI and Anthropic prices but charges a fee on top-ups, so it costs more than going direct. — [HN 41449621 area](https://news.ycombinator.com/item?id=41449621)
- What users like: pay-per-token with no subscription and all frontier models in one place. — [HN 48072767](https://news.ycombinator.com/item?id=48072767)

**Billing and support (OpenRouter)**
- Trustpilot reviews (self-reported, unverified):
  - Paid but received no credits, with support silent for weeks ("Paid $55 Received $0").
  - Credits lost to expiry and requests to restore them refused.
  - Account banned after a hack.
  - Unauthorized card charges.
  - Source: [Trustpilot: OpenRouter](https://www.trustpilot.com/review/openrouter.ai)
- Refund rules that generate friction: 24 hours only, runaway loops excluded, promotional credits excluded. — [OpenRouter Terms](https://openrouter.ai/terms); [OpenRouter Zendesk](https://openrouter.zendesk.com/hc/en-us/articles/41976886293403-Payment-Issues-Common-Fixes)
- Confusing errors:
  - A negative balance returns 402 even on free models.
  - On paid models, which have no published cap, a 429 is "almost always the provider" upstream, not the gateway. Users can't easily tell which.
  - Sources: [OpenRouter docs: Limits](https://openrouter.ai/docs/api-reference/limits); [TrueFoundry rate-limit post](https://www.truefoundry.com/de/blog/openrouter-rate-limits-your-free-tier-depends-on-what-youve-already-paid)
- OpenAI comparison: a community thread titled "Credit Expired Without Notification" shows expiry without a warning is a recurring grievance across the industry. — [OpenAI community](https://community.openai.com/t/credit-expired-without-notification/1256598)

**Key security (Oct 2026)**
- OpenCode (Oct 17, 2026): a legacy Console system was breached and third-party provider keys stored in workspaces may have been exposed.
  - One user's OpenAI key was "pounded" for $281 and his Anthropic key for $168.
  - Anthropic revoked the affected keys.
  - Investor Sarah Guo wrote "that's three companies in the past week".
  - Fireworks AI found compromised internal credentials on Oct 6 and published a bulletin on Oct 9.
  - Sources: [Notebookcheck](https://www.notebookcheck.net/OpenCode-confirms-breach-as-users-report-AI-charges-they.1426957.0.html); [letsdatascience](https://letsdatascience.com/news/opencode-console-breach-exposes-linked-ai-provider-keys-5bc45ac3); [OrcaRouter: OpenCode console breach](https://orcarouter.ai/blog/2026-10-17-opencode-console-breach-api-keys)
- A dark-web claim that OpenRouter itself was breached circulated around Oct 22, 2026. It is unconfirmed, and a follow-up search found no corroboration. — [explainx: Railway hack, OpenRouter claim](https://explainx.ai/blog/railway-openrouter-attacks-ai-api-keys-stolen-what-to-do-2026)
- Malicious "alternative Claude Code" packages (claude-code-best 1.9.4, published Apr 24, 2026, and 2.0.1, published May 3, 2026) route API traffic through an intermediary. One variant rewrites `ANTHROPIC_BASE_URL` to a phishing endpoint. — [Xygeni: FauxCode](https://xygeni.io/vi/blog/fauxcode-reverse-engineered-claude-code-routes-through-attackers/)

**Self-hosted gateways (LiteLLM, Portkey, Helicone)**
- LiteLLM security:
  - Malicious PyPI releases 1.82.7 and 1.82.8 (March 2026) could steal environment and cloud credentials. Docker proxy users were not affected.
  - A critical SQL injection in API-key verification affected 1.81.16–1.83.6.
  - An MCP test-endpoint command injection affected 1.74.2–1.83.6.
  - A virtual-key privilege escalation was fixed in 1.83.14.
  - Source: [layer3labs: LiteLLM explained](https://www.layer3labs.io/guides/litellm-explained)
- LiteLLM performance (vendor-authored, not independently verified):
  - GIL-related degradation under high concurrency.
  - GitHub issue #12067: the database logging layer slows requests once there are more than 1M logs.
  - Memory leaks that need worker recycling after about 10k requests (a 2025 claim).
  - Sources: [Maxim: LiteLLM alternatives 2026](https://www.getmaxim.ai/articles/litellm-alternatives-for-production-ai-workloads-in-2026/); [dev.to Bifrost post (2025)](https://dev.to/debmckinney/best-litellm-alternative-in-2025-why-teams-are-switching-to-bifrost-1lbf)
- Portkey: 3- and 30-day log retention is called too short for compliance reviews, and its future as a standalone product is uncertain inside Prisma AIRS. — [Braintrust: Portkey alternatives 2026](https://www.braintrust.dev/articles/portkey-alternatives-2026)

**Relay and reseller tier: fake, "watered-down" (掺水) or downgraded (降智) models**
- An audit probed 8 resellers over 17 days and found 183 channels that "were not really Claude". Most were Kiro, Cascade or Codeium "wearing a Claude name tag". Routing through Bedrock, Vertex or Azure was not counted as spoofing. — [unorouter: "Your cheap Claude is probably a fake. We caught 183 of them."](https://unorouter.com/en/blog/claude-authenticity)
- Chinese detection tools and practices:
  - claude-detector runs 19 black-box probes for watered-down relays, model downgrades and inflated token counts.
  - LLMprobe-engine runs 76+ probes in 4 layers.
  - A widely repeated but unsourced claim says about 10% of relays substitute models.
  - Sources: [GitHub: claude-detector](https://github.com/7836246/claude-detector); [CSDN: LLMprobe-engine test](https://blog.csdn.net/weixin_53403266/article/details/161665196); [80aj: "model mirror" tool (Apr 2026)](https://www.80aj.com/2026/04/14/api-detection-tool-claude/)
- apiranking.com lets users test a relay with a temporary key: tokenizer fingerprint, cache behavior and billing anomalies, such as "cache not working or cached tokens billed at full price". — [apiranking: verify yourself](https://apiranking.com/verify-yourself)
- An X tutorial tested a relay's "1.5× multiplier group" and found it "seriously watered down". It noted that many "Claude Max full-power" groups only accept calls from the Claude Code client, and that ranking sites now track uptime and watering rates. — [X @Pluvio9yte](https://x.com/Pluvio9yte/status/2052552998061297804)
- Developers spot watered-down Codex relays by output format, for example missing P0/P1/P2 priority tags in code reviews. — [80aj (May 2026)](https://www.80aj.com/2026/05/12/claude-api-watermark-detection/)
- Relay risks: the balance vanishes when the site closes, prompts pass through in plaintext, and models get substituted. — [SSD Nodes: free GPT API relays](https://www.ssdnodes.com/learn/lang/zh-hans/free-gpt-api-relays-what-you-pay-with)
- Anthropic's consumer terms forbid sharing or reselling API keys. Commercial resale requires explicit approval, and there is no public reseller price tier, so deep discounts "have to come from somewhere else". — [Digital Applied: AI API reseller risk checklist](https://www.digitalapplied.com/blog/ai-api-resellers-risk-checklist)
- Free or "unlimited" keys are usually proxies or someone else's leaked keys. — [Uptech: API Claude miễn phí có thật không?](https://uptech.vn/ai-store/huong-dan/api-claude-mien-phi)

**Price-change lag (single source, unverified)**
- OpenAI cut "GPT-5.6 Sol" to $4/$20 on Aug 21, 2026, but Cloudflare AI Gateway still listed $5/$30 afterwards. — [ecorpit](https://ecorpit.com/gpt-5-6-sol-price-cut-ai-gateway-cloudflare-vercel-fork-2026/)

### Inferences
- **The central unmet need is answering "what actually served my request, and was it the real model at full quality?"** OpenRouter only partly addresses it (Auto Exacto applies to tool calls only, and pinning is manual). Relays don't address it at all, and Chinese users have built a whole ecosystem of probe tools around it. A VN gateway with mostly direct provider deals can make "no substitution, no undisclosed quantization" a verifiable promise. That works best if it publishes probe results and invites users to run tools like apiranking or claude-detector against it.
- **Refund and expiry rules are a trust gap that is cheap to close:** a 7- to 30-day refund window on unused credits, no expiry or a warning before expiry, and a one-time goodwill refund for runaway loops.
- **Key-leak incidents are a timely selling point:** auto-revocation through secret scanning, per-key spend caps with anomaly-based auto-pause, and alerts over Zalo or email.

### Gaps
- Reddit (r/OpenRouter, r/LocalLLaMA), Discord and GitHub issue threads did not surface in search, so I have no direct quotes or frequency counts from them.
- I found no Vietnamese forum (VOZ, Viblo, J2TEAM, Tinh tế) threads about reseller scams or quality.
- The NeurIPS-overturn claim is not independently replicated.
- Latency-overhead complaints, with specific milliseconds added by gateways, were not found.

## 3. Trust and transparency mechanisms: what exists and what is missing

### Takeaway
OpenRouter leads on trust mechanisms. It returns per-request cost in the response, offers a generation-lookup endpoint, provides provider pinning and filter controls, runs quality-aware routing (Auto Exacto) with published benchmark data, offers ZDR, in-region routing and a DPA on Business, and is a GitHub secret-scanning partner. Model labs are starting to police vendors themselves through Moonshot's Kimi Vendor Verifier. Still largely missing across the market:
- per-request authenticity proof
- systematic quantization disclosure that actually predicts quality
- price-change notices and propagation SLAs
- visible log-cap behavior (Portkey stops logging silently)
- anything at all in the relay and reseller tier

### Cited Findings
- **OpenRouter usage accounting:** cost and usage details, including cached tokens, are returned automatically. For streaming they come in the last SSE message. `cost` is the amount charged and `cost_details.upstream_inference_cost` is the upstream provider's charge (BYOK only). Usage can be fetched later from `/generation` by response id. — [OpenRouter docs: Usage Accounting](https://openrouter.ai/docs/guides/administration/usage-accounting)
- Billing tools such as Autumn attach OpenRouter's reported cost to events (`openrouter_cost`) for reconciliation. — [Autumn docs: OpenRouter](https://docs.useautumn.com/documentation/external-providers/openrouter)
- **OpenRouter Auto Exacto:**
  - On by default for every tool-calling request. Non-tool requests stay price-weighted.
  - Providers are ranked by throughput, tool-call success rate (each returned tool call is validated against the caller's schema using JSON Schema Draft 7) and benchmarks: TauBench Verified Airline (a non-standard variant) and GPQA-Diamond.
  - Scores are recomputed about every 5 minutes.
  - Internal TauBench went from 69% to 74%.
  - Users opt out with sort = price or the `:floor` suffix.
  - Sources: [OpenRouter: Auto Exacto](https://openrouter.ai/blog/announcements/auto-exacto/); [OpenRouter docs: Auto Exacto](https://openrouter.ai/docs/guides/routing/auto-exacto)
- At launch the docs said the benchmark data was "not yet available on the site". The LessWrong author's July 28, 2026 update corrected an earlier claim that it was not public. — [OpenRouter docs](https://openrouter.ai/docs/guides/routing/auto-exacto); [GreaterWrong](https://www.greaterwrong.com/posts/KsyoSAyBRXtwzSugg/not-pinning-your-openrouter-provider-might-invalidate-your)
- **Provider controls:** OpenRouter's provider object includes `order`, `only`, `ignore`, `allow_fallbacks` and other fields. — [Pinggy](https://pinggy.io/blog/openrouter_production_provider_routing_pitfalls/); [vorplabs: OpenRouter provider controls](https://vorplabs.com/models/openrouter-provider-controls)
- **Key-leak protection:** OpenRouter is a GitHub secret-scanning partner and has other methods to detect exposed keys. — [OpenRouter docs: Authentication](https://openrouter.ai/docs/api-reference/authentication)
- **Compliance on the Business tier:** EU and US in-region routing, ZDR and a signed DPA on request. — [OpenRouter Business](https://openrouter.ai/business)
- **Kimi Vendor Verifier (KVV)** from Moonshot AI, open-sourced alongside Kimi K2.6:
  - It lets users check whether third-party vendors serve Kimi models correctly.
  - The earlier K2 Vendor Verifier focused on tool calls: true positives, false positives and schema accuracy. Moonshot's official API reportedly scores 100% schema accuracy.
  - It targets malformed tool IDs and wrong trigger decisions. Causes include quantization, misconfigured chat templates, wrong tool-call schemas and truncated context windows.
  - Moonshot plans a public leaderboard of vendor results.
  - Sources: [Kimi blog: Rebuilding the "Chain of Trust": Kimi Vendor Verifier](https://www.kimi.com/en/blog/kimi-vendor-verifier); [Kimi platform: K2-Vendor-Verifier newsletter](https://platform.kimi.ai/blog/posts/K2_Vendor_Verifier_Newsletter); [ecosistemastartup](https://ecosistemastartup.com/?p=76478)
- **Precision disclosure:** some providers label precision on listings, for example SiliconFlow's "Kimi K2.6 (FP8)" on Artificial Analysis. — [Artificial Analysis: SiliconFlow](https://artificialanalysis.ai/providers/siliconflow)
- **Relay-tier transparency is crowdsourced:**
  - Ranking sites show uptime and "watering rate".
  - The open-source api-relay-audit project exists.
  - apiranking lets you test with your own key.
  - Relays self-declare "never watered down, never downgraded", which is not proof.
  - Sources: [X @Pluvio9yte](https://x.com/Pluvio9yte/status/2052552998061297804); [apiranking](https://apiranking.com/verify-yourself); [ClaudeHub](https://qinzhiai.com/)
- **Model fingerprinting** (identifying model family and version, and detecting downgrades) is discussed as a technique on X. — [X article by @chuanliang](https://x.com/chuanliang/article/2105107777878409355)
- **Portkey's silent log cap:** at the log limit, requests keep routing but no longer appear in observability. — [TrueFoundry Portkey pricing guide](https://www.truefoundry.com/blog/portkey-pricing-guide)
- **Status and shutdown tracking:** third parties track whether gateways are discontinued, checking "each vendor's own site, docs or GitHub". — [standardcompute](https://standardcompute.com/alternatives/discontinued-ai-gateways)

### Inferences
- **Lightweight transparency features a VN gateway could ship** (none of these is a "feature" in the routing sense):
  - **Response headers or fields on every call:** `x-provider`, `x-upstream-model-id`, `x-precision` (bf16/fp8/fp4), `x-region`, `x-cost-vnd` / `x-cost-usd`, `x-cache-read-tokens`.
  - **A public authenticity page:** KVV-style tool-call and fingerprint probes run daily on each upstream channel, with results published and dated.
  - **A price-change feed:** RSS, email or Zalo notices with N days' warning for increases, and a target of passing upstream cuts through within 24 hours. This turns the Cloudflare price-lag anecdote into a positioning point.
  - **A cache-billing audit view:** cached tokens billed at the cached rate, shown per request. This directly answers the relay complaint about cache billed at full price.
- Labelling precision alone may not reassure sophisticated users, because fp4 versus fp8 doesn't reliably predict quality. Pairing labels with measured scores, as Auto Exacto does, is more credible.

### Gaps
- I could not confirm whether OpenRouter's standard response body exposes the serving provider. From pre-2026 background knowledge, which was not re-verified here: OpenRouter responses include a `provider` field, the Activity page shows the provider per generation, and provider preferences include `quantizations`, `data_collection`, `zdr` and `max_price` filters. The report writer should treat these as unverified.
- Not found: Vercel or Cloudflare per-request provider disclosure details, the existence of status or uptime pages for each gateway, and any gateway offering cryptographic or attested model-authenticity proof.

## 4. Pricing and billing mechanics developers value, and the payment and invoicing situation for Vietnam and SEA developers

### Takeaway
Developers value pay-as-you-go with low minimums ($4–5 globally, around 26,000₫ locally), transparent fees, generous or permanent free quotas, spend caps, and long-lived credits. They resent short refund windows, silent expiry and free-tier limits tied to lifetime purchases.

In Vietnam, the core problems are structural:
- OpenAI and Anthropic need international Visa/Mastercard, so domestic cards and e-wallets (MoMo, VietQR) don't work.
- Declines happen often because banks block international online payments or Stripe's anti-fraud flags them.
- Invoices are English Stripe PDFs, not Vietnamese e-invoices (hóa đơn điện tử, "hóa đơn đỏ"), so businesses reportedly can't claim input VAT.

That is exactly the gap local resellers fill with VietQR top-ups and "xuất VAT" claims. The regulatory backdrop is tightening: foreign digital-service VAT went up to 10% and e-invoicing for non-resident providers starts in July 2026.

### Cited Findings

**Global mechanics**
- **Fee and markup comparison:**
  - OpenRouter: 5.5% on credit purchases, minimum $0.80; crypto 5%; Business 8%. — [OpenRouter blog](https://openrouter.ai/blog/simplifying-our-platform-fee); [flexprice](https://flexprice.io/pricing-index/openrouter); [OpenRouter Business](https://openrouter.ai/business)
  - Cloudflare: 5% on credit purchases. — [Cloudflare changelog](https://developers.cloudflare.com/changelog/post/2026-08-07-workers-ai-unified-billing/)
  - Requesty: 5% on usage. — [Requesty pricing](https://www.requesty.ai/pricing-new)
  - Vercel: 0% markup, but the user pays payment-processing fees. — [Vercel pricing](https://vercel.com/docs/ai-gateway/pricing)
- **Expiry:**
  - OpenRouter can expire credits 365 days after purchase. — [ConductAtlas](https://conductatlas.com/platform/openrouter/openrouter-terms-of-service/credits-expire-after-365-days/)
  - Vercel's purchased credits expire after one year. — [Vercel usage and pricing](https://vercel.com/docs/ai-gateway/usage-and-pricing)
  - Anthropic API credit reportedly expires after one year and is non-refundable. — [Uptech](https://uptech.vn/ai-store/huong-dan/api-claude-mien-phi)
- **Refund windows:** OpenRouter allows 24 hours. — [OpenRouter Terms](https://openrouter.ai/terms)
- **Minimums:**
  - OpenRouter $5. — [Pinggy](https://pinggy.io/blog/free_ai_model_apis_unlimited_tokens_openrouter/)
  - OhMyGPT $4. — [HowToken](https://howtoken.net/station/www-ohmygpt-com)
  - APIZ (VN) 26,000₫, no monthly fee. — [APIZ](https://api.apiz.vn/)
- **Free tiers:**
  - OpenRouter: 50 or 1,000 free-model requests per day, depending on a lifetime $10 purchase. — [OpenRouter limits](https://openrouter.ai/docs/api-reference/limits)
  - Requesty: 200 requests per day with no card. — [Requesty](https://www.requesty.ai/pricing-new)
  - Vercel: $5 every 30 days, which ends once you pay. — [Vercel](https://vercel.com/docs/ai-gateway/usage-and-pricing)
  - AIHubMix: a permanent free testing quota. — [eggstriker](https://www.eggstriker.com/en/ai-api/aihubmix)
- **Invoices for businesses:** OpenRouter offers post-paid invoicing only on Enterprise (sales contract). Business and Standard pay up front by card or crypto. — [OpenRouter pricing.md](https://openrouter.ai/pricing.md)
- **Log-based pricing as a hidden cost:** Portkey charges $9 per extra 100k logs. — [TrueFoundry Portkey guide](https://www.truefoundry.com/blog/portkey-pricing-guide)

**Vietnam: paying OpenAI and Anthropic directly**
- OpenAI API credit is prepaid by international Visa or Mastercard, including international debit cards from Vietnamese banks. Domestic cards and Vietnamese e-wallets do not work. Most declines happen because the bank blocks international online payments, which users must enable in the bank app. — [TND: OpenAI API key & pricing guide](https://www.tnd.vn/openai-api-lay-key-doc-bang-gia-va-goi-tu-code-18504/)
- Other decline causes: not enough balance for the roughly $5 verification hold, and Stripe or issuer anti-fraud blocks. Guides advise trying a different card rather than retrying, since repeated attempts can trigger a temporary lock, and choosing "Vietnam" as the billing country. — [bestapp.vn: fix ChatGPT card declines 2026](https://bestapp.vn/blog/loi-chatgpt-plus-thuong-gap-2026-cach-fix); [Tino: how to get an OpenAI API key (2026)](https://tino.vn/blog/cach-lay-api-key-cua-openai/)
- A blog estimate that 60–70% of domestic cards are declined has no official source.
- **Invoices:**
  - OpenAI invoices are English PDFs issued by Stripe, not Vietnamese e-invoices, because OpenAI has no Vietnamese business registration.
  - Businesses reportedly book them as foreign-service expenses without input-VAT credit, and need a card in the company's name for the documents to support the expense.
  - This comes from a commercial blog and has not been checked against tax rules.
  - Source: [bestapp.vn: ChatGPT invoices & VAT for VN businesses 2026](https://bestapp.vn/blog/chatgpt-plus-xuat-hoa-don-vat-2026-cho-doanh-nghiep-viet-nam)
- **Anthropic Console:** a tax or VAT ID can be added under Settings > Organization. Changes apply only to future billing cycles; finished invoices cannot be updated. — [Anthropic support: add/update tax or VAT ID for Console org](https://support.claude.com/ko/articles/9889428-claude-console-조직의-세금-또는-vat-id-추가-또는-업데이트)

**Vietnam tax backdrop**
- **VAT rate:** the VAT rate for foreign digital suppliers without a permanent establishment rose from 5% to 10%. One source dates this to July 1, 2025 under the new VAT Law. — [Baker McKenzie: new VAT Law](https://insightplus.bakermckenzie.com/bm/tax/vietnam-key-updates-on-new-vat-law-and-amended-law-on-tax-administration); [ITIF: Vietnam's digital tax policy](https://itif.org/publications/2025/06/09/vietnam-digital-tax-policy/)
- **Foreign-supplier portal:** an English-language portal issues a 10-digit TIN. Sources disagree on whether registration is optional or mandatory. — [vatcalc](https://vatcalc.com/?p=5787)
- **E-invoicing:** an amended tax administration law extends e-invoicing to non-resident digital providers (SaaS and similar) from July 2026. — [vatcalc: non-resident digital services providers subject to e-invoicing rules July 2026](https://www.vatcalc.com/vietnam/vietnam-vat-on-digital-services-december-2020/)
- **Temporary cut:** one guide mentions a 2-point VAT cut (to 8%) through Dec 31, 2026 for most supplies. Its applicability to SaaS is unclear. — [Kintsugi: Vietnam VAT guide 2026](https://trykintsugi.com/sales-tax-guides/apac/vietnam.md)

**Vietnamese local rails used by resellers**
- VietQR is everywhere: apigiare, 9Flare, Stali, APIZ, LIT and APIVN all use it. MoMo, bank transfer and USDT are offered by FRIDAY AI.
- "VAT invoice" claims appear on 9Flare and Stali, and are central to Uptech's offer. The conditions and the entity issuing the invoices are not stated.
- Sources: [apigiare](https://apigiare.vn/?lng=vi); [fridayaix](https://fridayaix.com/); [9flare](https://9flare.com/); [Stali](https://api.stali.vn/); [Uptech](https://uptech.vn/ai-store/huong-dan/mua-claude-api-key-cho-doanh-nghiep)

### Inferences
- **The strongest local wedge:**
  1. Top up in VND through VietQR with automatic crediting in seconds and no international card.
  2. Show the VND per $1 rate up front.
  3. Issue a lawful Vietnamese e-invoice (hóa đơn điện tử) automatically, using the company's tax code (MST) looked up at checkout.
  4. Offer post-paid monthly invoicing for SMEs, which OpenRouter reserves for Enterprise.
  - This combination removes the three biggest frictions VN businesses face: card declines, foreign-currency expensing and no deductible input VAT. Grey-market resellers can't credibly offer #3.
- **Global billing details worth copying:**
  - A low minimum (about 26,000–50,000₫).
  - A free tier that is not tied to lifetime spend (OpenRouter's $10 lifetime gate is a known irritant).
  - Credits that never expire, or at least a 30-day email or Zalo warning before expiry.
  - A refund window longer than 24 hours.
  - Per-key spend caps and auto top-up with a ceiling.
- **The tax angle cuts both ways.** With e-invoicing extended to foreign digital suppliers from July 2026 and VAT at 10%, OpenAI and Anthropic may increasingly charge VN VAT. A local gateway that issues proper invoices and is properly registered may soon have a structural compliance advantage over grey resellers. That depends on how the rules are enforced, which I did not verify.

### Gaps
- I couldn't confirm whether OpenAI or Anthropic are currently registered on Vietnam's foreign-supplier portal or add 10% VN VAT to invoices.
- I couldn't confirm the exact timing rules for e-invoices on prepaid credit top-ups (Decree 70/2025 details); the search budget ran out.
- No data on MoMo or ZaloPay acceptance by global gateways, or SEA rails (GrabPay, GCash, PromptPay) at OpenRouter or Vercel.
- No hard decline-rate data for Vietnamese cards on Stripe.
- I could not verify whether Anthropic accepts Vietnamese cards at Console checkout.

## 5. Developer-experience details that stand out

### Takeaway
The DX details that win loyalty are small but compounding:
- drop-in OpenAI-compatible endpoints
- cost and usage returned in the final streaming chunk
- a lookup endpoint for reconciliation
- free models to start without paying
- public app and model rankings that double as free marketing for builders (OpenRouter's HTTP-Referer attribution)
- one credit balance across many providers (Cloudflare)
- predictable defaults, such as quality routing on by default for tool calls with simple suffixes like `:floor` to opt out

Relay software (new-api) has made multi-key load balancing and model mapping commodity features. The differentiation has moved to defaults, honesty and polish.

### Cited Findings
- **OpenRouter app attribution:**
  - `HTTP-Referer` is required and is the app's unique id. `X-OpenRouter-Title` sets the display name, with `X-Title` still supported. The optional `X-OpenRouter-Categories` header silently drops unknown values.
  - Attributed apps appear on public daily, weekly and monthly leaderboards, show up on each model's page as "apps using this model", and get usage analytics.
  - Source: [OpenRouter docs: App Attribution](https://openrouter.ai/docs/app-attribution)
- **Usage in the final SSE message,** a `cost` field and `/generation` lookup by id. — [OpenRouter Usage Accounting](https://openrouter.ai/docs/guides/administration/usage-accounting)
- **Free `:free` models** at 20 requests per minute, so developers can start with no card. — [OpenRouter limits](https://openrouter.ai/docs/api-reference/limits)
- **Model suffixes and defaults:** Auto Exacto is on for tool calls by default, and `:floor` restores cheapest-first routing. — [OpenRouter Auto Exacto docs](https://openrouter.ai/docs/guides/routing/auto-exacto)
- **What users praise:** pay-per-token across all frontier models with no subscription. — [HN 48072767](https://news.ycombinator.com/item?id=48072767)
- **Vercel:** zero markup including BYOK, plus $5 free every 30 days, which lowers the barrier to trying it. — [Vercel AI Gateway pricing](https://vercel.com/docs/ai-gateway/pricing)
- **Cloudflare:** one credit balance for Workers AI and third-party models, with higher rate limits when paying by credits (50 versus 20 requests per minute). — [Cloudflare changelog](https://developers.cloudflare.com/changelog/post/2026-08-07-workers-ai-unified-billing/); [releases.sh](https://releases.sh/release/rel_yV4w4XuoHG9mCgipvw5Wb-cloudflare-unifies-workers-ai-and-ai-gateway-access-billing-and-rate-limits)
- **new-api commodity features:** multi-channel load balancing (round-robin, auto-switch on rate limit) and model mapping. The ecosystem has add-on tools such as GatewayOps for channel monitoring, multiplier configuration and ledgers. — [deepseek.csdn.net](https://deepseek.csdn.net/6a7a7435662f9a54cb9b00a2.html); [80aj: GatewayOps (Aug 2026)](https://www.80aj.com/2026/08/28/gatewayops-ai-platform/)
- **AIHubMix's permanent free test quota** suits low-frequency use and evaluation. — [eggstriker](https://www.eggstriker.com/en/ai-api/aihubmix)
- **Rankings drive attention:** OpenRouter's position as the "router race" leader (a reported $1.3B valuation in talks) is partly built on public usage visibility. This is unverified secondary analysis. — [bestaiweb](https://www.bestaiweb.ai/openrouter-martian-and-not-diamond-the-2026-llm-router-race-and-where-agent-cost-optimization-is-heading/)
- **Error-message clarity is a DX gap.** Users can't tell gateway 429s from provider 429s, and 402s appear even on free models when the balance is negative. — [TrueFoundry rate-limit post](https://www.truefoundry.com/de/blog/openrouter-rate-limits-your-free-tier-depends-on-what-youve-already-paid); [OpenRouter limits](https://openrouter.ai/docs/api-reference/limits)

### Inferences
- **Micro-DX ideas for a VN gateway:**
  - Errors that name who failed and what to do, in Vietnamese and English. For example: `{"error":{"source":"upstream:provider_x","type":"rate_limited","retry_after_ms":1200,"fallback_attempted":true,"hint_vi":"..."}}`.
  - A VND cost header on every response.
  - A "Vietnam app rankings" leaderboard built on an attribution header, giving local builders free distribution, which OpenRouter's global board doesn't.
  - Vietnamese-language docs and playground.
  - Ready-made configs for the tools VN developers actually buy keys for: Claude Code, Cursor, n8n, Roo Code, Cline. Taphoammo and ShopAIKey listings target exactly these.
  - Zalo-based support and alerts (low balance, spend cap hit, key-leak detected).
- **Defaults that signal honesty:**
  - Quality-first routing on by default, with the cheaper path an explicit opt-in suffix.
  - Fallback events disclosed in headers.
  - A dashboard that shows the provider, precision and cache hits for every request.

### Gaps
- Not verified this session: cost-in-header conventions in other gateways (for example LiteLLM's `x-litellm-response-cost` header, from prior knowledge), the quality of playground and model-comparison pages, onboarding time-to-first-call, and VN community (Viblo, VOZ) feedback on gateway DX. The search budget was exhausted before these queries ran.
- I did not retrieve Discord or X sentiment about OpenRouter rankings or "State of AI" reports.
