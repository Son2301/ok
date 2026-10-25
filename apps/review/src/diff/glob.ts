/**
 * Small gitignore-flavoured glob matcher (no dependency):
 *  - `*` matches within one path segment, `?` one character, `[abc]` a class
 *  - `**` matches across segments (`a/**` everything under a, `** /x` x at any depth)
 *  - `{a,b}` alternatives
 *  - a pattern without `/` matches the basename at any depth (`*.lock`)
 *  - a trailing `/` means "this directory and everything under it"
 *  - a leading `/` anchors the pattern at the repo root
 */
const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;

  let p = pattern.trim();
  let anchored = false;
  if (p.startsWith('/')) {
    anchored = true;
    p = p.slice(1);
  }
  if (p.endsWith('/')) p += '**';
  // No slash at all → match the basename anywhere.
  if (!anchored && !p.includes('/')) p = `**/${p}`;

  let re = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === '*') {
      if (p[i + 1] === '*') {
        const prevSlash = i === 0 || p[i - 1] === '/';
        const nextSlash = p[i + 2] === '/' || i + 2 === p.length;
        if (prevSlash && nextSlash) {
          if (p[i + 2] === '/') {
            re += '(?:.*/)?'; // `**/` → zero or more directories
            i += 2;
          } else {
            re += '.*'; // trailing `**`
            i += 1;
          }
          continue;
        }
        re += '[^/]*';
        i += 1;
        continue;
      }
      re += '[^/]*';
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '[') {
      const close = p.indexOf(']', i + 1);
      if (close === -1) {
        re += '\\[';
      } else {
        let cls = p.slice(i + 1, close).replace(/\\/g, '\\\\');
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
        re += `[${cls}]`;
        i = close;
      }
    } else if (ch === '{') {
      const close = p.indexOf('}', i + 1);
      if (close === -1) {
        re += '\\{';
      } else {
        const alts = p
          .slice(i + 1, close)
          .split(',')
          .map((a) =>
            a
              .replace(/[.+^$()|\\]/g, '\\$&')
              .replace(/\*/g, '[^/]*')
              .replace(/\?/g, '[^/]'),
          );
        re += `(?:${alts.join('|')})`;
        i = close;
      }
    } else if ('.+^$()|\\'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  const out = new RegExp(`^${re}$`);
  if (cache.size > 1000) cache.clear();
  cache.set(pattern, out);
  return out;
}

export function matchGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path.replace(/^\.\//, ''));
}

export function matchAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchGlob(path, p));
}
