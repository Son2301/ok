# Handoff

- Task ID / checkpoint: founder-gateway-analysis / 1
- Updated at: 2026-10-29
- Status: paused; analysis committed, CFO rerun waiting on the owner's real numbers
- Repository / branch: ~/Minh / docs/founder-gateway-analysis (branched from docs/adopt-master-guidance)

## Goal
Pressure-test Minh AI as a business with the founder skill pack. No product code changed.

## Done (all in `founder/`)
- `/founder-board` → `board.md`: 3× "fund if", 4.3/10. Strongest version: Gateway only, verified-authentic AI access for VN devs paid in đồng.
- `/founder-consumer` (100 simulated buyers) → `customer.json`, `pitch.md`, `panel/results.md`: 61 buy / 39 pass. CTO/SME 84%, grey-market 10%. The VAT e-invoice drives buying; trust and grey-market price drive passing.
- `/founder-pricing` → `pricing.md`, `pricing-curve.md`: acceptable range 22,979–27,973đ per US$1; recommended 27,000đ, a 3-rung ladder, test 26,500 vs 27,500.
- `/founder-cfo` → `numbers.json`, `cfo.md`, `cfo-sources.md`: **at 27,000đ each US$1 loses ~65đ** (Minh also pays its own ~2.5% card FX fee to providers). Year 1 −229M đ; ~290M đ cash needed. A 10% provider discount → +2,535đ/$ and +2% margin at plan. Provider cost, not price, is the lever.

## Next action
Owner will supply real inputs; rerun `/founder-cfo` with them (replace estimates in `founder/numbers.json`, mark each as owner-supplied in `cfo-sources.md`):
1. Bank foreign-transaction fee (assumed 2.5%) or the bank's US$ rate
2. Provider terms per provider: discount/volume tier, card vs USD transfer, written resale permission (assumed list price, no discount)
3. Monthly hosting (assumed 2.5M đ)
4. Founder pay (assumed 15M đ placeholder)
Optional: e-invoice + SePay plan prices (0.8M đ), actual USD buy rate (~26,000đ), setup quotes (61M đ).
Then update `founder/pricing.md` if the margin changes (it still says ~1,000đ margin, which the CFO run disproved), then `/founder-offer`.

## Caveats
- All buyer answers are simulated: buy rate is an upper bound.
- Grey-market ~1,600đ/$ figure comes from the strategy report and may be a misreading.
- VAT on resold tokens is not in the numbers; an accountant must check it.
- Earlier work (guidance masterfiles) is on `docs/adopt-master-guidance`, in review as a PR.
