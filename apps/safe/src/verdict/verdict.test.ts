import { describe, expect, it } from 'vitest';
import { buildShareText, defaultSummary, VerdictBuilder } from './builder';
import { combineSignals, LLM_MAX_DOWN, LLM_MAX_UP, levelFor } from './scoring';
import { signal } from './signal';
import { verdictSchema } from './types';

const s = (w: number, source = 'rules') =>
  signal(`t.${w}.${source}`, w, { vi: `Dấu hiệu ${w}`, en: `Signal ${w}` }, source);

describe('scoring formula', () => {
  it('combines risk with noisy-OR and scales by trust', () => {
    expect(combineSignals([]).score).toBe(0);
    expect(combineSignals([s(50)]).score).toBe(50);
    expect(combineSignals([s(50), s(50)]).score).toBe(75);
    expect(combineSignals([s(90), s(-90)]).score).toBe(9);
    expect(combineSignals([s(100), s(100)]).score).toBe(100);
  });

  it('caps the LLM contribution in both directions', () => {
    expect(combineSignals([s(10), s(80, 'llm')]).score).toBe(10 + LLM_MAX_UP);
    expect(combineSignals([s(80), s(-80, 'llm')]).score).toBe(80 - LLM_MAX_DOWN);
    expect(combineSignals([s(-50, 'llm')]).score).toBe(0);
  });

  it('maps scores to levels; "safe" needs trust evidence', () => {
    expect(levelFor(80, [s(80)])).toBe('critical');
    expect(levelFor(60, [s(60)])).toBe('high');
    expect(levelFor(30, [s(30)])).toBe('medium');
    expect(levelFor(5, [s(5)])).toBe('low');
    expect(levelFor(0, [])).toBe('low');
    expect(levelFor(0, [s(-90)])).toBe('safe');
    expect(levelFor(0, [], { insufficientData: true })).toBe('unknown');
    expect(levelFor(90, [s(90)], { maxLevel: 'medium' })).toBe('medium');
  });
});

describe('user-facing wording', () => {
  it('never claims "safe"/"an toàn" and mentions changing tactics for low results', () => {
    for (const level of ['low', 'safe'] as const) {
      const sum = defaultSummary('url', level, [s(-90)]);
      expect(sum.vi).toContain('Chưa phát hiện dấu hiệu lừa đảo');
      expect(sum.vi.toLowerCase()).not.toContain('an toàn');
      expect(sum.en.toLowerCase()).not.toMatch(/\bsafe\b/);
      expect(sum.vi).toContain('đổi thủ đoạn');
    }
    expect(defaultSummary('phone', 'low', [], { limitedData: true }).vi).toContain('chưa đủ dữ liệu');
    expect(defaultSummary('text', 'unknown', []).vi).toContain('Chưa đủ dữ liệu');
  });

  it('talks about warning signs, not real/fake, for media', () => {
    const high = defaultSummary('image', 'high', [s(80)]);
    expect(high.vi).toContain('dấu hiệu cảnh báo');
    expect(high.vi).toContain('không công cụ nào');
    expect(defaultSummary('image', 'low', []).vi).toContain('Chưa thấy dấu hiệu cảnh báo');
  });

  it('builds a short forwardable share card with defanged links', () => {
    const card = buildShareText('url', 'https://vietcombank-xacthuc.com/', 'critical', 92, [s(70)]);
    expect(card.vi).toContain('RẤT NGUY HIỂM (92/100)');
    expect(card.vi).toContain('hxxps://vietcombank-xacthuc[.]com/');
    expect(card.vi.split('\n').length).toBeLessThanOrEqual(5);
  });
});

describe('VerdictBuilder', () => {
  it('produces a schema-valid verdict; high/critical carry the first-hour guide', () => {
    const b = new VerdictBuilder('text', 'Chuyển tiền gấp');
    b.add(s(80)).source('rules', 'ok').recommend('Đừng chuyển tiền.', 'Do not send money.');
    const v = b.build();
    expect(verdictSchema.parse(v)).toBeTruthy();
    expect(v.level).toBe('critical');
    expect(v.ifAlreadyPaid?.vi.length).toBeGreaterThanOrEqual(4);
    expect(v.ifAlreadyPaid?.vi.join(' ')).toContain('lấy lại tiền');
    expect(v.recommendations.vi[0]).toBe('Đừng chuyển tiền.');
    const low = new VerdictBuilder('text', 'Chào em').build();
    expect(low.ifAlreadyPaid).toBeUndefined();
  });

  it('respects maxScore', () => {
    const b = new VerdictBuilder('ai_text', 'x').add(s(95));
    expect(b.build({ maxScore: 60, maxLevel: 'medium' })).toMatchObject({ score: 60, level: 'medium' });
  });
});
