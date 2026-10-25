import zlib from 'node:zlib';
import { type CborValue, encodeCbor } from '../media/cbor';

/** Builders for tiny, valid-enough media files used by forensic tests (generated in memory). */

const enc = new TextEncoder();
export const bytes = (...parts: (Uint8Array | number[] | string)[]): Uint8Array => {
  const arrs = parts.map((p) =>
    typeof p === 'string' ? enc.encode(p) : p instanceof Uint8Array ? p : Uint8Array.from(p),
  );
  const out = new Uint8Array(arrs.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const u32le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

// ------------------------------------------------------------------ TIFF / EXIF (big endian)

export function buildTiff(ifd0: Record<number, string>, exif: Record<number, string> = {}): Uint8Array {
  const ifd0Tags = Object.entries(ifd0).map(([t, v]) => [Number(t), v] as const);
  const exifTags = Object.entries(exif).map(([t, v]) => [Number(t), v] as const);
  const hasExif = exifTags.length > 0;
  const n0 = ifd0Tags.length + (hasExif ? 1 : 0);
  const ifd0Size = 2 + 12 * n0 + 4;
  const exifOffset = 8 + ifd0Size;
  const exifSize = hasExif ? 2 + 12 * exifTags.length + 4 : 0;
  const dataOffset = exifOffset + exifSize;
  const data: number[] = [];
  const entry = (tag: number, value: string) => {
    const s = [...enc.encode(value), 0];
    if (s.length <= 4)
      return [...u16(tag), ...u16(2), ...u32(s.length), ...s, ...new Array(4 - s.length).fill(0)];
    const off = dataOffset + data.length;
    data.push(...s);
    if (data.length % 2) data.push(0);
    return [...u16(tag), ...u16(2), ...u32(s.length), ...u32(off)];
  };
  const ifd0Bytes: number[] = [...u16(n0)];
  for (const [t, v] of ifd0Tags.sort((a, b) => a[0] - b[0])) ifd0Bytes.push(...entry(t, v));
  if (hasExif) ifd0Bytes.push(...u16(0x8769), ...u16(4), ...u32(1), ...u32(exifOffset));
  ifd0Bytes.push(...u32(0));
  const exifBytes: number[] = [];
  if (hasExif) {
    exifBytes.push(...u16(exifTags.length));
    for (const [t, v] of exifTags) exifBytes.push(...entry(t, v));
    exifBytes.push(...u32(0));
  }
  return bytes('MM', [0, 42], u32(8), ifd0Bytes, exifBytes, data);
}

export const TAG = { make: 0x010f, model: 0x0110, software: 0x0131, dateTimeOriginal: 0x9003 } as const;

// ------------------------------------------------------------------ JUMBF / C2PA

export function isoBox(type: string, payload: Uint8Array): Uint8Array {
  return bytes(u32(payload.length + 8), type, payload);
}

const C2PA_TYPE_UUID = [
  0x63, 0x32, 0x70, 0x61, 0x00, 0x11, 0x00, 0x10, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];

export function superbox(label: string, children: Uint8Array[]): Uint8Array {
  const jumd = isoBox('jumd', bytes(C2PA_TYPE_UUID, [0x03], label, [0]));
  return isoBox('jumb', bytes(jumd, ...children));
}

/** A DER-ish blob carrying an organizationName, like an X.509 subject (enough for our hint scanner). */
export function fakeCert(org: string): Uint8Array {
  const o = enc.encode(org);
  return bytes([0x30, 0x10, 0x06, 0x03, 0x55, 0x04, 0x0a, 0x0c, o.length], o, [0x00, 0x01]);
}

export function c2paStore(opts: {
  claimGenerator?: string;
  claimGeneratorInfo?: { name: string; version?: string }[];
  actions?: { action: string; digitalSourceType?: string; softwareAgent?: string }[];
  signerOrg?: string;
}): Uint8Array {
  const claim: Record<string, CborValue> = { 'dc:format': 'image/jpeg', instanceID: 'xmp:iid:1234' };
  if (opts.claimGenerator) claim.claim_generator = opts.claimGenerator;
  if (opts.claimGeneratorInfo) claim.claim_generator_info = opts.claimGeneratorInfo as unknown as CborValue;
  const children = [
    superbox('c2pa.assertions', [
      superbox('c2pa.actions', [
        isoBox('cbor', encodeCbor({ actions: (opts.actions ?? []) as unknown as CborValue })),
      ]),
    ]),
    superbox('c2pa.claim', [isoBox('cbor', encodeCbor(claim))]),
    superbox('c2pa.signature', [
      isoBox('cbor', opts.signerOrg ? fakeCert(opts.signerOrg) : new Uint8Array([0xa0])),
    ]),
  ];
  return superbox('c2pa', [superbox('urn:uuid:5ad0c3a2-0000-4000-8000-000000000001', children)]);
}

// ------------------------------------------------------------------ JPEG

export function buildJpeg(
  o: {
    tiff?: Uint8Array;
    xmp?: string;
    jumbf?: Uint8Array;
    iptc?: Record<number, string>;
    width?: number;
    height?: number;
    comment?: string;
  } = {},
): Uint8Array {
  const seg = (marker: number, payload: Uint8Array) =>
    bytes([0xff, marker], u16(payload.length + 2), payload);
  const parts: Uint8Array[] = [Uint8Array.from([0xff, 0xd8])];
  parts.push(seg(0xe0, bytes('JFIF', [0, 1, 1, 0, 0, 1, 0, 1, 0, 0])));
  if (o.tiff) parts.push(seg(0xe1, bytes('Exif', [0, 0], o.tiff)));
  if (o.xmp) parts.push(seg(0xe1, bytes('http://ns.adobe.com/xap/1.0/', [0], o.xmp)));
  if (o.iptc) {
    const iim = bytes(
      ...Object.entries(o.iptc).map(([ds, v]) => bytes([0x1c, 2, Number(ds)], u16(enc.encode(v).length), v)),
    );
    const res = bytes('8BIM', u16(0x0404), [0, 0], u32(iim.length), iim, iim.length % 2 ? [0] : []);
    parts.push(seg(0xed, bytes('Photoshop 3.0', [0], res)));
  }
  if (o.jumbf) parts.push(seg(0xeb, bytes('JP', u16(1), u32(1), o.jumbf)));
  if (o.comment) parts.push(seg(0xfe, bytes(o.comment)));
  parts.push(
    seg(
      0xc0,
      bytes([8], u16(o.height ?? 1080), u16(o.width ?? 1440), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    ),
  );
  parts.push(seg(0xda, bytes([1, 1, 0, 0, 0x3f, 0])), Uint8Array.from([0x12, 0x34, 0xff, 0xd9]));
  return bytes(...parts);
}

// ------------------------------------------------------------------ PNG

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const td = bytes(type, data);
  const crc = typeof zlib.crc32 === 'function' ? zlib.crc32(td) >>> 0 : 0;
  return bytes(u32(data.length), td, u32(crc));
}

export function buildPng(
  o: {
    width?: number;
    height?: number;
    text?: Record<string, string>;
    xmp?: string;
    jumbf?: Uint8Array;
    ztxt?: Record<string, string>;
  } = {},
): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  parts.push(pngChunk('IHDR', bytes(u32(o.width ?? 800), u32(o.height ?? 600), [8, 6, 0, 0, 0])));
  for (const [k, v] of Object.entries(o.text ?? {})) parts.push(pngChunk('tEXt', bytes(k, [0], v)));
  for (const [k, v] of Object.entries(o.ztxt ?? {}))
    parts.push(pngChunk('zTXt', bytes(k, [0, 0], zlib.deflateSync(Buffer.from(v)))));
  if (o.xmp) parts.push(pngChunk('iTXt', bytes('XML:com.adobe.xmp', [0, 0, 0, 0, 0], o.xmp)));
  if (o.jumbf) parts.push(pngChunk('caBX', o.jumbf));
  parts.push(pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(16))));
  parts.push(pngChunk('IEND', new Uint8Array()));
  return bytes(...parts);
}

