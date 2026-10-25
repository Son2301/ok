/**
 * Minimal, bounded CBOR (RFC 8949) decoder, enough to read C2PA claims and assertions.
 * Untrusted input: depth, item count and lengths are all limited.
 */

export type CborValue =
  | number
  | bigint
  | string
  | boolean
  | null
  | undefined
  | Uint8Array
  | CborValue[]
  | { [k: string]: CborValue }
  | { tag: number; value: CborValue };

const MAX_DEPTH = 32;
const MAX_ITEMS = 100_000;
const BREAK = Symbol('break');

export function decodeCbor(bytes: Uint8Array): CborValue {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  let items = 0;

  const need = (n: number) => {
    if (pos + n > bytes.length) throw new Error('CBOR: unexpected end of data');
  };
  const readLength = (info: number): number | null => {
    if (info < 24) return info;
    if (info === 24) {
      need(1);
      return bytes[pos++]!;
    }
    if (info === 25) {
      need(2);
      const v = view.getUint16(pos);
      pos += 2;
      return v;
    }
    if (info === 26) {
      need(4);
      const v = view.getUint32(pos);
      pos += 4;
      return v;
    }
    if (info === 27) {
      need(8);
      const v = view.getBigUint64(pos);
      pos += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR: length too large');
      return Number(v);
    }
    if (info === 31) return null; // indefinite
    throw new Error('CBOR: invalid additional info');
  };

  const item = (depth: number): CborValue | typeof BREAK => {
    if (depth > MAX_DEPTH) throw new Error('CBOR: nesting too deep');
    if (++items > MAX_ITEMS) throw new Error('CBOR: too many items');
    need(1);
    const ib = bytes[pos++]!;
    const major = ib >> 5;
    const info = ib & 0x1f;
    if (ib === 0xff) return BREAK;
    switch (major) {
      case 0:
        return readLength(info) ?? 0;
      case 1:
        return -1 - (readLength(info) ?? 0);
      case 2:
      case 3: {
        const len = readLength(info);
        let data: Uint8Array;
        if (len === null) {
          const parts: Uint8Array[] = [];
          for (;;) {
            const v = item(depth + 1);
            if (v === BREAK) break;
            parts.push(typeof v === 'string' ? new TextEncoder().encode(v) : (v as Uint8Array));
          }
          data = concat(parts);
        } else {
          need(len);
          data = bytes.subarray(pos, pos + len);
          pos += len;
        }
        return major === 2 ? data : new TextDecoder('utf-8', { fatal: false }).decode(data);
      }
      case 4: {
        const len = readLength(info);
        const arr: CborValue[] = [];
        for (let i = 0; len === null || i < len; i++) {
          const v = item(depth + 1);
          if (v === BREAK) {
            if (len === null) break;
            throw new Error('CBOR: unexpected break');
          }
          arr.push(v);
        }
        return arr;
      }
      case 5: {
        const len = readLength(info);
        const obj: Record<string, CborValue> = {};
        for (let i = 0; len === null || i < len; i++) {
          const k = item(depth + 1);
          if (k === BREAK) {
            if (len === null) break;
            throw new Error('CBOR: unexpected break');
          }
          const v = item(depth + 1);
          if (v === BREAK) throw new Error('CBOR: unexpected break');
          obj[String(k)] = v;
        }
        return obj;
      }
      case 6: {
        const tag = readLength(info) ?? 0;
        const v = item(depth + 1);
        if (v === BREAK) throw new Error('CBOR: unexpected break');
        return { tag, value: v };
      }
      default: {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        if (info === 25) {
          need(2);
          const v = float16(view.getUint16(pos));
          pos += 2;
          return v;
        }
        if (info === 26) {
          need(4);
          const v = view.getFloat32(pos);
          pos += 4;
          return v;
        }
        if (info === 27) {
          need(8);
          const v = view.getFloat64(pos);
          pos += 8;
          return v;
        }
        if (info === 24) {
          need(1);
          return bytes[pos++]!;
        }
        return info;
      }
    }
  };

  const v = item(0);
  if (v === BREAK) throw new Error('CBOR: unexpected break');
  return v;
}

function float16(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? Number.NaN : s * Number.POSITIVE_INFINITY;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Tiny CBOR encoder (maps, arrays, strings, ints, bytes, booleans) — used to build test fixtures. */
export function encodeCbor(v: CborValue): Uint8Array {
  const out: number[] = [];
  const head = (major: number, n: number) => {
    if (n < 24) out.push((major << 5) | n);
    else if (n < 0x100) out.push((major << 5) | 24, n);
    else if (n < 0x10000) out.push((major << 5) | 25, n >> 8, n & 0xff);
    else out.push((major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  };
  const enc = (x: CborValue) => {
    if (x === null) out.push(0xf6);
    else if (x === undefined) out.push(0xf7);
    else if (x === true) out.push(0xf5);
    else if (x === false) out.push(0xf4);
    else if (typeof x === 'number') {
      if (x >= 0) head(0, x);
      else head(1, -1 - x);
    } else if (typeof x === 'string') {
      const b = new TextEncoder().encode(x);
      head(3, b.length);
      out.push(...b);
    } else if (x instanceof Uint8Array) {
      head(2, x.length);
      out.push(...x);
    } else if (Array.isArray(x)) {
      head(4, x.length);
      for (const e of x) enc(e);
    } else if (typeof x === 'object' && 'tag' in x && 'value' in x && typeof x.tag === 'number') {
      head(6, x.tag);
      enc(x.value as CborValue);
    } else if (typeof x === 'object') {
      const entries = Object.entries(x as Record<string, CborValue>);
      head(5, entries.length);
      for (const [k, val] of entries) {
        enc(k);
        enc(val);
      }
    } else {
      throw new Error(`cannot encode ${typeof x}`);
    }
  };
  enc(v);
  return new Uint8Array(out);
}
