import { inflateSync } from 'node:zlib';
import { C2PA_UUID_ISOBMFF, jumbfFromApp11 } from './c2pa';

/**
 * Bounded parsers for the metadata parts of common media containers. Untrusted input: every
 * offset is bounds-checked and loops are capped. We never decode pixels or audio samples.
 */

export type MediaKind = 'image' | 'video' | 'audio';

export interface ExifData {
  make?: string;
  model?: string;
  software?: string;
  dateTime?: string;
  dateTimeOriginal?: string;
  artist?: string;
  imageDescription?: string;
  userComment?: string;
  lensModel?: string;
  copyright?: string;
  hasGps?: boolean;
  hasMakerNote?: boolean;
  pixelWidth?: number;
  pixelHeight?: number;
}

export interface RawMetadata {
  format: string;
  mime: string;
  kind: MediaKind;
  width?: number;
  height?: number;
  exif?: ExifData;
  xmp?: string;
  iptc: Record<string, string>;
  /** PNG tEXt/iTXt/zTXt, RIFF INFO, ID3 frames, JPEG COM… keyword → value. */
  text: Record<string, string>;
  jumbf?: Uint8Array;
  brands?: string[];
}

const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1');
const utf8 = (b: Uint8Array) => new TextDecoder('utf-8', { fatal: false }).decode(b);
const strictUtf8 = (b: Uint8Array): string | null => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return null;
  }
};
const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u32be = (b: Uint8Array, o: number) =>
  ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
const u32le = (b: Uint8Array, o: number) =>
  b[o]! + (b[o + 1]! << 8) + (b[o + 2]! << 16) + ((b[o + 3]! << 24) >>> 0);
const ascii4 = (b: Uint8Array, o: number) =>
  o + 4 <= b.length ? String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!) : '';
const clip = (s: string, n = 2000) => (s.length > n ? `${s.slice(0, n)}…` : s);

function startsWith(b: Uint8Array, sig: number[] | string, at = 0): boolean {
  const arr = typeof sig === 'string' ? Array.from(sig, (c) => c.charCodeAt(0)) : sig;
  if (at + arr.length > b.length) return false;
  return arr.every((v, i) => b[at + i] === v);
}

/** Identify the container from magic bytes. */
export function sniff(b: Uint8Array): { format: string; mime: string; kind: MediaKind } | null {
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { format: 'jpeg', mime: 'image/jpeg', kind: 'image' };
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { format: 'png', mime: 'image/png', kind: 'image' };
  if (startsWith(b, 'GIF8')) return { format: 'gif', mime: 'image/gif', kind: 'image' };
  if (startsWith(b, 'RIFF') && startsWith(b, 'WEBP', 8))
    return { format: 'webp', mime: 'image/webp', kind: 'image' };
  if (startsWith(b, 'RIFF') && startsWith(b, 'WAVE', 8))
    return { format: 'wav', mime: 'audio/wav', kind: 'audio' };
  if (startsWith(b, 'RIFF') && startsWith(b, 'AVI ', 8))
    return { format: 'avi', mime: 'video/x-msvideo', kind: 'video' };
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return { format: 'webm', mime: 'video/webm', kind: 'video' };
  if (startsWith(b, 'ID3') || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0))
    return { format: 'mp3', mime: 'audio/mpeg', kind: 'audio' };
  if (startsWith(b, 'OggS')) return { format: 'ogg', mime: 'audio/ogg', kind: 'audio' };
  if (startsWith(b, 'fLaC')) return { format: 'flac', mime: 'audio/flac', kind: 'audio' };
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]))
    return { format: 'tiff', mime: 'image/tiff', kind: 'image' };
  if (startsWith(b, 'ftyp', 4)) {
    const brand = ascii4(b, 8);
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand))
      return { format: 'heic', mime: 'image/heic', kind: 'image' };
    if (/^(avif|avis)$/.test(brand)) return { format: 'avif', mime: 'image/avif', kind: 'image' };
    if (/^(M4A |M4B |M4P )$/.test(brand)) return { format: 'm4a', mime: 'audio/mp4', kind: 'audio' };
    if (brand === 'qt  ') return { format: 'mov', mime: 'video/quicktime', kind: 'video' };
    return { format: 'mp4', mime: 'video/mp4', kind: 'video' };
  }
  return null;
}

