import { describe, expect, it } from 'vitest';
import { formatUsd, tokenCostMicros, usdToMicros } from './money';

describe('money', () => {
  it('computes token costs in micro-USD and rounds up', () => {
    expect(tokenCostMicros(1_000_000, 2.5)).toBe(2_500_000);
    expect(tokenCostMicros(1, 0.15)).toBe(1);
    expect(tokenCostMicros(0, 10)).toBe(0);
  });
  it('converts and formats', () => {
    expect(usdToMicros(1.25)).toBe(1_250_000);
    expect(formatUsd(2_500_000)).toBe('$2.50');
    expect(formatUsd(150)).toBe('$0.000150');
  });
});