// ------------------------------------------------------------------ WebP / MP4 / MP3

export function buildWebp(o: {
  width: number;
  height: number;
  xmp?: string;
  jumbf?: Uint8Array;
}): Uint8Array {
  const chunk = (id: string, data: Uint8Array) =>
    bytes(id, u32le(data.length), data, data.length % 2 ? [0] : []);
  const w = o.width - 1;
  const h = o.height - 1;
  const vp8x = chunk(
    'VP8X',
    Uint8Array.from([
      0x04,
      0,
      0,
      0,
      w & 0xff,
      (w >> 8) & 0xff,
      (w >> 16) & 0xff,
      h & 0xff,
      (h >> 8) & 0xff,
      (h >> 16) & 0xff,
    ]),
  );
  const body = bytes(
    'WEBP',
    vp8x,
    o.xmp ? chunk('XMP ', enc.encode(o.xmp)) : [],
    o.jumbf ? chunk('C2PA', o.jumbf) : [],
  );
  return bytes('RIFF', u32le(body.length), body);
}

export function buildMp4(o: { jumbf?: Uint8Array; encoder?: string }): Uint8Array {
  const ftyp = isoBox('ftyp', bytes('isom', u32(512), 'isomiso2avc1mp41'));
  const parts: Uint8Array[] = [ftyp];
  if (o.jumbf) {
    const uuid = [
      0xd8, 0xfe, 0xc3, 0xd6, 0x1b, 0x0e, 0x48, 0x3c, 0x92, 0x97, 0x58, 0x28, 0x87, 0x7e, 0xc4, 0x81,
    ];
    parts.push(isoBox('uuid', bytes(uuid, [0, 0, 0, 0], 'manifest', [0], new Array(8).fill(0), o.jumbf)));
  }
  if (o.encoder) {
    const data = isoBox('data', bytes(u32(1), u32(0), o.encoder));
    const too = bytes(u32(data.length + 8), [0xa9], 'too', data);
    parts.push(isoBox('moov', isoBox('udta', too)));
  }
  parts.push(isoBox('mdat', new Uint8Array(32)));
  return bytes(...parts);
}

export function buildMp3(frames: Record<string, string>): Uint8Array {
  const fr = Object.entries(frames).map(([id, v]) => {
    const data = bytes([0], v);
    return bytes(id, u32(data.length), [0, 0], data);
  });
  const body = bytes(...fr);
  const size = body.length;
  const syncsafe = [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f];
  return bytes('ID3', [3, 0, 0], syncsafe, body, [0xff, 0xfb, 0x90, 0x00], new Array(64).fill(0));
}
