# OK AI platform

Four AI products on one account and one wallet:

1. **Gateway** – one OpenAI-compatible API for many models, with smart routing, fallback and cost tracking.
2. **Agents** – hosted, isolated AI agents with business integrations (Zalo OA, KiotViet, Haravan, Shopify, …).
3. **Safe** – check links, phone numbers, bank accounts, messages and media for scams and AI fakes.
4. **Review** – GitHub pull-request review with a Reviewer pass and an adversarial Critic pass.

See [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) for the architecture and engineering rules.

```bash
pnpm install
pnpm -r typecheck && pnpm -r test
```
