# AI Code Review Competitors (GitHub/GitLab PR bots): micro-differentiation brief, as of late Oct 2026

Method note for the report writer: research ran 2026-10-25. Most vendor pricing pages, Reddit, HN, arXiv and docs.github.com could not be fetched directly (DNS/proxy blocks), so many prices come from third-party comparison blogs, and several of those are written by competing vendors (cubic, Macroscope, CodeAnt, Repowise, Augment, Greptile). Anthropic docs (code.claude.com) and GitHub pages (github.com discussions/PRs) were fetched as primary sources. The shared web-search budget ran out before the Vietnam/SEA searches could run, so that section is mostly gaps. Where sources disagree, both versions are listed.

## 1. Landscape as of 2026: who competes, pricing models, positioning, benchmarks

### Takeaway
The market has split three ways. (a) Per-seat specialists: CodeRabbit $24–72, Greptile $30 plus credits, Qodo, Bito $12–25, CodeAnt about $24, Baz $30 plus credits. (b) Bundled reviewers that are moving to metered billing: Copilot uses AI credits plus Actions minutes since June 1, 2026; Bugbot went usage-based after June 8, 2026; Codex comes inside ChatGPT plans. (c) Premium per-PR deep review: Anthropic Code Review, about $15–25 per review and about 20 minutes. Free tiers are mostly gone for private repos: Gemini's free GitHub app shut down in July 2026, and Amazon closed CodeGuru and then Q Developer to new signups. Free for public/OSS repos is still the norm. Every published benchmark is run by a vendor, and the "#1" spot on Martian's independent Code Review Bench has changed hands several times in 2026, with top F1 around 61–66%.

