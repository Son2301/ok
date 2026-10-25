import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, parseConfigText, resolveRepoConfig, validateOverride } from './config';

describe('repo config', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      language: 'en',
      severityThreshold: 'medium',
      maxComments: 15,
      reviewDrafts: false,
      failOn: 'none',
      models: { reviewer: 'auto:best', critic: 'auto' },
      keepPlausible: true,
      paths: { include: [], exclude: [], force: [] },
    });
  });

  it('parses a valid .okreview.yml and fills defaults', () => {
    const { config, error, sources } = resolveRepoConfig(`
language: vi
paths:
  exclude: ["legacy/**"]
severityThreshold: high
maxComments: 5
models:
  reviewer: openai/gpt-5
instructions: |
  We use integer cents for money.
failOn: high
`);
    expect(error).toBeUndefined();
    expect(sources).toEqual(['defaults', 'repo-file']);
    expect(config).toMatchObject({
      language: 'vi',
      severityThreshold: 'high',
      maxComments: 5,
      failOn: 'high',
      models: { reviewer: 'openai/gpt-5', critic: 'auto' },
      paths: { include: [], exclude: ['legacy/**'], force: [] },
    });
    expect(config.instructions).toContain('integer cents');
  });

  it('treats an empty file as defaults', () => {
    expect(resolveRepoConfig('')).toEqual({
      config: DEFAULT_CONFIG,
      error: undefined,
      sources: ['defaults', 'repo-file'],
    });
    expect(resolveRepoConfig(null).config).toEqual(DEFAULT_CONFIG);
  });

  it.each([
    ['language: fr', /language/],
    ['maxComments: lots', /maxComments/],
    ['severityTreshold: high', /Unrecognized key/i],
    ['paths: [a, b]', /paths/],
    ['- just\n- a list', /top level must be a mapping/],
    ['a: [unclosed', /invalid YAML/],
    ['models:\n  reviewer: "rm -rf /"', /models\.reviewer/],
  ])('reports invalid config %j and falls back to defaults', (text, message) => {
    const { config, error } = resolveRepoConfig(text);
    expect(error).toMatch(message);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('rejects alias bombs and oversized files', () => {
    const bomb = `a: &a ["x","x","x","x","x","x","x","x","x"]\n${Array.from({ length: 60 }, (_, i) => `k${i}: *a`).join('\n')}`;
    expect(parseConfigText(bomb).error).toBeDefined();
    expect(parseConfigText(`instructions: "${'x'.repeat(70_000)}"`).error).toMatch(/larger than/);
  });

  it('applies the console override on top of the repo file', () => {
    const { config, sources } = resolveRepoConfig('severityThreshold: high\npaths:\n  include: ["src/**"]', {
      maxComments: 3,
      paths: { exclude: ['src/gen/**'] },
    });
    expect(sources).toEqual(['defaults', 'repo-file', 'console']);
    expect(config.severityThreshold).toBe('high');
    expect(config.maxComments).toBe(3);
    expect(config.paths).toEqual({ include: ['src/**'], exclude: ['src/gen/**'], force: [] });
  });

  it('still applies the console override when the repo file is invalid', () => {
    const { config, error } = resolveRepoConfig('language: klingon', { language: 'vi' });
    expect(error).toMatch(/language/);
    expect(config.language).toBe('vi');
  });

  it('validates console overrides', () => {
    expect(validateOverride({ maxComments: 2 })).toEqual({ maxComments: 2 });
    expect(() => validateOverride({ maxComments: 999 })).toThrow();
    expect(() => validateOverride('nope')).toThrow();
  });
});
