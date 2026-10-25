import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Random base36 string of `len` characters. */
export function randomId(len = 20): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

/** Prefixed, sortable-enough identifier, e.g. `agt_k3j...`. */
export function newId(prefix: string, len = 20): string {
  return `${prefix}_${randomId(len)}`;
}