// ------------------------------------------------------------------ TIFF / EXIF

const TYPE_SIZE: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
};

export function parseTiff(t: Uint8Array): ExifData | undefined {
  if (t.length < 8) return undefined;
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return undefined;
  const r16 = (o: number) => (o + 2 <= t.length ? (le ? t[o]! | (t[o + 1]! << 8) : u16be(t, o)) : 0);
  const r32 = (o: number) => (o + 4 <= t.length ? (le ? u32le(t, o) : u32be(t, o)) : 0);
  if (r16(2) !== 42) return undefined;
  const out: ExifData = {};
  const visited = new Set<number>();

  const readIfd = (off: number, tags: (tag: number, type: number, count: number, valOff: number) => void) => {
    if (off <= 0 || off + 2 > t.length || visited.has(off) || visited.size > 8) return;
    visited.add(off);
    const n = Math.min(r16(off), 500);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > t.length) break;
      const tag = r16(e);
      const type = r16(e + 2);
      const count = r32(e + 4);
      const size = (TYPE_SIZE[type] ?? 1) * count;
      const valOff = size <= 4 ? e + 8 : r32(e + 8);
      tags(tag, type, count, valOff);
    }
  };
  const str = (type: number, count: number, o: number) => {
    if (o < 0 || o >= t.length) return undefined;
    const raw = t.subarray(o, Math.min(t.length, o + Math.min(count, 4096)));
    // EXIF "ASCII" is often UTF-8 in practice ("DALL·E", Vietnamese names); fall back to Latin-1.
    const s = (type === 2 ? (strictUtf8(raw) ?? latin1(raw)) : utf8(raw))
      .replace(/\0+$/g, '')
      .replace(/\0/g, ' ')
      .trim();
    return s ? clip(s, 500) : undefined;
  };
  const num = (type: number, o: number) => (type === 3 ? r16(o) : r32(o));

  let exifIfd = 0;
  readIfd(r32(4), (tag, type, count, o) => {
    switch (tag) {
      case 0x010e:
        out.imageDescription = str(type, count, o);
        break;
      case 0x010f:
        out.make = str(type, count, o);
        break;
      case 0x0110:
        out.model = str(type, count, o);
        break;
      case 0x0131:
        out.software = str(type, count, o);
        break;
      case 0x0132:
        out.dateTime = str(type, count, o);
        break;
      case 0x013b:
        out.artist = str(type, count, o);
        break;
      case 0x8298:
        out.copyright = str(type, count, o);
        break;
      case 0x8769:
        exifIfd = num(type, o);
        break;
      case 0x8825:
        out.hasGps = true;
        break;
    }
  });
  readIfd(exifIfd, (tag, type, count, o) => {
    switch (tag) {
      case 0x9003:
        out.dateTimeOriginal = str(type, count, o);
        break;
      case 0x9286: {
        // 8-byte charset prefix ("ASCII\0\0\0", "UNICODE\0")
        const s = str(7, Math.max(0, count - 8), o + 8);
        if (s) out.userComment = s;
        break;
      }
      case 0xa434:
        out.lensModel = str(type, count, o);
        break;
      case 0x927c:
        out.hasMakerNote = true;
        break;
      case 0xa002:
        out.pixelWidth = num(type, o);
        break;
      case 0xa003:
        out.pixelHeight = num(type, o);
        break;
    }
  });
  return Object.keys(out).length ? out : undefined;
}

// ------------------------------------------------------------------ IPTC-IIM