### Cited Findings
**CodeRabbit** (market leader, per-seat)
- Current tiers (Oct 2026): Essentials $24/dev/mo billed annually ($30 monthly), Team $48 ($60), Advanced $72, Enterprise by quote. Reviews past the hourly limit cost $0.25 per reviewed file. Only developers who open PRs are billed. Earlier 2026 articles list Lite at $12 and Pro at $24, an older naming. — [cubic pricing comparison](https://www.cubic.dev/blog/ai-code-review-pricing); [cubic CodeRabbit review](https://www.cubic.dev/blog/coderabbit-review); [Justin McKelvey](https://justinmckelvey.com/blog/coderabbit-pricing); [Dynalord](https://dynalord.com/blog/coderabbit-pricing); [Costbench](https://costbench.com/software/ai-code-review/coderabbit/). The $0.40/min "CodeRabbit Agent" rate comes from a single source and is unconfirmed.
- Public repos are free; private repos get a 14-day trial. One source says the free tier also covers private repos with rate limits, which conflicts with the others. — [WeavAI](https://weavai.app/blog/en/2026/05/12/coderabbit-2026-ai-code-review-pricing-alternatives/); [Costbench](https://costbench.com/software/ai-code-review/coderabbit/)
- Raised $60M at a $550M valuation in Sept 2025 (2025 data). — [TechCrunch](https://techcrunch.com/2025/09/16/coderabbit-raises-60m-valuing-the-2-year-old-ai-code-review-startup-at-550m/)
- Has three review profiles. In CodeRabbit's glossary wording: "Quiet posts only the most important comments inline", "Chill focuses on important issues", and "Assertive provides comprehensive feedback with more comments overall". — [GitHub PR quoting the CodeRabbit glossary](https://github.com/pr0d1r2/nix-lefthook-bats-changed/pull/55)

**Greptile** (full-repo-context "independent auditor", per-seat plus credits)
- Starter is free for 1 active dev with 50 credits/mo and unlimited repos. Pro is $30/seat/mo with 50 credits per seat and $1 per extra credit. A Base review costs 1 credit, Plus 3, Apex 10 (Plus and Apex added late Sept 2026). Enterprise adds self-hosting and SSO. Non-commercial OSI-licensed OSS is free. Startups under $2M revenue get 50% off. — [Macroscope (competitor)](https://macroscope.com/content/greptile-pricing-2026); [Repowise](https://repowise.dev/blog/comparisons/greptile-pricing)
- Worked example: Apex-depth reviews cost about $80/dev/mo at 10 PRs per dev, against a flat $30 at Base/Plus. — [Repowise](https://repowise.dev/blog/comparisons/greptile-pricing)
- Positioning: the reviewer should be separate from the code generator ("an auditor doesn't prepare the books"). Greptile says it deliberately does *not* generate code and predicts that much code will be auto-approved by review agents. — [Greptile: AI code review bubble](https://www.greptile.com/blog/ai-code-review-bubble); [Greptile: independent auditor](https://www.greptile.com/blog/auditor)
- One review says Greptile may train on de-identified customer data by default (opt-out). Unverified against Greptile's own docs. — [Repowise / Macroscope summaries via search](https://repowise.dev/blog/comparisons/greptile-pricing)
- One headline reports a $50M raise at a $750M valuation; only the headline was seen. — [llms.blog](https://www.llms.blog/posts/greptile-raises-50m-at-a-750m-valuation-what-the-ai-code-reviewer-does-and-what-it-costs)

**Cursor Bugbot + Graphite** (IDE-bundled)
- Legacy seat plans were a flat $40/user/mo for teams until the first renewal after June 8, 2026. Newer plans bill against usage: individuals draw on included plan usage, teams pay on-demand. One estimate puts a run at about $1.00–$1.50. Other sites still list $40/user/mo or $32 annual. — [GitAutoReview](https://gitautoreview.com/compare/cursor-bugbot-alternative); [cubic Bugbot review](https://www.cubic.dev/blog/cursor-bugbot-review); [cubic pricing](https://www.cubic.dev/blog/ai-code-review-pricing)
- Cursor reports a 78.13% resolution rate across 50,310 PRs, up from 52% of flagged bugs resolved by merge at launch in July 2025. This is a vendor metric. — [Cursor blog: Bugbot learning](https://cursor.com/blog/bugbot-learning); [cubic Bugbot review](https://www.cubic.dev/blog/cursor-bugbot-review)
- Since about April 8, 2026, Bugbot writes "learned rules" from reactions and replies to its own comments and from human reviewers' comments. Enabled per org/repo. — [Cursor blog](https://cursor.com/blog/bugbot-learning); [aicodereview.cc](https://aicodereview.cc/tool/cursor-bugbot/)
- Cursor agreed to acquire Graphite on Dec 19, 2025; terms were not disclosed. Reports put the price above Graphite's last $290M valuation, which is unconfirmed. Graphite runs independently. — [Cursor blog](https://cursor.com/blog/graphite); [Yahoo Finance exclusive](https://finance.yahoo.com/news/exclusive-cursor-acquires-code-review-153008616.html)
- Graphite pricing for its Diamond/Agent reviewer was not found.

**GitHub Copilot code review** (bundled, now metered)
- Since June 1, 2026, each review spends AI credits (token-based), plus GitHub Actions minutes on private repos; public repos are exempt from minutes. GitHub's estimate is $0.25–$5 of credits per review at default effort, and a "Lite" review is $0.05–$1 (third-party reading of GitHub docs). Actions minutes cost $0.006/min on a standard Linux runner once included minutes run out. — [GitHub changelog (via search)](https://github.blog/changelog/2026-04-27-github-copilot-code-review-will-start-consuming-github-actions-minutes-on-june-1-2026/); [GitHub community #192948](https://github.com/orgs/community/discussions/192948); [cubic Copilot review](https://www.cubic.dev/blog/github-copilot-code-review); [GitAutoReview cost](https://gitautoreview.com/blog/github-copilot-code-review-cost-2026)
- Seat prices did not change (user comments cite Pro $10 and Pro+ $39). Credits do not roll over, annual plans are being retired, and Copilot Free does not include full PR review. The announcement post drew about 958 thumbs-down; users called it "bait and switch". — [GitHub community #192948](https://github.com/orgs/community/discussions/192948)
- A headline claims "60M reviews". — [GitAutoReview](https://gitautoreview.com/blog/github-copilot-code-review-guide)

**Anthropic Claude Code Review** (premium per-PR)
- Launched Mar 9, 2026 as a research preview for Team/Enterprise plans, GitHub only (including GHES). Billed on tokens through usage credits, "generally averaging $15–25 per review". Average runtime is about 20 min. Admins get monthly spend caps, per-repo enablement and an analytics dashboard. — [Anthropic blog](https://claude.com/blog/code-review); [Docs: costs](https://code.claude.com/docs/en/code-review-costs)
- Pipeline: Find (parallel agents) → Verify (checks candidate findings against the code and drops false positives) → Rank (dedupe, severity) → Post (inline comments, a summary, and a check run that never fails). It reads code without building or running it. Review levels are Quick, Standard and Deep. It is unavailable under Zero Data Retention, HIPAA or CMEK. — [Docs: Code Review](https://code.claude.com/docs/en/code-review)
- Internal stats: PRs with substantive comments rose from 16% to 54%. 84% of PRs over 1,000 lines get findings (avg 7.5); 31% of PRs under 50 lines do (avg 0.5). Engineers marked under 1% of findings incorrect. — [Anthropic blog](https://claude.com/blog/code-review)
- The price drew backlash, for example "Anthropic wants $25 per pull request". — [Level Up Coding](https://levelup.gitconnected.com/anthropic-wants-25-per-pull-request-devs-are-losing-their-minds-over-claude-code-review-55dbbaca4996); [TechRadar](https://www.techradar.com/pro/anthropic-launches-a-new-code-review-tool-to-check-ai-generated-content-but-it-might-cost-you-more-than-youd-hope)
- Cheaper Anthropic routes: the open-source Claude Code GitHub Action runs on your own runner with your own API key (Anthropic, Bedrock, Vertex, Foundry). The open-source `/code-review` plugin is described under Q3. — [claude-code-action](https://github.com/anthropics/claude-code-action); [Docs comparison table](https://code.claude.com/docs/en/code-review)

**OpenAI Codex review** (bundled with ChatGPT)
- GitHub PR review is included in ChatGPT Plus, Pro, Business, Enterprise and Edu, not in Free, Go or API-key use. The allowance size is unpublished. In GitHub it flags only P0 and P1 issues. — [OpenAI docs](https://developers.openai.com/codex/integrations/github); [Omid Saffari](https://omidsaffari.com/blog/codex-review); [Codewalkers](https://codewalkers.com/ai-code-review/codex/)
- A repo whose AGENTS.md listed P0–P3 found Codex posting P2s, so it narrowed the rules back to P0/P1. — [openaca PR #210](https://github.com/open-agent-security/openaca/pull/210)
- Reportedly ranks #13 of 15 by F1 on Martian's bench (secondary). — [Codewalkers](https://codewalkers.com/ai-code-review/codex/)

**Qodo (formerly Qodo Merge) / PR-Agent**
- PR-Agent is now "a community-maintained legacy project of Qodo". It was donated to the community and is being moved to an open-source foundation. Qodo's hosted product (formerly Qodo Merge) is now "Qodo 2.0". PR-Agent supports GitHub, GitLab, Bitbucket, Azure DevOps and Gitea, makes one LLM call per tool (about 30 s), and works with any model through LiteLLM. — [PR-Agent README](https://github.com/qodo-ai/pr-agent)
- Self-hosting PR-Agent is estimated at $0.02–$0.10 per review in LLM API cost. — [aicodereview.cc](https://aicodereview.cc/blog/qodo-merge-pricing/)
- Hosted pricing is disputed. Sources give Teams at $30/user/mo annual ($38 monthly) with 2,500 credits; newer pooled credits at $0.012 each; a free Developer plan of 30 PR reviews/mo or 250 credits; or no permanent free tier. — [aicodereview.cc Qodo pricing](https://aicodereview.cc/blog/qodo-pricing/); [cubic Qodo alternatives](https://www.cubic.dev/blog/the-3-best-qodo-merge-alternatives-for-ai-code-review-in-2025); [GitHub Marketplace](https://github.com/marketplace/qodo-merge-pro)
- Qodo claims #1 on Martian with 64.3% F1 for its "Extended" configuration; its standard configuration ranked #4 at 47.9%. Wikipedia reports 63.4% precision (#1) in March 2026. — [Qodo blog](https://www.qodo.ai/blog/qodo-ranked-1-ai-code-review-tool-in-martians-code-review-benchmark/); [Wikipedia](https://en.wikipedia.org/wiki/Qodo)

**Google Gemini Code Assist review**
- The free consumer GitHub app stopped taking installs on June 18, 2026 and ended all review activity on July 17, 2026. An enterprise version, installed via Google Cloud, is in Preview. Seats: Standard $19/mo on annual commitment ($22.80 monthly); Enterprise $45 ($54). Several review sites still list a $0 tier, which looks stale. — [StackPick](https://stackpick.net/blog/gemini-code-assist-pricing-2026/)
- Repo config lives in `.gemini/styleguide.md` (review rules) and `.gemini/config.yaml`, which sets a minimum comment severity. — [Google blog (older)](https://blog.google/intl/en-ca/products/cloud/get-coding-help-from-gemini-code-assist-now-for-free/); [Qodo glossary](https://www.qodo.ai/glossary/what-is-gemini-code-assist-code-review/)

**Amazon**
- CodeGuru Reviewer has accepted no new repository associations since Nov 7, 2025 and is in maintenance mode. Its old price was $0.75 per 100 LOC (unverified). Amazon Q Developer blocked new accounts on May 15, 2026; IDE plugins and paid subscriptions reach end of support Apr 30, 2027, and users are pointed to Kiro. Q Pro was $19/user/mo. — [StackPick CodeGuru](https://stackpick.net/tools/aws-codeguru/); [Javis Review](https://javisreview.com/review/amazon-q-developer-review-2026/)
- Historical detail: CodeGuru charged PR revisions only for changed or new lines (2020). — [AWS announcement 2020](https://aws.amazon.com/about-aws/whats-new/2020/05/amazon-codeguru-reviewer-launches-new-pricing-model/)

**Long tail** (prices from aggregators; often conflicting)
- **Bito:** Team $12/seat/mo annual ($15 monthly), Professional $20 ($25). Each seat includes 5,000 reviewed lines per month; extra lines cost $5 per 1,000. Self-hosting is a $5/seat add-on. 14-day trial with no card. — [StackPick Bito](https://stackpick.net/pricing/bito-ai/)
- **CodeAnt:** about $24/user/mo annual ("Premium") in one source and $10/user/mo for AI code review in another (conflict). — [CodeAnt blog](https://codeant.ai/blogs/best-ai-code-review-tools-for-developers); [cubic pricing](https://www.cubic.dev/blog/ai-code-review-pricing)
- **Baz:** Pro $30 per active dev per month plus usage credits ($0.01/credit); single source. Baz claims #1 in precision on Code Review Bench. — [aicodereview.io directory](https://aicodereview.io/tools/); [Baz blog](https://baz.ai/resources/blog/baz-1-in-precision-in-independent-code-review-bench)
- **Sourcery:** Pro $15/mo or $12 annual; Team $30 or $24 annual. Other listings give $29/seat or $12. — [Augment comparison (Sept 2026)](https://www.augmentcode.com/tools/ai-code-review-tools-comparison)
- **Ellipsis:** one source lists $20/dev/mo with free public repos; another describes tokens at cost +10% plus compute at $0.1419/core-hour (conflict). — [xpay.sh](https://www.xpay.sh/saas-pricing/ellipsis-dev/); [Augment comparison](https://www.augmentcode.com/tools/ai-code-review-tools-comparison)
- **Korbit:** no evidence of a shutdown. The Sept 2026 comparison lists "$12 per git author per year" (possibly a typo); an older listing gives Pro at $24/user/mo. — [Augment comparison](https://www.augmentcode.com/tools/ai-code-review-tools-comparison); [SourceForge](https://sourceforge.net/software/product/Korbit.ai/)

**Benchmarks** (all vendor-run except Martian, which is open-source and independent)
- Martian Code Review Bench (released March 2026). The offline track uses 50 real PRs from 5 repos, 136 human-curated "golden comments" and an LLM judge. One snapshot from about early Oct 2026: cubic 65.5% F1, Greptile 62.3%, Copilot 61.5%, Claude 61.3%, CodeRabbit 61.0%. Earlier: cubic claimed #1 at 65.7% in March and Greptile #1 at 60.8% on July 30. — [aicodereviews.io: "#1 claim rots in months"](https://www.aicodereviews.io/blog/martians-code-review-bench-the-1-claim-rots-in-months/); [cubic](https://www.cubic.dev/blog/cubic-is-the-best-ai-code-reviewer-on-martian-s-benchmark); [Greptile](https://www.greptile.com/content-library/greptile-martian-code-review-benchmark)
- Augment's benchmark: Augment 65% precision / 55% recall / 59% F. Claude Code had the second-highest recall (51%) and the lowest precision (23%). — [Augment](https://www.augmentcode.com/blog/we-benchmarked-7-ai-code-review-tools-on-real-world-prs-here-are-the-results)
- Tenki (May 2026, 122 bugs / 50 PRs): Tenki 68.9% recall but 29.9% precision (F1 41.7); Greptile 36.1% recall; CodeRabbit 28.7%. — [Tenki](https://tenki.cloud/benchmarks/code-reviewer)
- CodeAnt: Qodo Extended 64.3% F1, CodeAnt third at 51.7%, Claude Code Reviewer 39.0% F1 (37.3% P / 40.9% R). — [CodeAnt](https://codeant.ai/blogs/ai-code-review-benchmark-results-from-200-000-real-pull-requests)
- Entelligence: Entelligence 47.2% F1; Claude 42.8%. — [Entelligence](https://entelligence.ai/code-review-benchmark-2026)
- Macroscope (118 bugs): CodeRabbit 45.8%, Bugbot 42.4%, Greptile 23.6%. Greptile's own comparison claims it catches over 50% more bugs than CodeRabbit. These contradict each other. — [Macroscope](https://macroscope.com/content/greptile-vs-coderabbit-2026); [Greptile content library](https://www.greptile.com/content-library/best-ai-code-review-tools)

### Inferences
- Every leader posts a benchmark win on its own test. Martian's top 5 sit within about 5 F1 points and rotate monthly. A solo founder cannot win on "most bugs caught". The open ground is precision, price and behavior on re-review.
- Price tiers are clustering at three points: about $0.02–$1 per review (DIY or BYO-key, PR-Agent, Copilot Lite, Bugbot runs), $12–$30/seat/mo (Bito, CodeRabbit Essentials, Greptile Pro), and $15–25 per PR (Claude premium). Nobody visibly sells a cheap, verified, high-precision per-PR review at roughly $0.10–$0.50. A two-pass Reviewer+Critic could anchor its message against Claude's architecture: "the same find-then-verify design, about 50x cheaper".
- Big platforms are moving to metered billing (Copilot June 2026, Bugbot June 2026), and the free Gemini and Amazon options have closed. Small teams that relied on free review are losing it, which is an acquisition window for a cheap, predictable option.
- Verification is now table stakes in messaging: Anthropic says "verify", RovoDev uses an LLM-judge, the Claude plugin uses a confidence threshold of 80. The Critic alone will not stand out. The visible proof will: showing the evidence the Critic checked.

### Gaps
- Primary pricing pages for CodeRabbit, Greptile, Bugbot, Graphite, Qodo, Sourcery, Ellipsis, Korbit, CodeAnt and Baz could not be fetched. Figures are from aggregators, and several conflict.
- No Graphite Diamond/Agent price found after the Cursor acquisition.
- No independent confirmation of Bugbot's June 2026 "3x faster, 22% cheaper" update.
- Martian's live leaderboard was not fetched directly; the snapshot is secondhand.
- GitLab support per tool was not systematically verified (confirmed: PR-Agent supports GitLab; Claude via GitLab CI/CD; CodeRabbit public GitLab repos). Anthropic's managed Code Review is GitHub-only.

## 2. Top developer complaints: noise, repeats, wrong or hallucinated issues, verbosity, cost, speed, privacy, not learning

### Takeaway
The main reason teams uninstall is not that the bot misses bugs. It is noise that grows with every push: re-reviews that post new nits each round, re-raise suggestions the author already rejected, and bury the few real findings. After that come verbose bot artifacts (rewritten PR descriptions, poems, fortunes, long walkthroughs), price shocks (Claude at $25/PR, Copilot's metered billing), and slow reviews. Academic data backs the noise complaint: most review agents have signal ratios under 60%, and their comments are acted on far less often than human ones.

### Cited Findings
**Noise and nitpicks**
- HN thread "There is an AI code review bubble": "Copilot has terrible signal noise. But Bugbot is incredible. I've tried Greptile and it's pretty much pure noise. I ran it for 3 PRs and then gave up." Another commenter: the real failure is that reviewers do not stay quiet when there is no bug, which causes fatigue and makes developers ignore everything. A skeptic noted that Greptile's "9,078 positive author comments" means little without the denominator (for example, out of 1,000,000 comments). — [HN thread](https://news.ycombinator.com/item?id=46766961) (via search summary)
- Greptile's own early audit (around 2024, so dated): about 19% of comments were good, 2% wrong and 79% nits. — [ZenML case study](https://www.zenml.io/llmops-database/improving-ai-code-review-bot-comment-quality-through-vector-embeddings); [cubic](https://www.cubic.dev/blog/how-ai-code-review-works)
- One account of trust erosion: a bot posted 23 comments, the reviewer dismissed most, the team limited it to requested files, and eventually voted to remove it. "Developers don't turn off AI review bots because they dislike AI, they turn them off because the signal-to-noise ratio makes the tool more work than it saves." — [DEV: "Your AI review bot is training you to ignore it"](https://dev.to/jeff_pdc/your-ai-review-bot-is-training-you-to-ignore-it-23c5); see also [DEV: "Return on Attention"](https://dev.to/cseeman/return-on-attention-why-ai-code-reviews-are-wearing-us-out-2hh0)
- A head-to-head cited in vendor comparison pages reported about 2 false positives per run for CodeRabbit against about 11 for Greptile. Secondhand and vendor-adjacent. — [CodeAnt noise blog (via search)](https://codeant.ai/blogs/ai-code-review-noise-problem)
- MSR 2026 study of 3,109 PRs from AIDev: PRs reviewed only by code review agents (CRAs) merged at 45.20%, against 68.37% for human-only reviews, with higher abandonment. 60.2% of closed CRA-only PRs fell in the 0–30% signal range, and 12 of 13 CRAs had average signal ratios under 60%. The study shows association, not causation. — [MSR 2026 paper page](https://2026.msrconf.org/details/msr-2026-mining-challenge/54/From-Industry-Claims-to-Empirical-Reality-An-Empirical-Study-of-Code-Review-Agents-i); [arXiv 2604.03196](https://arxiv.org/html/2604.03196v1)

**Re-review loops and repeated comments** (the most specific, recurring pain)
- Copilot, GitHub Community #189767 (Mar 2026): "every push to a PR triggers a full re-scan of the diff". New comments land on code that was already in the diff but never flagged. Five rounds produced 10, 6, 4, 2 and 2 new comments. The user asked: "After a fix push, only verify that previous comments are addressed", no net-new comments, severity labels and filtering, and a way to stop auto reviews. Later replies (Jun–Jul 2026): "Why can't copilot generates all comments at once?" and "Endless loop… two to three should be enough." No GitHub staff reply. — [GitHub #189767](https://github.com/orgs/community/discussions/189767)
- Copilot, #190754 (Mar 2026): "Copilot re-raises the same suggestion on every review round, completely ignoring previous conversations." The example is Azure SDK PR #57483, where the same suggestion came back across 4 rounds. Explicit "do not report this again" instructions, in replies and in custom instructions, did not stop it. Resolving a thread in Files Changed does not carry over to the Conversation tab. — [GitHub #190754](https://github.com/orgs/community/discussions/190754)
- GitHub's own docs admit that on re-review Copilot "may repeat previous comments, even if you resolved or downvoted them." — [GitHub Docs (via search)](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/copilot-code-review)
- Copilot posts comments in chunks, announcing a count and then trickling in the rest ("It should post all the comments at once"). Users also dismiss stale comments by hand on every re-request. — [GitHub #188134](https://github.com/orgs/community/discussions/188134); [GitHub #187953](https://github.com/orgs/community/discussions/187953)

**Verbosity and unwanted artifacts**
- eclipse.jdt.ls PR "Make CodeRabbit less annoying" (merged Oct 20, 2026): "CodeRabbit generates a lot of useless noise that makes it difficult to review PRs" and "I personally find it annoying that CodeRabbit is modifying my PR descriptions". The fix disabled the high-level summary, the poem and the in-progress fortune. — [GitHub PR #3945](https://github.com/eclipse-jdtls/eclipse.jdt.ls/pull/3945)
- Another repo added a "quiet" config because "reviews used the account defaults: blocking change requests, a poem, a long walkthrough, and reviews of generated files." It turned off the poem, sequence diagrams, the changed-files summary, auto-approvals and chat auto-reply, collapsed the walkthrough, and excluded lockfiles and recordings. — [GitHub PR #55](https://github.com/pr0d1r2/nix-lefthook-bats-changed/pull/55). Conflict: CodeRabbit docs say the poem defaults to false. — [CodeRabbit config reference (via search)](https://docs.coderabbit.ai/reference/configuration)
- ovn-kubernetes also disabled the poem and collapsed the walkthrough. — [GitHub PR #6942](https://github.com/ovn-kubernetes/ovn-kubernetes/pull/6942)
- "Go Home Copilot" study: long, complex comments are less likely to be acted on. — [arXiv 2607.21997](https://arxiv.org/abs/2607.21997)

**Hallucinated or wrong findings**
- In the "Go Home Copilot" study (about 54.8k agent comments), a card sort of 470 unresolved discussions found incorrect suggestions and intentional design decisions to be the most common reasons a comment went unresolved. — [arXiv 2607.21997](https://arxiv.org/html/2607.21997v1)
- In the Beko industrial study, practitioners reported "faulty reviews, unnecessary corrections, and irrelevant comments". — [arXiv 2412.18531](https://arxiv.org/pdf/2412.18531)
- Copilot users report repeated false flags on frontend case-conversion fields and on documented Laravel methods. — [GitHub #190754](https://github.com/orgs/community/discussions/190754)

**Cost**
- Claude Code Review at $15–25/PR was criticized as far pricier than Copilot, where review then used one premium request from an included allowance. — [VentureBeat](https://venturebeat.com/technology/anthropic-rolls-out-code-review-for-claude-code-as-it-sues-over-pentagon); [TechRadar](https://www.techradar.com/pro/anthropic-launches-a-new-code-review-tool-to-check-ai-generated-content-but-it-might-cost-you-more-than-youd-hope)
- Copilot's metered billing drew about 958 thumbs-down. One Pro+ user said 8% of monthly credits were gone in two hours. Users talk of moving to BYO-model setups. — [GitHub #192948](https://github.com/orgs/community/discussions/192948)
- Claude's "After every push" mode "multiplies cost by the number of pushes", and it is the default for newly added repos. — [Docs: costs](https://code.claude.com/docs/en/code-review-costs)

**Speed**
- Claude Code Review averages about 20 minutes. — [Anthropic blog](https://claude.com/blog/code-review)
- After an LLM reviewer was added at Beko, average PR closure time rose from 5h52m to 8h20m (statistically significant). — [arXiv 2412.18531](https://arxiv.org/pdf/2412.18531)
- A PR-Agent tool makes one LLM call in about 30 s. — [PR-Agent README](https://github.com/qodo-ai/pr-agent)

**Privacy and security**
- CodeRabbit RCE: a crafted PR carrying a malicious `.rubocop.yml` ran code on production servers and leaked credentials, including the GitHub App private key, opening potential read/write access to about 1M repos and the ability to clone private repos. It was found Dec 2024, fixed Jan 2025 (Rubocop disabled, secrets rotated, then sandboxed) and published Aug 19, 2025. — [Kudelski Security](https://kudelskisecurity.com/research/how-we-exploited-coderabbit-from-a-simple-pr-to-rce-and-write-access-on-1m-repositories); [Endor Labs](https://www.endorlabs.com/learn/when-coderabbit-became-pwnedrabbit-a-cautionary-tale-for-every-github-app-vendor-and-their-customers)
- Anthropic Code Review is not available to orgs using Zero Data Retention, HIPAA or CMEK, and it runs only on Anthropic infrastructure. — [Docs](https://code.claude.com/docs/en/code-review)
- Greptile reportedly trains on de-identified data by default (unverified). — [Repowise](https://repowise.dev/blog/comparisons/greptile-pricing)

**Not learning team conventions**
- Copilot ignores prior threads and explicit instructions (see #190754 above). Greptile found that prompting could not cut nits without also cutting critical comments, and that asking an LLM to rate severity failed. — [ZenML case study](https://www.zenml.io/llmops-database/improving-ai-code-review-bot-comment-quality-through-vector-embeddings)
- Anecdote from an independent field report: for most clients, paid AI review was "no, not really" worth it, because "the UI was broken" and the model was not good enough. — [Martin Zoeller](https://www.martinzoeller.com/en/blog/coderabbit-ai-review-is-it-worth-it)

### Inferences
- Re-reviews are the biggest unsolved complaint for the largest player (Copilot). Being stable across pushes is a concrete, demo-able wedge: never repeat a rejected point, verify fixes instead of rescanning, post everything in one batch, and cap rounds.
- Bot content that overwrites human text (PR descriptions) or adds whimsy (poems, fortunes) gets turned off quickly. A new entrant should default to no summary rewrite, no poem, a collapsed or short summary, and generated files excluded.
- Privacy fear is real, and the CodeRabbit RCE is the reference incident. A small vendor can answer it with: no code retention, no linters executing repo-supplied config, a minimal GitHub App permission set, and an optional BYO-key or self-host mode.

### Gaps
- Reddit (r/ExperiencedDevs, r/programming) threads could not be fetched or found through search; the sentiment above comes from HN, GitHub, DEV and blogs.
- No quantified uninstall or churn rates were found for any vendor.
- No primary source was found for line-anchor errors (comments on the wrong line). The Claude docs mention findings "GitHub didn't accept" as inline comments being moved to the check-run table instead, which implies anchoring failures happen, but this was not quantified.

## 3. Small mechanisms that reduce noise and build trust (what leaders actually ship)

### Takeaway
The most trusted designs share a handful of small mechanisms: explicit severity tiers with nits capped or hidden; post nothing when confidence is low; self-resolve threads when the fix lands; read the author's replies before re-flagging; incremental re-review that says what it suppressed; skip reviews on no-op pushes; inline suggested-change blocks (the strongest predictor of a comment being acted on); a repo config file for rules, skips and nit caps; learning from thumbs and replies; and visible cost controls. Anthropic's Code Review ships nearly all of these and is the most complete public reference design. Its gaps are price ($15–25/PR), speed (about 20 min) and GitHub-only.

### Cited Findings
**Severity tiers and filtering**
- Claude: 🔴 Important ("should be fixed before merging"), 🟡 Nit ("worth fixing but not blocking"), 🟣 Pre-existing ("exists in the codebase but wasn't introduced by this PR"). — [Docs: PR reviews](https://code.claude.com/docs/en/code-review-pull-requests)
- Codex flags only P0/P1 in GitHub. — [OpenAI docs](https://developers.openai.com/codex/integrations/github)
- Gemini's `.gemini/config.yaml` sets a minimum comment severity. — [Qodo glossary](https://www.qodo.ai/glossary/what-is-gemini-code-assist-code-review/)
- CodeRabbit offers Quiet, Chill and Assertive profiles. — [GitHub PR #55](https://github.com/pr0d1r2/nix-lefthook-bats-changed/pull/55)
- Scoping to real bugs and security matters: Graphite says that after it narrowed AI reviews to that overlap, about 52% of comments led to a code change. OpenAI reportedly added a rule to Codex's review step to return no findings unless the author would want them fixed (secondhand). — [Cursor guide](https://cursor.com/guides/ai-code-review)

**Confidence threshold and "stay silent"**
- Anthropic's open-source `/code-review` plugin runs 4 parallel agents: 2 for CLAUDE.md compliance, 1 for bugs and 1 for git-history context. A separate scorer rates each issue 0–100, issues below 80 are dropped, and "If nothing reaches 80, no review is posted." It explicitly excludes pre-existing issues, "code that looks like a bug but isn't", pedantic nitpicks, anything linters catch, and lint-ignored lines. — [claude-code plugin README](https://github.com/anthropics/claude-code/blob/main/plugins/code-review/README.md)
- Claude Code Review posts an explicit "Code review found no issues" note and check-run title instead of padding with comments. — [Docs](https://code.claude.com/docs/en/code-review)

**Self-resolving, reply-aware and incremental re-review**
- Claude: "The next review… resolves its earlier thread when it judges the issue fixed." It "reads the replies on its earlier findings, and can resolve the thread or post one follow-up reply." If a finding keeps returning, maintainers add a REVIEW.md rule. — [Docs: PR reviews](https://code.claude.com/docs/en/code-review-pull-requests)
- Claude's incremental re-review "focuses on what changed since the last review and posts fewer nits and pre-existing findings". It states what it left out, for example "...outside the scope of this re-review and not posted" and "...found and not posted". A full `@claude review` covers everything again. — [Docs: PR reviews](https://code.claude.com/docs/en/code-review-pull-requests)
- No-op push detection: when a PR "still adds and removes the same lines" (empty commit, clean rebase or merge), the check reads "Code review skipped — no new changes" or "not repeated — earlier findings still open", so no tokens are spent. — [Docs: PR reviews](https://code.claude.com/docs/en/code-review-pull-requests)
- The Claude check run is neutral and never fails. It carries a machine-readable last line, `<!-- bughunter-severity: {"nit":1,"normal":2,"pre_existing":0} -->`, so teams can gate merges themselves. — [Docs: PR reviews](https://code.claude.com/docs/en/code-review-pull-requests)
- Claude's trigger controls: `@claude review` (once), `review always` (subscribe), `review stop/pause/off`. Drafts and forks are skipped automatically, and only users with write access can trigger. A July 2026 change made plain `@claude review` stop auto-subscribing the PR. — [Docs: PR reviews](https://code.claude.com/docs/en/code-review-pull-requests)
- Users ask Copilot for the same things: verify only previous comments after a fix push, post everything at once, auto-dismiss stale comments. — [GitHub #189767](https://github.com/orgs/community/discussions/189767); [#188134](https://github.com/orgs/community/discussions/188134); [#187953](https://github.com/orgs/community/discussions/187953)

**Explaining why and linking evidence**
- Claude findings carry a collapsed "Why this was flagged" section: "why Claude flagged the issue and how it verified the problem." — [Docs: PR reviews](https://code.claude.com/docs/en/code-review-pull-requests)
- REVIEW.md can require evidence, for example "behavior claims need a `file:line` citation in the source, not an inference from naming", which "cuts false positives that would otherwise cost the author a round trip." — [Docs: customize](https://code.claude.com/docs/en/code-review-customize)
- The plugin links to code with full-SHA permalinks plus line ranges (`/blob/[full-sha]/path#L67-L72`). — [plugin README](https://github.com/anthropics/claude-code/blob/main/plugins/code-review/README.md)

**Suggested-change blocks and short comments**
- An inline code suggestion is the strongest predictor that a comment gets resolved (odds ratio about 1.62 per a summary). Long, complex comments get resolved less often. — [arXiv 2607.21997](https://arxiv.org/abs/2607.21997); [Pith summary](https://pith.science/paper/2607.21997)
- Sun et al. (2025, about 22k AI review comments): actionable comments with concrete code suggestions are significantly more likely to trigger code changes (secondhand citation). — [arXiv 2604.24450 citing it](https://arxiv.org/html/2604.24450v1)

**Repo config files**
- Claude `REVIEW.md` can redefine what Important means, cap nits ("Report at most five Nits per review"), list "Do not report" items (CI-enforced lint, generated files, lockfiles), list "Always check" items, and set a stricter bar for paths ("in `scripts/`, only report if near-certain and severe"). It is read only from the base or default branch, never from the PR itself, which blocks prompt injection through the PR. — [Docs: customize](https://code.claude.com/docs/en/code-review-customize)
- Other config files: CodeRabbit `.coderabbit.yaml` (path_filters, path_instructions, poem, collapse_walkthrough, profile) — [PR #55](https://github.com/pr0d1r2/nix-lefthook-bats-changed/pull/55); Gemini `.gemini/styleguide.md` — [Google blog](https://blog.google/intl/en-ca/products/cloud/get-coding-help-from-gemini-code-assist-now-for-free/); Codex reads AGENTS.md — [openaca PR #210](https://github.com/open-agent-security/openaca/pull/210)

**Learning from feedback**
- Greptile turned its thumbs-up/down and addressed/ignored history into an embedding filter: new comments that resemble ones the team previously downvoted get suppressed. The addressed rate rose from 19% to 55+% within two weeks (2024 data). Prompting and LLM severity-rating failed before this worked. — [ZenML case study](https://www.zenml.io/llmops-database/improving-ai-code-review-bot-comment-quality-through-vector-embeddings)
- Bugbot's learned rules come from reactions and replies and from human reviewer comments (Apr 2026). — [Cursor blog](https://cursor.com/blog/bugbot-learning)
- Graphite's dashboard shows acceptance rate and downvote rate, filterable by repo and time. The CEO's talk cites about 52% of Diamond comments integrated, against about 45–50% for human comments, and under 4% downvoted. — [Graphite docs](https://graphite.com/docs/ai-review-comments); [AI Engineer talk](https://ai.engineer/talks/H6MrR5NbTZA-dont-get-one-shotted-use-ai-test)

**Cost and usage transparency**
- Claude has an org monthly spend cap. When budget is short it skips the review and posts a PR comment naming the cause. Analytics show PRs reviewed, monthly cost, comments auto-resolved because a dev fixed the issue, and per-repo average cost per review. Anthropic also recommends a pilot on "Once after PR creation" to estimate spend. — [Docs: costs](https://code.claude.com/docs/en/code-review-costs)

### Inferences
- Micro-features that are cheap to build, mapped to the pains above:
  1. A "verified because…" line on each comment, quoting the call site or line the Critic checked, with a full-SHA permalink. Claude hides this in a collapsible; showing one line of evidence inline could be the visible trust signal.
  2. Default to silence: one short "No verified issues (N candidates rejected by Critic)" comment. Showing the rejected count makes the Critic visible and reframes silence as diligence.
  3. Re-review contract: on push, verify open findings first, then review only new hunks. Never re-raise a finding the author replied "won't fix" to (fingerprint by file, symbol and issue type). Post one batch. Cap at N rounds.
  4. Auto-resolve its own threads when fixed, and report "2 of 3 issues fixed" in the summary.
  5. A nit cap, with nits off by default and folded into one collapsed digest comment instead of inline.
  6. A suggestion block whenever the fix fits in 10 lines or fewer, since this is the strongest predictor of resolution.
  7. Cost and time per review in the footer (for example "Reviewed in 48s · 1,234 tokens · ~250₫"). No competitor surfaces per-review cost to developers on the PR itself. Claude shows it only in admin analytics.
  8. Never touch the PR description, never request changes or block, and use a neutral check with machine-readable counts.
  9. Read config only from the default branch (copying Claude's injection guard), and skip lockfiles and generated files by default.
- A thumbs-down that writes a rule the team can see and edit (for example appending to a `.reviewbot.md` or a dashboard list) is cheap and is a learning loop developers can audit. That fits a solo founder better than embedding infrastructure.

### Gaps
- Exact Bugbot BUGBOT.md and learned-rules UX, and CodeRabbit "learnings" behavior, could not be fetched from primary docs.
- No primary data on how much each mechanism moves retention. The evidence links mechanisms to resolution rates, not to churn.

## 4. Evidence on precision vs recall, acceptance and "addressed" rates, and verification/critic passes

### Takeaway
Real-world acceptance of AI review comments varies enormously. At the low end, 0.9–19% of comments from GitHub Action reviewers are addressed, against 60% for human comments, and the MSR 2026 study finds signal ratios under 60% for 12 of 13 agents. At the high end, filtered or verified systems reach 38.7% resolution (RovoDev, vs 44.5% for humans), 52–78% in vendor claims (Graphite, Bugbot), 73.8% in the Beko PR-Agent deployment and 72.9% for Copilot in a large study. The systems with good numbers all add a filter stage: an LLM judge, a quality classifier, feedback embeddings, a confidence threshold or a verifier. Benchmarks show the precision–recall tradeoff directly: high-recall tools such as Claude Code (23% precision) and Tenki (30% precision) are the noisy ones. Developers say they prefer precision, and their churn behavior matches. Verification research supports critic passes but warns they can suppress real bugs and that agents can agree on false findings.

### Cited Findings
**Field acceptance and resolution rates**
- Beko (ICSE-SEIP 2025, Qodo PR-Agent with GPT-4 Turbo): 73.8% of bot comments were resolved across 4,335 PRs, 1,568 of them auto-reviewed, with 238 practitioners. PR closure time rose 5h52m → 8h20m, and most respondents saw only a minor quality improvement. Caveat: some comments arrived after the PR had closed. — [arXiv 2412.18531](https://arxiv.org/pdf/2412.18531); [ResearchGate](https://www.researchgate.net/publication/387382736_Automated_Code_Review_In_Practice)
- Atlassian RovoDev (ICSE-SEIP 2026; June 2024–June 2025; 2,000+ repos; 54,000+ comments): 38.70% code-resolution rate against 44.45% for human comments. PR cycle time fell 30.8% and human-written comments fell 35.6%. Architecture: a generator, then an LLM-as-judge returning binary True/False on whether the comment fits the PR and the changed code ("avoids subjective threshold selection" of score-based judges), then a ModernBERT quality filter that removes vague and non-actionable comments. The judge reportedly runs on gpt-4o-mini (secondary). — [arXiv 2601.01129](https://arxiv.org/abs/2601.01129); [ACM DL](https://dl.acm.org/doi/10.1145/3786583.3786851); [Atlassian blog](https://www.atlassian.com/blog/ai-at-work/developer-productivity-improved-with-rovo-dev)
- "Go Home Copilot" (Cynthia, Widyasari, Roy, Zhang, Lo; about 54.8k comments, 341 repos): Copilot comments resolved 72.9%; Cursor 67.2% and Codex 54.8% per a third-party summary. Core developers resolve most agent feedback. A critique notes possible contamination by human comments. — [arXiv 2607.21997](https://arxiv.org/html/2607.21997v1); [Zenodo](https://zenodo.org/records/19247232); [Pith](https://pith.science/paper/2607.21997)
- Gan et al. (2025, arXiv 2508.18771), via a citing paper: human comments addressed 60% of the time against 0.9%–19.2% for comments from code review agents running in GitHub Actions. Secondhand. — [arXiv 2604.24450](https://arxiv.org/html/2604.24450v1)
- MSR 2026: CRA-only PRs merge at 45.2% vs 68.4% for human-only; 12 of 13 CRAs have average signal under 60%. — [arXiv 2604.03196](https://arxiv.org/html/2604.03196v1)
- Vendor claims: Bugbot 78.13% resolution (50,310 PRs) — [Cursor](https://cursor.com/blog/bugbot-learning); Graphite about 52% integrated with under 4% downvotes, plus a 67% "implementation rate" and 96% positive feedback on marketing pages — [AI Engineer talk](https://ai.engineer/talks/H6MrR5NbTZA-dont-get-one-shotted-use-ai-test), [Graphite reviewer page](https://graphite.dev/reviewer); Anthropic under 1% of findings marked incorrect — [Anthropic](https://claude.com/blog/code-review); Greptile addressed rate 19% → 55%+ after feedback filtering — [ZenML](https://www.zenml.io/llmops-database/improving-ai-code-review-bot-comment-quality-through-vector-embeddings)

**The precision–recall tradeoff in benchmarks**
- Augment: Claude Code had 51% recall but 23% precision (F 31%); Augment had 65% P / 55% R. — [Augment](https://www.augmentcode.com/blog/we-benchmarked-7-ai-code-review-tools-on-real-world-prs-here-are-the-results)
- Tenki: 68.9% recall at 29.9% precision. — [Tenki](https://tenki.cloud/benchmarks/code-reviewer)
- Qodo was reported #1 for precision (63.4%) on Martian's bench in March 2026; Baz claims #1 in precision on the same bench. — [Wikipedia](https://en.wikipedia.org/wiki/Qodo); [Baz](https://baz.ai/resources/blog/baz-1-in-precision-in-independent-code-review-bench)
- A survey of 2026 benchmarks notes that ground-truth labels are noisy because developers do not fix every real defect. — [Medium (codzee)](https://medium.com/@codzee.io/we-compared-the-public-ai-code-review-benchmarks-from-2026-methodology-datasets-metrics-and-269dd35637a6)
- A blog citing Nutanix's CR-Bench says agents built to "find all hidden issues" show low signal-to-noise. — [jyoung.dev](https://jyoung.dev/blog/review-capacity-agent-throughput/)

**Verification and critic research**
- "Sifting the Noise" (arXiv 2601.22952): LLM agents filtering SAST false positives cut the OWASP Benchmark FP rate from over 92% to as low as 6.3%, and identified up to 93.3% of false positives on real CodeQL alerts. Gains are large for strong models (Claude Sonnet 4, GPT-5) and inconsistent for weak ones. Aggressive FP reduction can suppress true vulnerabilities. — [arXiv 2601.22952](https://arxiv.org/html/2601.22952v3)
- "Refute-or-Promote" (arXiv 2604.19049): adversarial, stage-gated multi-agent review for high precision. Cautionary result: 80+ agents, including dedicated adversarial reviewers, unanimously endorsed a Bleichenbacher padding oracle in OpenSSL CMS that did not exist. — [arXiv 2604.19049](https://arxiv.org/pdf/2604.19049)
- QASecClaw (arXiv 2605.01885): an LLM filter over SAST findings that keeps only true positives, but fails open by keeping the whole batch if the LLM call fails, times out or returns malformed JSON. SQLi F1 was 94.05%. — [arXiv 2605.01885](https://arxiv.org/html/2605.01885v1)
- CodeX-Verify (arXiv 2511.16708): 4 parallel agents still had a 50% FP rate, attributed to flagging quality issues instead of functional bugs. — [arXiv 2511.16708](https://arxiv.org/html/2511.16708)
- Greptile found that LLM self-rating of severity did not work as a filter, while real feedback did. — [ZenML](https://www.zenml.io/llmops-database/improving-ai-code-review-bot-comment-quality-through-vector-embeddings)
- Anthropic's production design is find → verify → rank. It says verification checks "candidate findings against the code", without public detail. The open plugin uses an independent per-issue scorer with a threshold of 80. — [Docs](https://code.claude.com/docs/en/code-review); [plugin README](https://github.com/anthropics/claude-code/blob/main/plugins/code-review/README.md)

### Inferences
- The two-pass Reviewer + adversarial Critic matches the best-evidenced pattern: RovoDev's judge plus filter, Anthropic's verify step, the plugin's scorer. Three published design lessons apply directly:
  1. Ask the Critic a binary question with evidence ("Is this real? cite file:line"), not a 1–10 score (RovoDev, Greptile).
  2. A cheap model can work as the judge (RovoDev reportedly used gpt-4o-mini), but FP-filter gains depend strongly on model strength (Sifting the Noise). A reasonable design is a cheap Reviewer and a stronger Critic, since the Critic sees only a few candidates.
  3. Agents can agree on false findings (Refute-or-Promote), so ground the Critic in retrieved code (call sites, definitions) rather than in debate.
- Decide fail-open vs fail-closed explicitly. A precision-first product should fail closed: if the Critic errors, post nothing or post "unverified" in a collapsed digest, unlike QASecClaw's fail-open.
- Target metric for marketing: an addressed or resolved rate measured and shown per repo (Claude, Graphite and Bugbot all use it). A solo vendor that shows its own per-repo resolution rate on a public dashboard gains credibility that benchmark claims no longer carry.
- The precision bias is backed by behavior: churn stories are all about noise, while missed bugs rarely cause uninstalls. Positioning as "fewer, verified comments" is evidence-based. Recall still matters for credibility, so measure it on Martian's open bench.

### Gaps
- Primary text of Gan et al. (2508.18771) and Sun et al. was not read; their figures are secondhand.
- No published A/B study isolates the effect of adding a critic pass on developer acceptance in production. RovoDev reports the whole system, not an ablation in the summary seen.
- No study found that directly measures stated developer preference for precision vs recall in percentages.

## 5. Pricing psychology for indie devs, small teams and agencies (Vietnam/SEA focus)

### Takeaway
Global evidence favors predictable, low-commitment pricing for small teams. Per-seat prices of $12–30/mo are the norm. Per-PR premium pricing ($15–25) triggered backlash, and metered surprises (Copilot) triggered anger. Free-for-OSS is near-universal and expected. No Vietnam/SEA-specific data could be gathered: the search budget ran out, and Viblo, VOZ and ITviec were unreachable. VND pricing, local payment rails and willingness-to-pay are open questions to verify.

### Cited Findings
- Per-seat anchors for small teams: Bito $12–15, Sourcery $12–15, CodeRabbit $24–30 (billed only for devs who open PRs), Greptile $30, CodeAnt about $24, Baz $30 plus credits, Copilot Pro $10 (seat unchanged; review now draws credits). — [StackPick Bito](https://stackpick.net/pricing/bito-ai/); [Augment comparison](https://www.augmentcode.com/tools/ai-code-review-tools-comparison); [cubic pricing](https://www.cubic.dev/blog/ai-code-review-pricing); [GitHub #192948](https://github.com/orgs/community/discussions/192948)
- Per-unit anchors: Claude $15–25/review; Copilot $0.05–$5 credits/review plus $0.006/Actions-minute; Bugbot about $1–1.50/run; CodeRabbit overage $0.25/file; Greptile $1/extra credit (Base = 1 credit, Apex = 10); Bito $5 per 1,000 extra lines; self-hosted PR-Agent about $0.02–$0.10/review; Qodo pooled credits $0.012. — sources as cited in Section 1
- 10-dev team monthly seat cost: CodeRabbit Essentials $240, Team $480, Greptile Pro $300 (before overages). — [cubic pricing (via search)](https://www.cubic.dev/blog/ai-code-review-pricing)
- Reaction to per-PR pricing: "Anthropic wants $25 per pull request. Devs are losing their minds." — [Level Up Coding](https://levelup.gitconnected.com/anthropic-wants-25-per-pull-request-devs-are-losing-their-minds-over-claude-code-review-55dbbaca4996)
- Reaction to metered billing (Copilot): "bait and switch", refund requests, a user reporting 8% of credits used in two hours, and talk of BYO-model alternatives. — [GitHub #192948](https://github.com/orgs/community/discussions/192948)
- Free-for-OSS norms: CodeRabbit free on public repos; Greptile free for non-commercial OSI OSS; Copilot reviews on public repos exempt from Actions minutes; Ellipsis free public repos (one source). — [WeavAI](https://weavai.app/blog/en/2026/05/12/coderabbit-2026-ai-code-review-pricing-alternatives/); [Macroscope](https://macroscope.com/content/greptile-pricing-2026); [cubic Copilot](https://www.cubic.dev/blog/github-copilot-code-review); [xpay.sh](https://www.xpay.sh/saas-pricing/ellipsis-dev/)
- Startup discounting: Greptile gives 50% off to startups under $2M revenue. — [Macroscope](https://macroscope.com/content/greptile-pricing-2026)
- Spend-predictability features are now expected: Claude has an org spend cap, skip-with-explanation when budget is short, and a recommended pilot to estimate cost. Copilot keeps completions running when credits run out but pauses other features. — [Docs: costs](https://code.claude.com/docs/en/code-review-costs); [GitHub #192948](https://github.com/orgs/community/discussions/192948)
- Free routes for small teams are closing: Gemini's free GitHub review ended July 17, 2026; Amazon Q closed to new signups May 15, 2026; GitHub paused Copilot trials and removed free models. — [StackPick](https://stackpick.net/blog/gemini-code-assist-pricing-2026/); [Javis Review](https://javisreview.com/review/amazon-q-developer-review-2026/); [GitHub #192948](https://github.com/orgs/community/discussions/192948)

### Inferences
- For indie developers and agencies, a hybrid tends to fit best: a small flat base or prepaid wallet plus a cheap per-PR rate with a hard cap. Pure per-seat penalizes agencies with many occasional contributors (CodeRabbit already bills only PR authors for this reason). Pure metering without caps causes Copilot-style anger. A prepaid wallet with a visible per-PR cost shown on the PR fits both.
- Messaging anchor: Claude's verified multi-agent review costs about $15–25 per PR. A Reviewer+Critic at roughly $0.10–$0.30 per PR is two orders of magnitude cheaper and still "verified". The founder must check that their LLM costs support this.
- Assumption-flagged arithmetic (no sourced exchange rate gathered): at about 25,000–26,500 VND/USD, $24/seat ≈ 600k–640k VND/month and $12 ≈ 300k–320k VND. A per-PR price of 2,000–5,000 VND would undercut every competitor per review. Verify the exchange rate and local salary data before use.
- Free-for-OSS is a must-have for acquisition and credibility. A free tier for public repos, capped by PRs per month, also builds the public, inspectable track record that benchmark claims lack.

### Gaps
- **Not researched (search budget exhausted):** Vietnamese developer salaries in 2026 (TopDev/ITviec reports), Vietnamese dev community discussion of AI reviewers (Viblo, VOZ, Facebook groups), local payment rails for SaaS (VietQR, MoMo, ZaloPay, card penetration), whether Stripe supports Vietnam-based merchants (unverified; reportedly not, from prior knowledge), VAT/foreign-contractor tax on SaaS sold in VND, and any PPP or regional pricing by competitors in SEA.
- No survey data was found on willingness to pay for AI code review among indie developers or small teams, globally or in SEA.
- No competitor was found offering VND pricing or local payment methods. This was not verified, only not encountered.
