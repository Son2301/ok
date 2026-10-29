# CFO note: the 27,000đ margin does not hold

All figures in đồng. Every input is an estimate (see [cfo-sources.md](cfo-sources.md)); an accountant should check structure, payroll and tax, above all VAT on resold tokens, before money moves.

- **The margin:** at 27,000đ each US$1 sold **loses 65đ** before any fixed cost. Provider cost (26,000đ) plus Minh's own card FX fee paying providers (650đ), failed-request credits (135đ) and the free sign-up credit (280đ) come to 27,065đ. At plan (300 US$/day) the profit margin is **-8%**. The ~1,000đ margin in pricing.md forgot that Minh also pays providers in dollars.
- **The line to watch: provider cost.** Price moves at the top of the panel's range barely help (27,973đ → contribution 908đ, break-even 691 US$/day, still -4% at plan). A 10% provider discount (cost 23,400đ) → contribution 2,535đ, break-even 248 US$/day, **+2% at plan**. The business is a provider-deal business, not a pricing one.
- **Cash:** at 27,000đ the year-1 operating loss is 229M đ; with 61M đ startup, **about 290M đ** is needed and it is not earned back in year 1. With the 10% discount: ~158M đ.
- **Three ways to improve, each run in the tool:**
  1. Provider discount of 10%: contribution -65 → 2,535đ; year 1 -229M → -94M đ.
  2. Price 28,500đ (above the panel's 27,973đ ceiling, so it costs buyers): contribution 1,435đ; break-even 437/day; year 1 -151M đ.
  3. Pay providers without the card FX fee (domestic USD account, ~0.5%): contribution 455đ; year 1 -202M đ. Dropping the free credit alone only reaches 215đ.
- **Board money conditions:** not met. Real prices and margin after provider cost, VAT and fees — now known to be negative without a provider deal. CAC, budget and runway: unknown. VAT treatment: unresolved and not in these numbers; if VAT falls on Minh, the loss grows.
- **Founder pay** is a 15M đ/month placeholder; at 0 the fixed cost is 3.8M đ, but at 27,000đ the per-unit loss means no volume breaks even.

# Unit economics: Minh AI Gateway (all figures in đồng; every input is an estimate, see cfo-sources.md)

Every number below comes from the input file. Nothing is looked up or guessed.

## One US1 of model usage sold

| line | per US1 of model usage sold |
| --- | ---: |
| Price | 27,000.00 |
| Provider cost at bank rate (26,000đ/$) | -26,000.00 |
| Minh's own card FX fee paying providers (~2.5%) | -650.00 |
| Failed requests credited back (~0.5%) | -135.00 |
| Free 50,000đ sign-up credit, amortised (~2 sign-ups per payer, 360/yr per payer) | -280.00 |
| **Contribution** (what each US1 of model usage sold leaves to pay the fixed costs) | **-65.00** (-0%) |

## The margin that matters

Fixed costs: 18,800,000 a month (Cloud hosting, Postgres, monitoring 2,500,000, E-invoice service + SePay plan 800,000, Domains, email, misc software 500,000, Founder pay (placeholder) 15,000,000).

- **Break-even: never (each unit loses money) US1 of model usage sold a day.** Below that you lose money every month.
- **Profit margin at your plan** (300 a day): **-8%** of every sale, after every cost.

## Year 1, month by month

| month | US1 of model usage sold a day | revenue | profit | cumulative (after 61,000,000 startup) |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 20 | 16,200,000 | -18,839,000 | -79,839,000 |
| 2 | 35 | 28,350,000 | -18,868,250 | -98,707,250 |
| 3 | 55 | 44,550,000 | -18,907,250 | -117,614,500 |
| 4 | 80 | 64,800,000 | -18,956,000 | -136,570,500 |
| 5 | 105 | 85,050,000 | -19,004,750 | -155,575,250 |
| 6 | 130 | 105,300,000 | -19,053,500 | -174,628,750 |
| 7 | 155 | 125,550,000 | -19,102,250 | -193,731,000 |
| 8 | 180 | 145,800,000 | -19,151,000 | -212,882,000 |
| 9 | 205 | 166,050,000 | -19,199,750 | -232,081,750 |
| 10 | 230 | 186,300,000 | -19,248,500 | -251,330,250 |
| 11 | 255 | 206,550,000 | -19,297,250 | -270,627,500 |
| 12 | 280 | 226,800,000 | -19,346,000 | -289,973,500 |

- **Year 1 operating profit: -228,973,500** on 1,401,300,000 of revenue.
- After the 61,000,000 startup spend: -289,973,500.
- Startup money earned back: not within year 1.
- Cash you need before it pays for itself: **289,973,500**.

## What if

| scenario | margin at plan | break-even a day | year 1 profit |
| --- | ---: | ---: | ---: |
| Base plan | -8% | never | -228,973,500 |
| Price -10% | -20% | never | -369,103,500 |
| Volume -20% | -10% | never | -228,298,800 |
| Unit costs +15% | -23% | never | -439,674,525 |

## Red flags

- Each unit loses money before rent and salaries: the price is below the variable cost.
- Year 1 loses money on operations (-228,973,500).
- The startup spend is not earned back within year 1.