const IPTC_FIELDS: Record<number, string> = {
  5: 'objectName',
  25: 'keywords',
  65: 'originatingProgram',
  70: 'programVersion',
  80: 'byline',
  105: 'headline',
  110: 'credit',
  115: 'source',
  116: 'copyright',
  120: 'caption',
};

function parseIptcIim(b: Uint8Array, out: Record<string, string>) {
  for (let o = 0; o + 5 <= b.length; ) {
    if (b[o] !== 0x1c) break;
    const record = b[o + 1]!;
    const dataset = b[o + 2]!;
    const len = u16be(b, o + 3);
    if (len & 0x8000) break; // extended length: not used for text fields
    const val = b.subarray(o + 5, Math.min(b.length, o + 5 + len));
    const field = record === 2 ? IPTC_FIELDS[dataset] : undefined;
    if (field) out[field] = out[field] ? `${out[field]}; ${utf8(val)}` : clip(utf8(val), 500);
    o += 5 + len;
  }
}

/** Photoshop APP13 "8BIM" resources → IPTC (resource 0x0404). */
function parsePhotoshopIrb(b: Uint8Array, out: Record<string, string>) {
  let o = 0;
  for (let guard = 0; guard < 500 && o + 12 <= b.length; guard++) {
    if (!startsWith(b, '8BIM', o)) break;
    const id = u16be(b, o + 4);
    const nameLen = b[o + 6]!;
    let p = o + 7 + nameLen;
    if ((nameLen + 1) % 2) p++;
    if (p + 4 > b.length) break;
    const size = u32be(b, p);
    const data = b.subarray(p + 4, Math.min(b.length, p + 4 + size));
    if (id === 0x0404) parseIptcIim(data, out);
    o = p + 4 + size + (size % 2);
  }
}

// ------------------------------------------------------------------ JPEG

function parseJpeg(b: Uint8Array, meta: RawMetadata) {
  const app11: Uint8Array[] = [];
  const xmpParts: string[] = [];
  let o = 2;
  for (let guard = 0; guard < 2000 && o + 4 <= b.length; guard++) {
    if (b[o] !== 0xff) break;
    let marker = b[o + 1]!;
    while (marker === 0xff && o + 2 < b.length) {
      o++;
      marker = b[o + 1]!;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / start of scan: no more metadata
    const len = u16be(b, o + 2);
    if (len < 2 || o + 2 + len > b.length) break;
    const seg = b.subarray(o + 4, o + 2 + len);
    if (marker === 0xe1 && startsWith(seg, 'Exif\0\0')) meta.exif = parseTiff(seg.subarray(6)) ?? meta.exif;
    else if (marker === 0xe1 && startsWith(seg, 'http://ns.adobe.com/xap/1.0/\0'))
      xmpParts.push(utf8(seg.subarray(29)));
    else if (marker === 0xe1 && startsWith(seg, 'http://ns.adobe.com/xmp/extension/\0'))
      xmpParts.push(utf8(seg.subarray(35 + 40)));
    else if (marker === 0xed && startsWith(seg, 'Photoshop 3.0\0'))
      parsePhotoshopIrb(seg.subarray(14), meta.iptc);
    else if (marker === 0xeb) app11.push(seg);
    else if (marker === 0xfe) meta.text.comment = clip(utf8(seg), 1000);
    else if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc &&
      seg.length >= 5
    ) {
      meta.height = u16be(seg, 1);
      meta.width = u16be(seg, 3);
    }
    o += 2 + len;
  }
  if (xmpParts.length) meta.xmp = xmpParts.join('\n');
  const jumbf = jumbfFromApp11(app11);
  if (jumbf) meta.jumbf = jumbf;
}

// ------------------------------------------------------------------ PNG

function parsePng(b: Uint8Array, meta: RawMetadata) {
  let o = 8;
  for (let guard = 0; guard < 5000 && o + 12 <= b.length; guard++) {
    const len = u32be(b, o);
    const type = ascii4(b, o + 4);
    if (o + 12 + len > b.length) break;
    const data = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR' && len >= 8) {
      meta.width = u32be(data, 0);
      meta.height = u32be(data, 4);
    } else if (type === 'tEXt') {
      const z = data.indexOf(0);
      if (z > 0) addText(meta, latin1(data.subarray(0, z)), latin1(data.subarray(z + 1)));
    } else if (type === 'zTXt') {
      const z = data.indexOf(0);
      if (z > 0) {
        const v = inflateBounded(data.subarray(z + 2));
        if (v) addText(meta, latin1(data.subarray(0, z)), latin1(v));
      }
    } else if (type === 'iTXt') {
      const z = data.indexOf(0);
      if (z > 0 && z + 3 < data.length) {
        const key = latin1(data.subarray(0, z));
        const compressed = data[z + 1] === 1;
        const langEnd = data.indexOf(0, z + 3);
        const transEnd = langEnd >= 0 ? data.indexOf(0, langEnd + 1) : -1;
        if (transEnd >= 0) {
          const raw = data.subarray(transEnd + 1);
          const v = compressed ? inflateBounded(raw) : raw;
          if (v) {
            if (key === 'XML:com.adobe.xmp') meta.xmp = utf8(v);
            else addText(meta, key, utf8(v));
          }
        }
      }
    } else if (type === 'eXIf') {
      meta.exif = parseTiff(data) ?? meta.exif;
    } else if (type === 'caBX') {
      meta.jumbf = data;
    } else if (type === 'IEND') {
      break;
    }
    o += 12 + len;
  }
}

function addText(meta: RawMetadata, key: string, value: string) {
  meta.text[key.slice(0, 80)] = clip(value, 4000);
}

function inflateBounded(data: Uint8Array): Uint8Array | null {
  try {
    return inflateSync(data, { maxOutputLength: 1024 * 1024 });
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ RIFF (WebP, WAV, AVI)

function parseRiff(b: Uint8Array, meta: RawMetadata) {
  let o = 12;
  for (let guard = 0; guard < 2000 && o + 8 <= b.length; guard++) {
    const id = ascii4(b, o);
    const size = u32le(b, o + 4);
    if (o + 8 + size > b.length) break;
    const data = b.subarray(o + 8, o + 8 + size);
    if (id === 'VP8X' && size >= 10) {
      meta.width = 1 + (data[4]! | (data[5]! << 8) | (data[6]! << 16));
      meta.height = 1 + (data[7]! | (data[8]! << 8) | (data[9]! << 16));
    } else if (id === 'VP8 ' && size >= 10 && meta.width === undefined) {
      meta.width = (data[6]! | (data[7]! << 8)) & 0x3fff;
      meta.height = (data[8]! | (data[9]! << 8)) & 0x3fff;
    } else if (id === 'VP8L' && size >= 5 && meta.width === undefined) {
      const bits = data[1]! | (data[2]! << 8) | (data[3]! << 16) | (data[4]! << 24);
      meta.width = (bits & 0x3fff) + 1;
      meta.height = ((bits >> 14) & 0x3fff) + 1;
    } else if (id === 'EXIF') {
      meta.exif = parseTiff(startsWith(data, 'Exif\0\0') ? data.subarray(6) : data) ?? meta.exif;
    } else if (id === 'XMP ') {
      meta.xmp = utf8(data);
    } else if (id === 'C2PA') {
      meta.jumbf = data;
    } else if (id === 'LIST' && startsWith(data, 'INFO')) {
      let p = 4;
      for (let g = 0; g < 200 && p + 8 <= data.length; g++) {
        const sid = ascii4(data, p);
        const ssize = u32le(data, p + 4);
        const sval = data.subarray(p + 8, Math.min(data.length, p + 8 + ssize));
        addText(meta, `INFO.${sid}`, utf8(sval).replace(/\0+$/, ''));
        p += 8 + ssize + (ssize % 2);
      }
    } else if (id === 'id3 ' || id === 'ID3 ') {
      parseId3(data, meta);
    }
    o += 8 + size + (size % 2);
  }
}

// ------------------------------------------------------------------ ISO BMFF (MP4, MOV, HEIC, AVIF, M4A)

const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac';
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function parseIsoBmff(b: Uint8Array, meta: RawMetadata) {
  const visit = (start: number, end: number, depth: number) => {
    let o = start;
    for (let guard = 0; guard < 5000 && o + 8 <= end; guard++) {
      let size = u32be(b, o);
      const type = ascii4(b, o + 4);
      let header = 8;
      if (size === 1 && o + 16 <= end) {
        size = Number((BigInt(u32be(b, o + 8)) << 32n) + BigInt(u32be(b, o + 12)));
        header = 16;
      } else if (size === 0) size = end - o;
      if (size < header || o + size > end) break;
      const payload = b.subarray(o + header, o + size);
      if (type === 'ftyp' && payload.length >= 8) {
        const brands = [ascii4(payload, 0)];
        for (let p = 8; p + 4 <= payload.length && brands.length < 20; p += 4)
          brands.push(ascii4(payload, p));
        meta.brands = brands.map((x) => x.trim());
      } else if (type === 'uuid' && payload.length >= 16) {
        const id = hex(payload.subarray(0, 16));
        if (id === C2PA_UUID_ISOBMFF) {
          // FullBox header + purpose string + optional offset precede the JUMBF; locate the first 'jumb' box.
          const body = payload.subarray(16);
          const at = indexOfAscii(body, 'jumb');
          if (at >= 4) meta.jumbf = body.subarray(at - 4);
        } else if (id === XMP_UUID) {
          meta.xmp = utf8(payload.subarray(16));
        }
      } else if (
        depth < 6 &&
        ['moov', 'udta', 'meta', 'ilst', 'trak', 'mdia', 'minf', 'stbl'].includes(type)
      ) {
        // `meta` is a FullBox (4 extra bytes) in MP4/HEIC but not in QuickTime.
        const inner =
          type === 'meta' && payload.length >= 4 && u32be(payload, 0) < 8 ? o + header + 4 : o + header;
        visit(inner, o + size, depth + 1);
      } else if (depth >= 1 && (type.charCodeAt(0) === 0xa9 || type === 'tool' || type === 'swr ')) {
        // QuickTime/iTunes text atoms (©too encoder, ©swr software, ©cmt comment)
        const at = indexOfAscii(payload, 'data');
        const val = at >= 4 ? payload.subarray(at + 12) : payload.subarray(4);
        const key = type.charCodeAt(0) === 0xa9 ? `©${type.slice(1)}` : type;
        addText(meta, key, utf8(val).replace(/\0/g, '').trim());
      } else if (type === 'ispe' && payload.length >= 12 && meta.width === undefined) {
        meta.width = u32be(payload, 4);
        meta.height = u32be(payload, 8);
      } else if (type === 'tkhd' && payload.length >= 84 && meta.width === undefined) {
        const w = u32be(payload, payload.length - 8) >>> 16;
        const h = u32be(payload, payload.length - 4) >>> 16;
        if (w && h) {
          meta.width = w;
          meta.height = h;
        }
      }
      o += size;
    }
  };
  visit(0, b.length, 0);
}

function indexOfAscii(b: Uint8Array, s: string, from = 0): number {
  const first = s.charCodeAt(0);
  for (let i = from; i + s.length <= b.length; i++) {
    if (b[i] !== first) continue;
    let ok = true;
    for (let j = 1; j < s.length; j++) {
      if (b[i + j] !== s.charCodeAt(j)) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

// ------------------------------------------------------------------ ID3 (MP3)

function decodeId3Text(data: Uint8Array): string {
  const enc = data[0];
  const body = data.subarray(1);
  let s: string;
  if (enc === 1 || enc === 2) {
    const le = enc === 1 ? !(body[0] === 0xfe && body[1] === 0xff) : false;
    const start = enc === 1 && (body[0] === 0xff || body[0] === 0xfe) ? 2 : 0;
    s = new TextDecoder(le ? 'utf-16le' : 'utf-16be', { fatal: false }).decode(body.subarray(start));
  } else if (enc === 3) s = utf8(body);
  else s = latin1(body);
  return s.replace(/\0+$/g, '').replace(/\0/g, ' | ').trim();
}

export function parseId3(b: Uint8Array, meta: RawMetadata) {
  if (!startsWith(b, 'ID3') || b.length < 10) return;
  const ver = b[3]!;
  const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
  const end = Math.min(b.length, 10 + size);
  let o = 10;
  for (let guard = 0; guard < 500 && o + 10 <= end; guard++) {
    const id = ascii4(b, o);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fsize =
      ver >= 4
        ? ((b[o + 4]! & 0x7f) << 21) |
          ((b[o + 5]! & 0x7f) << 14) |
          ((b[o + 6]! & 0x7f) << 7) |
          (b[o + 7]! & 0x7f)
        : u32be(b, o + 4);
    if (fsize <= 0 || o + 10 + fsize > end) break;
    const data = b.subarray(o + 10, o + 10 + fsize);
    if (id.startsWith('T') || id === 'COMM')
      addText(
        meta,
        `ID3.${id}`,
        decodeId3Text(id === 'COMM' ? Uint8Array.of(data[0]!, ...data.subarray(4)) : data),
      );
    o += 10 + fsize;
  }
}

// ------------------------------------------------------------------ generic fallbacks

/** Find an embedded "Exif\0\0" TIFF block or XMP packet anywhere in the first/last few MB. */
function genericScan(b: Uint8Array, meta: RawMetadata) {
  const windowed =
    b.length > 6 * 1024 * 1024
      ? [b.subarray(0, 4 * 1024 * 1024), b.subarray(b.length - 2 * 1024 * 1024)]
      : [b];
  for (const w of windowed) {
    if (!meta.exif) {
      const at = indexOfAscii(w, 'Exif\0\0');
      if (at >= 0) meta.exif = parseTiff(w.subarray(at + 6));
    }
    if (!meta.xmp) {
      const s = latin1(w);
      const a = s.indexOf('<x:xmpmeta');
      const e = a >= 0 ? s.indexOf('</x:xmpmeta>', a) : -1;
      if (a >= 0 && e > a) meta.xmp = Buffer.from(s.slice(a, e + 12), 'latin1').toString('utf8');
    }
  }
}

export function parseContainer(b: Uint8Array): RawMetadata | null {
  const id = sniff(b);
  if (!id) return null;
  const meta: RawMetadata = { ...id, iptc: {}, text: {} };
  try {
    if (id.format === 'jpeg') parseJpeg(b, meta);
    else if (id.format === 'png') parsePng(b, meta);
    else if (id.format === 'webp' || id.format === 'wav' || id.format === 'avi') parseRiff(b, meta);
    else if (['heic', 'avif', 'm4a', 'mov', 'mp4'].includes(id.format)) parseIsoBmff(b, meta);
    else if (id.format === 'mp3') parseId3(b, meta);
    else if (id.format === 'tiff') meta.exif = parseTiff(b);
    else if (id.format === 'gif' && b.length >= 10) {
      meta.width = b[6]! | (b[7]! << 8);
      meta.height = b[8]! | (b[9]! << 8);
    }
  } catch {
    // keep whatever was parsed before the malformed part
  }
  genericScan(b, meta);
  if (meta.exif?.pixelWidth && !meta.width) {
    meta.width = meta.exif.pixelWidth;
    meta.height = meta.exif.pixelHeight;
  }
  return meta;
}
